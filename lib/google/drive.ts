/**
 * Google Drive through a browser session (see browser.ts), without the Drive API:
 *
 * - Google-native files are exported: Docs → .md (diffable), Sheets → .xlsx, Slides → .pdf,
 *   Drawings → .png. Forms have no export and are skipped.
 * - Uploaded files come from drive.usercontent.google.com (confirm=t skips the virus-scan
 *   interstitial on big files).
 * - Folders are listed with embeddedfolderview (ids, types, titles, modified dates).
 * - Names come from Content-Disposition, i.e. the file's title in Drive.
 * - Office exports are zips stamped with the export time; entry timestamps are zeroed so
 *   an unchanged file exports to identical bytes and makes no diff.
 */

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
		const m = new RegExp(
			String.raw`^/(document|spreadsheets|presentation|drawings|forms)/(?:u/\d+/)?d/${id}`,
		).exec(url.pathname);
		return m ? { kind: m[1] as DriveKind, id: m[2] } : null;
	}
	if (url.hostname === "drive.google.com") {
		const folder = new RegExp(String.raw`/folders/${id}`).exec(url.pathname);
		if (folder) return { kind: "folder", id: folder[1] };
		const file = new RegExp(String.raw`/file/(?:u/\d+/)?d/${id}`).exec(url.pathname);
		if (file) return { kind: "file", id: file[1] };
		const q = url.searchParams.get("id");
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
	document: (id) => `https://docs.google.com/document/d/${id}/export?format=md`,
	spreadsheets: (id) => `https://docs.google.com/spreadsheets/d/${id}/export?format=xlsx`,
	presentation: (id) => `https://docs.google.com/presentation/d/${id}/export/pdf`,
	drawings: (id) => `https://docs.google.com/drawings/d/${id}/export/png`,
	file: (id) => `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`,
};
export const EXT: Partial<Record<DriveKind, string>> = {
	document: ".md",
	spreadsheets: ".xlsx",
	presentation: ".pdf",
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

/**
 * The file's bytes and Drive title, or null when this account can't see it (not shared,
 * deleted) or there's nothing to download (Forms).
 */
export const downloadDrive = async (
	g: Google,
	ref: DriveRef,
	maxBytes?: number,
): Promise<{ name: string; bytes: Uint8Array } | null> => {
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
	if (ref.kind === "spreadsheets") bytes = normalizeZip(bytes);
	const name = filenameOf(res) ?? `${ref.id}${EXT[ref.kind] ?? ""}`;
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
