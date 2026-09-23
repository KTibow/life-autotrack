/**
 * A facet's view of the life repo: everything it writes lands under life/<scope>/,
 * except content-addressed blobs, which are shared across facets in life/blobs/.
 *
 * - writes are atomic (temp file in .git/autotrack/tmp, then rename) and skipped when
 *   the bytes are unchanged, so a crash never leaves a torn file for git to commit
 * - JSON is pretty-printed with a trailing newline, for line-oriented diffs
 * - blobs live at blobs/<sha256[0:2]>/<sha256>, written once, never deleted; human
 *   names are relative symlinks into them, so one file can carry many names and ids
 * - pruning is opt-in per directory via `complete(dir)`: only a directory whose data
 *   was fully fetched this run loses the files it didn't rewrite. A failed fetch
 *   therefore can never look like a deletion.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import {
	lstat,
	mkdir,
	readdir,
	readFile,
	readlink,
	rename,
	rm,
	rmdir,
	symlink,
	writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { formatDoc, parseDoc } from "./doc.ts";

export type BlobRef = { sha256: string; size: number; path: string };

export class Store {
	readonly life: string;
	readonly scope: string;
	readonly root: string;
	/** repo-relative paths written (or confirmed unchanged) this run */
	readonly touched = new Set<string>();
	/** repo-relative blob paths this run wrote or referenced (committed alongside the scope,
	 * so a blob left uncommitted by an earlier failed run still lands with its symlink) */
	readonly blobs = new Set<string>();
	readonly #completed = new Set<string>();
	readonly #tmp: string;

	constructor(life: string, scope: string) {
		this.life = life;
		this.scope = scope;
		this.root = join(life, scope);
		this.#tmp = join(life, ".git", "autotrack", "tmp");
	}

	/** absolute path of a scope-relative path, refusing to escape the scope */
	abs(rel: string) {
		const full = resolve(this.root, rel);
		if (full !== this.root && !full.startsWith(this.root + sep))
			throw new Error(`path escapes scope: ${rel}`);
		return full;
	}

	#repoRel(abs: string) {
		return relative(this.life, abs).split(sep).join("/");
	}

	async #atomicWrite(full: string, data: string | Uint8Array) {
		await mkdir(dirname(full), { recursive: true });
		await mkdir(this.#tmp, { recursive: true });
		const tmp = join(this.#tmp, randomBytes(8).toString("hex"));
		await writeFile(tmp, data);
		await rename(tmp, full);
	}

	async writeText(rel: string, text: string) {
		const full = this.abs(rel);
		this.touched.add(this.#repoRel(full));
		const existing = await readFile(full, "utf8").catch(() => null);
		if (existing === text) return;
		// a symlink or dir in the way would make rename do the wrong thing
		const stat = await lstat(full).catch(() => null);
		if (stat && !stat.isFile()) await rm(full, { force: true, recursive: true });
		await this.#atomicWrite(full, text);
	}

	async writeJson(rel: string, value: unknown) {
		await this.writeText(rel, JSON.stringify(value, null, "\t") + "\n");
	}

	/** markdown with a `key: <json>` frontmatter header (see lib/doc.ts) */
	async writeDoc(rel: string, meta: Record<string, unknown>, body: string) {
		await this.writeText(rel, formatDoc(meta, body));
	}

	async readDoc(rel: string) {
		const text = await readFile(this.abs(rel), "utf8").catch(() => null);
		return text === null ? undefined : parseDoc(text);
	}

	exists(rel: string) {
		return existsSync(this.abs(rel));
	}

	async readJson<T = any>(rel: string): Promise<T | undefined> {
		try {
			return JSON.parse(await readFile(this.abs(rel), "utf8"));
		} catch {
			return undefined;
		}
	}

	/** store bytes content-addressed; returns the repo-relative blob path */
	async blob(data: Uint8Array): Promise<BlobRef> {
		const sha256 = createHash("sha256").update(data).digest("hex");
		const rel = `blobs/${sha256.slice(0, 2)}/${sha256}`;
		const full = join(this.life, rel);
		if (!existsSync(full)) {
			await this.#ensureBlobAttributes();
			await this.#atomicWrite(full, data);
		}
		this.blobs.add(rel);
		return { sha256, size: data.byteLength, path: rel };
	}

	async #ensureBlobAttributes() {
		const rel = "blobs/.gitattributes";
		const full = join(this.life, rel);
		if (existsSync(full)) return;
		// keep binary blobs out of textual diffs; `git log --stat` still shows them
		await this.#atomicWrite(full, "* binary\n.gitattributes -binary\n");
		this.blobs.add(rel);
	}

	/** give a blob a human name: a relative symlink at scope-relative `rel` */
	async link(rel: string, blob: BlobRef | string) {
		const blobPath = typeof blob === "string" ? `blobs/${blob.slice(0, 2)}/${blob}` : blob.path;
		const full = this.abs(rel);
		const target = relative(dirname(full), join(this.life, blobPath));
		this.touched.add(this.#repoRel(full));
		this.blobs.add(blobPath);
		if ((await readlink(full).catch(() => null)) === target) return;
		await mkdir(dirname(full), { recursive: true });
		await rm(full, { force: true, recursive: true });
		await symlink(target, full);
	}

	/** keep everything under scope-relative `rel` as it is (for data we couldn't refresh) */
	async keep(rel: string) {
		const walk = async (full: string): Promise<void> => {
			const st = await lstat(full).catch(() => null);
			if (!st) return;
			if (st.isDirectory()) {
				for (const name of await readdir(full)) await walk(join(full, name));
				return;
			}
			this.touched.add(this.#repoRel(full));
			if (st.isSymbolicLink()) {
				const target = resolve(dirname(full), await readlink(full));
				if (target.startsWith(join(this.life, "blobs") + sep)) this.blobs.add(this.#repoRel(target));
			}
		};
		await walk(this.abs(rel));
	}

	/** rename a scope-relative file or directory (git sees the rename in the next commit) */
	async move(from: string, to: string) {
		const [src, dst] = [this.abs(from), this.abs(to)];
		if (src === dst || !existsSync(src) || existsSync(dst)) return false;
		await mkdir(dirname(dst), { recursive: true });
		await rename(src, dst);
		return true;
	}

	/** a blob's bytes by sha256, if it's on disk */
	async readBlob(sha256: string): Promise<Buffer | null> {
		return readFile(join(this.life, "blobs", sha256.slice(0, 2), sha256)).catch(() => null);
	}

	/** the blob sha256 a scope-relative symlink points at, if any */
	async readLinkTarget(rel: string): Promise<string | null> {
		const target = await readlink(this.abs(rel)).catch(() => null);
		return target ? (target.split("/").pop() ?? null) : null;
	}

	/** mark a scope-relative directory as fully fetched this run (prunes on finish) */
	complete(rel = ".") {
		this.#completed.add(this.abs(rel));
	}

	/** delete files in completed directories that weren't written this run */
	async prune(): Promise<string[]> {
		const removed: string[] = [];
		const walk = async (dir: string): Promise<boolean> => {
			let entries;
			try {
				entries = await readdir(dir, { withFileTypes: true });
			} catch {
				return true;
			}
			let empty = true;
			for (const entry of entries) {
				const full = join(dir, entry.name);
				if (entry.isDirectory()) {
					if (await walk(full)) await rmdir(full).catch(() => {});
					else empty = false;
				} else if (this.touched.has(this.#repoRel(full))) {
					empty = false;
				} else {
					await rm(full, { force: true });
					removed.push(this.#repoRel(full));
				}
			}
			return empty;
		};
		// skip completed dirs nested inside other completed dirs; the outer walk covers them
		const dirs = [...this.#completed].filter(
			(d) => ![...this.#completed].some((o) => o !== d && d.startsWith(o + sep)),
		);
		for (const dir of dirs) if ((await lstat(dir).catch(() => null))?.isDirectory()) await walk(dir);
		return removed;
	}
}

/** a filesystem-safe version of an untrusted name, keeping its extension when shortening */
export const safeName = (name: string, maxBytes = 150): string => {
	let out = name
		.normalize("NFC")
		.replace(/[\/\\\0-\x1f\x7f]/g, "_")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^\.+/, "_");
	if (!out) out = "_";
	if (Buffer.byteLength(out) <= maxBytes) return out;
	const dot = out.lastIndexOf(".");
	const ext = dot > 0 && out.length - dot <= 10 ? out.slice(dot) : "";
	let stem = out.slice(0, out.length - ext.length);
	while (Buffer.byteLength(stem + "…" + ext) > maxBytes) stem = stem.slice(0, -1);
	return stem + "…" + ext;
};

/** hands out unique, filesystem-safe names within one directory, in first-come order */
export const namer = () => {
	const taken = new Set<string>();
	const fn = (base: string, ext = "") => {
		const stem = safeName(base || "untitled", 140);
		let name = stem + ext;
		for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${stem} (${n})${ext}`;
		taken.add(name.toLowerCase());
		return name;
	};
	/** claim an exact name already chosen earlier (e.g. kept from the last run) */
	fn.claim = (name: string) => {
		if (taken.has(name.toLowerCase())) return false;
		taken.add(name.toLowerCase());
		return true;
	};
	return fn;
};
export type Namer = ReturnType<typeof namer>;

/** lowercase-dashed slug for directory names built from titles */
export const slug = (name: string, max = 60) =>
	name
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, max)
		.replace(/-+$/, "") || "untitled";
