/**
 * Documents are archived as markdown: one `<name>.md` per Google Doc or Slides deck, and per
 * uploaded PDF, Word or PowerPoint file, so everything anyone wrote is greppable text.
 *
 *   Essay prompt.md          the text; frontmatter: type, id, and
 *                              pdf: "blobs/ab/<sha256>"     the document as a PDF
 *                              source: "blobs/cd/<sha256>"  the uploaded file, if it wasn't a PDF
 *                              file: "Essay prompt.docx"    the uploaded file's name
 *   Essay prompt.images/     its images, full size, numbered in document order
 *
 * - Google Docs come from their HTML export (see google/drive.ts); everything else goes
 *   through markitdown (`uvx`), which handles PDF, .docx and .pptx (with speaker notes).
 * - PDFs: an uploaded PDF is its own; Google exports one; Word/PowerPoint uploads are
 *   printed by LibreOffice when it's installed (and old .doc/.ppt/.odt need it to be read
 *   at all). Without it, those keep just their source.
 * - A re-exported Google file keeps the PDF it has while its text and images are unchanged
 *   (PDF exports aren't byte-stable), so a PDF is only fetched when something changed.
 * - A file that can't be converted (tools missing, a broken file) is linked as it is.
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { optional } from "./env.ts";
import { logWarn } from "./log.ts";
import type { Store } from "./store.ts";

/** where a document's images end up relative to its .md: filled in once the final name is known */
export const IMAGES_DIR = "\u0001images\u0001";

export type Doc = { body: string; images: { name: string; bytes: Uint8Array }[] };

export const isDocument = (name: string) => /\.(pdf|docx|pptx|doc|ppt|odt|odp|rtf)$/i.test(name);
/** "Syllabus.pdf" → "Syllabus.md" */
export const mdName = (name: string) => name.replace(/\.[^./]+$/, "") + ".md";

// ———————————————————————————————————— external tools

const MARKITDOWN = (
	optional("MARKITDOWN_COMMAND") ?? "uvx --quiet --from markitdown[docx,pptx,pdf]==0.1.8 markitdown"
).split(/\s+/);
const SOFFICE = (optional("SOFFICE_COMMAND") ?? "soffice").split(/\s+/);
const TIMEOUT_MS = 180_000;

class Missing extends Error {}
const missing = new Set<string>();

/** run a command; stdout, or throws (Missing if the command isn't installed) */
const run = (cmd: string[], input?: Uint8Array) =>
	new Promise<Buffer>((resolve, reject) => {
		const child = spawn(cmd[0], cmd.slice(1), { stdio: ["pipe", "pipe", "pipe"], timeout: TIMEOUT_MS });
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		child.stdout.on("data", (d) => out.push(d));
		child.stderr.on("data", (d) => err.push(d));
		child.on("error", (e: NodeJS.ErrnoException) => reject(e.code === "ENOENT" ? new Missing(cmd[0]) : e));
		child.on("close", (code) =>
			code === 0
				? resolve(Buffer.concat(out))
				: reject(new Error(`${cmd[0]} exited ${code}: ${Buffer.concat(err).toString().trim().slice(-300)}`)),
		);
		child.stdin.on("error", () => {}); // a tool that exits early closes stdin on us
		child.stdin.end(input);
	});

/** conversions are CPU-heavy: two at a time per process */
let slots = 2;
const waiting: (() => void)[] = [];
const limited = async <T>(fn: () => Promise<T>): Promise<T> => {
	if (slots > 0) slots--;
	else await new Promise<void>((r) => waiting.push(r));
	try {
		return await fn();
	} finally {
		const next = waiting.shift();
		if (next) next();
		else slots++;
	}
};

/** null when the tool isn't installed (said once per run) */
const tool = async <T>(what: string, fn: () => Promise<T>): Promise<T | null> => {
	if (missing.has(what)) return null;
	try {
		return await limited(fn);
	} catch (e) {
		if (!(e instanceof Missing)) throw e;
		missing.add(what);
		logWarn(`${e.message} not found: ${what}`);
		return null;
	}
};

