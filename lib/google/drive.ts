/**
 * Google Drive through a browser session (see browser.ts), without the Drive API:
 *
 * - Google-native files are exported: Docs → .md (diffable), Sheets → .xlsx, Slides → .pptx
 *   (keeps speaker notes), Drawings → .png. Forms have no export and are skipped.
 * - Docs come from the HTML zip export, not Google's markdown: that one inlines images as
 *   base64 downscaled to 720px and drops floating images. The zip has the originals; the
 *   markdown is made from its HTML, images go next to it numbered in document order, and
 *   a Doc that's only images becomes just its images. All tabs are included (the default
 *   export concatenates them).
 * - Uploaded files come from drive.usercontent.google.com (confirm=t skips the virus-scan
 *   interstitial on big files).
 * - Folders are listed with embeddedfolderview (ids, types, titles, modified dates).
 * - Names come from Content-Disposition, i.e. the file's title in Drive.
 * - Office exports are zips stamped with the export time; entry timestamps are zeroed so
 *   an unchanged file exports to identical bytes and makes no diff.
 */

import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { NodeHtmlMarkdown } from "node-html-markdown";
import type { Google } from "./browser.ts";

export type DriveKind =
	"document" | "spreadsheets" | "presentation" | "drawings" | "forms" | "file" | "folder";
export type DriveRef = { kind: DriveKind; id: string };

/** a Drive/Docs URL → what it points at; null for anything else (incl. published /d/e/ links) */
export const parseDriveUrl = (raw: string): DriveRef | null => {
	let url: URL;
	try {
		url = new URL(raw.replace(/&amp;/g, "&"));
	} catch {
		return null;
	}
	const id = String.raw`([A-Za-z0-9_-]{20,})`;
	if (url.hostname === "docs.google.com") {
		// also /a/<domain>/document/d/… (old Workspace links) and /u/<n>/ account prefixes
		const m = new RegExp(
			String.raw`^/(?:a/[^/]+/)?(document|spreadsheets|presentation|drawings|forms)/(?:u/\d+/)?d/${id}`,
		).exec(url.pathname);
		return m ? { kind: m[1] as DriveKind, id: m[2] } : null;
	}
	if (url.hostname === "drive.google.com") {
		const folder = new RegExp(String.raw`/folders/${id}`).exec(url.pathname);
		if (folder) return { kind: "folder", id: folder[1] };
		const file = new RegExp(String.raw`/file/(?:u/\d+/)?d/${id}`).exec(url.pathname);
		if (file) return { kind: "file", id: file[1] };
		const q = url.searchParams.get("id");
		if (q && url.pathname === "/embeddedfolderview") return { kind: "folder", id: q };
		if (q && /^(\/open|\/uc|\/drive\/?)$/.test(url.pathname)) return { kind: "file", id: q };
	}
	return null;
};

/** Drive links in an HTML body (hrefs and bare URLs), in order of appearance */
export const driveLinksIn = (html: string | undefined): string[] =>
	[...(html ?? "").matchAll(/https?:\/\/(?:docs|drive)\.google\.com\/[^\s"'<>)]+/g)].map((m) =>
		m[0].replace(/[.,;:!?]+$/, ""),
	);

const EXPORTS: Partial<Record<DriveKind, (id: string) => string>> = {
	document: (id) => `https://docs.google.com/document/d/${id}/export?format=zip`,
	spreadsheets: (id) => `https://docs.google.com/spreadsheets/d/${id}/export?format=xlsx`,
	presentation: (id) => `https://docs.google.com/presentation/d/${id}/export/pptx`,
	drawings: (id) => `https://docs.google.com/drawings/d/${id}/export/png`,
	file: (id) => `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`,
};
export const EXT: Partial<Record<DriveKind, string>> = {
	document: ".md",
	spreadsheets: ".xlsx",
	presentation: ".pptx",
	drawings: ".png",
};
/** Google-native kinds change in place, so they're re-exported; uploads are fetched once */
export const isNative = (kind: DriveKind) => kind in EXT;

const filenameOf = (res: Response) => {
	const cd = res.headers.get("content-disposition") ?? "";
	const star = /filename\*=UTF-8''([^;]+)/i.exec(cd)?.[1];
	if (star) return decodeURIComponent(star);
	return /filename="([^"]+)"/i.exec(cd)?.[1];
};

/** zero every zip entry's DOS time/date (local headers + central directory) */
export const normalizeZip = (bytes: Uint8Array): Uint8Array => {
	const buf = Buffer.from(bytes);
	let eocd = -1;
	for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--)
		if (buf.readUInt32LE(i) === 0x06054b50) {
			eocd = i;
			break;
		}
	if (eocd < 0) return bytes;
	const entries = buf.readUInt16LE(eocd + 10);
	let p = buf.readUInt32LE(eocd + 16);
	for (let n = 0; n < entries && p + 46 <= buf.length; n++) {
		if (buf.readUInt32LE(p) !== 0x02014b50) return bytes;
		buf.writeUInt32LE(0x00210000, p + 12); // time 00:00, date 1980-01-01
		const local = buf.readUInt32LE(p + 42);
		if (buf.readUInt32LE(local) === 0x04034b50) buf.writeUInt32LE(0x00210000, local + 10);
		p += 46 + buf.readUInt16LE(p + 28) + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
	}
	return buf;
};

/** a zip's entries as name → bytes (stored or deflated entries; enough for Office files) */
const readZip = (bytes: Uint8Array): Map<string, Buffer> | null => {
	const buf = Buffer.from(bytes);
	let eocd = -1;
	for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--)
		if (buf.readUInt32LE(i) === 0x06054b50) {
			eocd = i;
			break;
		}
	if (eocd < 0) return null;
	const out = new Map<string, Buffer>();
	let p = buf.readUInt32LE(eocd + 16);
	for (let n = buf.readUInt16LE(eocd + 10); n > 0; n--) {
		if (buf.readUInt32LE(p) !== 0x02014b50) return null;
		const method = buf.readUInt16LE(p + 10);
		const size = buf.readUInt32LE(p + 20);
		const nameLen = buf.readUInt16LE(p + 28);
		const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
		const local = buf.readUInt32LE(p + 42);
		const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
		const raw = buf.subarray(start, start + size);
		if (method === 0) out.set(name, raw);
		else if (method === 8) out.set(name, inflateRawSync(raw));
		else return null;
		p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
	}
	return out;
};

/**
 * A fingerprint of an Office file's content that ignores how the export happened to be
 * packed: entry order, timestamps, and the arbitrary numbering of interchangeable parts
 * (Slides numbers a deck's images and themes differently on every export), and GUIDs
 * minted per export (table style ids). The interchangeable parts
 * are named by their content hash, references to them rewritten, and everything is then
 * hashed in name order.
 */
export const officeFingerprint = (bytes: Uint8Array): string | null => {
	const canonical = officeCanonical(bytes);
	if (!canonical) return null;
	const hash = createHash("sha256");
	for (const [name, data] of canonical) hash.update(name).update("\0").update(data);
	return hash.digest("hex");
};