const markitdown = (bytes: Uint8Array, ext: string) =>
	tool("documents are archived as files, not markdown (install uv, or set MARKITDOWN_COMMAND)", async () =>
		(await run([...MARKITDOWN, "--keep-data-uris", "-x", ext], bytes)).toString("utf8"),
	);

/** LibreOffice: convert to another format ("pdf", "docx", "pptx") in a throwaway profile */
const soffice = (bytes: Uint8Array, ext: string, to: string) =>
	tool("Word/PowerPoint files get no PDF (install LibreOffice, or set SOFFICE_COMMAND)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "life-autotrack-"));
		try {
			await writeFile(join(dir, `in${ext}`), bytes);
			await run([
				...SOFFICE,
				`-env:UserInstallation=file://${dir}/profile`,
				"--headless",
				"--convert-to",
				to,
				"--outdir",
				dir,
				join(dir, `in${ext}`),
			]);
			return await readFile(join(dir, `in.${to}`));
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

// ———————————————————————————————————— markdown

const IMAGE_EXT: Record<string, string> = {
	jpeg: ".jpg",
	"svg+xml": ".svg",
	"x-emf": ".emf",
	"x-wmf": ".wmf",
};

/** markitdown's inline data: images → IMAGES_DIR/NN.ext files, numbered by first use */
const splitImages = (md: string): Doc => {
	const re = /(!\[[^\]]*\]\()data:image\/([\w.+-]+);base64,([A-Za-z0-9+/=]+)\)/g;
	const found = new Map<string, { name: string; bytes: Uint8Array }>();
	const count = new Set([...md.matchAll(re)].map((m) => m[3])).size;
	const width = Math.max(2, String(count).length);
	const body = md.replace(re, (_, open, type, data) => {
		let img = found.get(data);
		if (!img) {
			const ext = IMAGE_EXT[type] ?? `.${type.replace(/[^a-z0-9]/gi, "")}`;
			img = {
				name: `${String(found.size + 1).padStart(width, "0")}${ext}`,
				bytes: Buffer.from(data, "base64"),
			};
			found.set(data, img);
		}
		return `${open}${IMAGES_DIR}/${img.name})`;
	});
	// Slides names every image "Google Shape;<n>;p<slide>": that's not alt text
	return { body: body.replace(/!\[Google Shape;\d+;p\d+\]/g, "![]").trim(), images: [...found.values()] };
};

/** a .pptx or .docx (or PDF) as markdown, or null if markitdown isn't available */
export const officeToDoc = async (bytes: Uint8Array, ext: string): Promise<Doc | null> => {
	const md = await markitdown(bytes, ext);
	return md === null ? null : splitImages(md);
};

export type Converted = { doc: Doc; pdf: Uint8Array | null; source: Uint8Array | null };

const MODERN: Record<string, string> = {
	".doc": "docx",
	".odt": "docx",
	".rtf": "docx",
	".ppt": "pptx",
	".odp": "pptx",
};

/** an uploaded document → markdown + PDF, or null if it can't be read */
export const convertFile = async (name: string, bytes: Uint8Array): Promise<Converted | null> => {
	const ext = /\.[^.]+$/.exec(name)?.[0].toLowerCase() ?? "";
	if (ext === ".pdf") {
		const doc = await officeToDoc(bytes, ext);
		return doc && { doc, pdf: bytes, source: null };
	}
	let readable: Uint8Array | null = bytes;
	let readableExt = ext;
	if (MODERN[ext]) {
		readable = await soffice(bytes, ext, MODERN[ext]);
		readableExt = `.${MODERN[ext]}`;
	}
	const doc = readable && (await officeToDoc(readable, readableExt));
	if (!doc) return null;
	const pdf = await soffice(bytes, ext, "pdf").catch((e) => {
		logWarn(`PDF of ${name}: ${(e as Error).message}`);
		return null;
	});
	return { doc, pdf, source: bytes };
};

// ———————————————————————————————————— saving

/** a document's images dir as a link from its .md ("A (1).images" → "A%20%281%29.images") */
const imagesLink = (rel: string) =>
	encodeURI(`${basename(rel, ".md")}.images`)
		.replace(/\(/g, "%28")
		.replace(/\)/g, "%29");

/**
 * Write a document to scope-relative `rel` (…/Name.md) with its images next to it. `pdf`
 * is the PDF's bytes, or a function fetching it, called only when the document is new or
 * its text or images changed. Returns whether anything changed.
 */
export const saveDocument = async (
	store: Store,
	rel: string,
	meta: Record<string, unknown>,
	doc: Doc,
	pdf: Uint8Array | null | (() => Promise<Uint8Array | null>),
	source?: Uint8Array | null,
): Promise<boolean> => {
	let imagesChanged = false;
	for (const img of doc.images) {
		const at = `${rel.slice(0, -3)}.images/${img.name}`;
		const was = await store.readLinkTarget(at);
		const blob = await store.blob(img.bytes);
		await store.link(at, blob);
		if (was !== blob.sha256) imagesChanged = true;
	}
	const body = doc.body.replaceAll(IMAGES_DIR, imagesLink(rel)).trim();
	const prev = await store.readDoc(rel);
	let pdfPath: string | undefined;
	if (typeof pdf === "function") {
		const kept: string | undefined = prev?.meta.pdf;
		if (kept && prev!.body === body && !imagesChanged && store.useBlob(kept)) pdfPath = kept;
		else {
			const bytes = await pdf().catch((e) => {
				logWarn(`PDF of ${basename(rel)}: ${(e as Error).message}`);
				return null;
			});
			if (bytes) pdfPath = (await store.blob(bytes)).path;
		}
	} else if (pdf) pdfPath = (await store.blob(pdf)).path;
	const sourcePath = source ? (await store.blob(source)).path : undefined;
	await store.writeDoc(rel, { ...meta, source: sourcePath, pdf: pdfPath }, body);
	return imagesChanged || prev?.body !== body || prev?.meta.pdf !== pdfPath;
};

/**
 * An uploaded file at scope-relative `rel` (named as uploaded): a document becomes
 * `<name>.md`, anything else (or a document that can't be read) a link to its bytes.
 * Returns the path it ended up at.
 */
export const archiveFile = async (
	store: Store,
	rel: string,
	bytes: Uint8Array,
	meta: Record<string, unknown> = {},
): Promise<string> => {
	if (isDocument(rel)) {
		const converted = await convertFile(basename(rel), bytes).catch((e) => {
			logWarn(`converting ${basename(rel)}: ${(e as Error).message}`);
			return null;
		});
		if (converted) {
			const md = mdName(rel);
			await saveDocument(
				store,
				md,
				{ ...meta, file: basename(rel) },
				converted.doc,
				converted.pdf,
				converted.source,
			);
			return md;
		}
	}
	await store.link(rel, await store.blob(bytes));
	return rel;
};

/**
 * keep an archived upload's document (its .md, images and blobs) as it is, with `meta`
 * as its fields if given; false if there's none
 */
export const keepDocument = async (
	store: Store,
	rel: string,
	meta?: Record<string, unknown>,
): Promise<boolean> => {
	const prev = await store.readDoc(rel);
	const original: string | undefined = prev?.meta.source ?? prev?.meta.pdf;
	if (!original || !store.useBlob(original)) return false;
	const { file, source, pdf } = prev!.meta;
	if (meta) await store.writeDoc(rel, { ...meta, file, source, pdf }, prev!.body);
	await store.keep(rel);
	await store.keep(`${rel.slice(0, -3)}.images`);
	return true;
};