/** the canonical (name-sorted) entries officeFingerprint hashes */
export const officeCanonical = (bytes: Uint8Array): [string, Buffer][] | null => {
	const entries = readZip(bytes);
	if (!entries) return null;
	const sha = (data: Buffer) => `sha-${createHash("sha256").update(data).digest("hex")}`;
	const renamed = new Map<string, string>(); // "media/image3.png" → "media/sha-…"
	const rewrite = (data: Buffer) =>
		Buffer.from(data.toString("utf8").replace(/(media|theme)\/([^"'<>\s/]+)/g, (m) => renamed.get(m) ?? m));
	// media first (leaves), then themes (which can point at media via their _rels)
	for (const kind of ["media", "theme"])
		for (const [name, data] of entries) {
			const m = new RegExp(`(?:^|/)(${kind}/[^/]+)$`).exec(name);
			if (!m) continue;
			const rels = entries.get(name.replace(/([^/]+)$/, "_rels/$1.rels"));
			renamed.set(
				m[1],
				`${kind}/${sha(Buffer.concat([rewrite(data), rels ? rewrite(rels) : Buffer.alloc(0)]))}`,
			);
		}
	const canonical = [...entries].map(([name, data]): [string, Buffer] => {
		const renamedName = name.replace(
			/(media|theme)\/(_rels\/)?([^/]+?)(\.rels)?$/,
			(m, kind, relsDir, file, relsExt) => {
				const to = renamed.get(`${kind}/${file}`);
				return to ? `${to.replace(/^[^/]+\//, `${kind}/${relsDir ?? ""}`)}${relsExt ?? ""}` : m;
			},
		);
		if (!/\.(xml|rels)$/.test(name)) return [renamedName, data];
		let text = rewrite(data).toString("utf8");
		// manifests list parts in whatever order they were numbered: order doesn't matter there
		if (name === "[Content_Types].xml" || name.endsWith(".rels"))
			text = text.replace(/((?:<(?:Default|Override|Relationship)\b[^>]*\/>)+)/g, (run) =>
				(run.match(/<[^>]+\/>/g) ?? []).sort().join(""),
			);
		return [renamedName, Buffer.from(text)];
	});
	canonical.sort(([a], [b]) => (a < b ? -1 : 1));
	// GUIDs (e.g. table style ids) are minted fresh every export: number them by first use
	const guids = new Map<string, string>();
	return canonical.map(([name, data]): [string, Buffer] =>
		/\.(xml|rels)$/.test(name) || name === "[Content_Types].xml"
			? [
					name,
					Buffer.from(
						data
							.toString("utf8")
							.replace(/\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}/gi, (g) => {
								const k = g.toUpperCase();
								if (!guids.has(k)) guids.set(k, `{guid-${guids.size}}`);
								return guids.get(k)!;
							}),
					),
				]
			: [name, data],
	);
};

/**
 * Drive links inside an exported file: a Doc's markdown, or the XML parts of an Office
 * file (slide text, speaker notes, cells, and the external hyperlink targets in *.rels).
 * PDFs and other uploads aren't looked into.
 */
export const linksInExport = (name: string, bytes: Uint8Array): string[] => {
	if (/\.md$/i.test(name))
		// Docs' markdown escapes _ and friends, including inside URLs
		return driveLinksIn(
			Buffer.from(bytes)
				.toString("utf8")
				.replace(/\\([_*~\-#])/g, "$1"),
		);
	if (!/\.(pptx|xlsx|docx)$/i.test(name)) return [];
	const entries = readZip(bytes);
	if (!entries) return [];
	return [...entries]
		.filter(([n]) => /\.(xml|rels)$/.test(n))
		.flatMap(([, data]) => driveLinksIn(data.toString("utf8")));
};

/**
 * Google wraps outbound links (in Docs exports, on Sites) in a google.com/url redirect
 * whose tracking params change every time: point them at where they actually go.
 */
export const unwrapRedirects = (html: string) =>
	html.replace(/https:\/\/www\.google\.com\/url\?(?:[^"]*?&(?:amp;)?)?q=([^&"]+)[^"]*/g, (_, q) => {
		try {
			return decodeURIComponent(q);
		} catch {
			return q;
		}
	});

/** where a Doc's images end up relative to its .md: filled in once the final name is known */
export const IMAGES_DIR = "\u0001images\u0001";

export type Exported = {
	name: string;
	bytes: Uint8Array;
	/** a Doc's images, in document order (01.png, 02.jpg, …) */
	images?: { name: string; bytes: Uint8Array }[];
	/** the Doc has (next to) no text: archive just its images */
	imagesOnly?: boolean;
};

const nhm = new NodeHtmlMarkdown({ keepDataImages: false, useLinkReferenceDefinitions: false });

/** a Docs HTML zip → markdown whose images point at IMAGES_DIR/NN.ext, and those images */
const docFromZip = (zip: Uint8Array): Pick<Exported, "bytes" | "images" | "imagesOnly"> | null => {
	const entries = readZip(zip);
	const htmlName = entries && [...entries.keys()].find((n) => n.endsWith(".html"));
	if (!entries || !htmlName) return null;
	let html = entries.get(htmlName)!.toString("utf8");
	html = html.replace(/^[\s\S]*?<body[^>]*>/, "").replace(/<\/body>[\s\S]*$/, "");
	html = unwrapRedirects(html);
	// the zip numbers images arbitrarily (differently every export): renumber by first use
	const order: string[] = [];
	for (const m of html.matchAll(/src="(images\/[^"]+)"/g)) if (!order.includes(m[1])) order.push(m[1]);
	for (const n of entries.keys()) if (n.startsWith("images/") && !order.includes(n)) order.push(n);
	const width = String(order.length).length < 2 ? 2 : String(order.length).length;
	const renamed = new Map(
		order.map((n, i) => [n, `${String(i + 1).padStart(width, "0")}${/\.[a-z0-9]+$/i.exec(n)?.[0] ?? ""}`]),
	);
	html = html.replace(/src="(images\/[^"]+)"/g, (m, n) =>
		renamed.has(n) ? `src="${IMAGES_DIR}/${renamed.get(n)}"` : m,
	);
	const md = nhm.translate(html).trim() + "\n";
	const text = md.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/[^\p{L}\p{N}]/gu, "");
	return {
		bytes: Buffer.from(md),
		images: order
			.filter((n) => entries.has(n))
			.map((n) => ({ name: renamed.get(n)!, bytes: entries.get(n)! })),
		imagesOnly: order.length > 0 && text.length < 10,
	};
};

/**
 * The file's bytes and Drive title, or null when this account can't see it (not shared,
 * deleted) or there's nothing to download (Forms).
 */
export const downloadDrive = async (
	g: Google,
	ref: DriveRef,
	maxBytes?: number,
): Promise<Exported | null> => {
	const url = EXPORTS[ref.kind]?.(ref.id);
	if (!url) return null;
	const res = await g.fetch(url, { maxBytes });
	if (!res) return null;
	if (res.status === 404 || res.status === 403 || res.status === 401) {
		await res.body?.cancel();
		return null;
	}
	if (!res.ok) {
		await res.body?.cancel();
		throw new Error(`HTTP ${res.status}`);
	}
	// an HTML page instead of a file means an interstitial or a sign-in wall
	if ((res.headers.get("content-type") ?? "").startsWith("text/html") && ref.kind === "file") {
		await res.body?.cancel();
		return null;
	}
	let bytes: Uint8Array = new Uint8Array(await res.arrayBuffer());
	if (ref.kind === "spreadsheets" || ref.kind === "presentation") bytes = normalizeZip(bytes);
	const name = filenameOf(res) ?? `${ref.id}${EXT[ref.kind] ?? ""}`;
	if (ref.kind === "document") {
		const doc = docFromZip(bytes);
		if (!doc) throw new Error("unreadable Docs export");
		return { name: `${name.replace(/\.zip$/i, "")}.md`, ...doc };
	}
	return { name, bytes };
};

export type FolderEntry = DriveRef & { title: string; modified?: string };

const decode = (s: string) =>
	s
		.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
		.replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");

/** a folder's title and direct children, or null if this account can't see it */
export const listFolder = async (
	g: Google,
	id: string,
): Promise<{ title: string; entries: FolderEntry[] } | null> => {
	const res = await g.fetch(`https://drive.google.com/embeddedfolderview?id=${id}`);
	if (!res || !res.ok) {
		await res?.body?.cancel();
		return null;
	}
	const html = await res.text();
	if (!html.includes("flip-entry") && !html.includes("folder-view")) return null;
	const title = decode(/<title>([^<]*)<\/title>/.exec(html)?.[1] ?? id);
	const entries: FolderEntry[] = [];
	for (const m of html.matchAll(
		/<div class="flip-entry" id="entry-([^"]+)"[\s\S]*?(?=<div class="flip-entry" id=|$)/g,
	)) {
		const block = m[0];
		const href = decode(/<a href="([^"]+)"/.exec(block)?.[1] ?? "");
		const ref = parseDriveUrl(href) ?? { kind: "file" as const, id: m[1] };
		entries.push({
			...ref,
			id: m[1],
			title: decode(/<div class="flip-entry-title">([^<]*)<\/div>/.exec(block)?.[1] ?? m[1]),
			modified: /<div class="flip-entry-last-modified"><div>([^<]*)<\/div>/.exec(block)?.[1],
		});
	}
	return { title, entries };
};
