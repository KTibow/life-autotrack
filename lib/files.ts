/**
 * Downloads, with the symlinks themselves as the cache: a file is fetched only when no
 * link to it resolves to a blob on disk. A facet can also pass `known`, a blob it found
 * some other way (e.g. `scan()` of the links already in a directory, matched by name and
 * size, which catches files a teacher moved to another folder). The same bytes under
 * many names dedupe into one blob by sha256.
 *
 * Documents (PDF, Word, PowerPoint) become markdown with their PDF and source in blobs
 * (see document.ts); the existing `<name>.md` is then the cache. A document archived before
 * that, as a plain link, is converted from its blob without downloading it again.
 *
 * Sources' files are treated as immutable, so an existing link is never re-verified.
 */

import { existsSync } from "node:fs";
import { readdir, readFile, readlink, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parseDoc } from "./doc.ts";
import { archiveFile, isDocument, keepDocument, mdName } from "./document.ts";
import { log, logWarn, mb, stats } from "./log.ts";
import type { Store } from "./store.ts";

/** the blob sha256 a symlink resolves to, if it's a link into blobs/ that exists */
const linkedBlob = async (full: string): Promise<string | null> => {
	const target = await readlink(full).catch(() => null);
	if (!target) return null;
	const sha = basename(target);
	return /^[0-9a-f]{64}$/.test(sha) && existsSync(resolve(dirname(full), target)) ? sha : null;
};

export class Files {
	readonly #store: Store;
	readonly #inflight = new Map<string, Promise<boolean>>();

	constructor(store: Store) {
		this.#store = store;
	}

	/**
	 * Every link under scope-relative `dir`, keyed by `<file name>\0<size>` → sha256, and
	 * every document by the uploaded file's name and size → its source blob. Lets a facet
	 * recognize a file it already has under another path.
	 */
	async scan(dir: string): Promise<Map<string, string>> {
		const found = new Map<string, string>();
		const walk = async (full: string) => {
			for (const e of await readdir(full, { withFileTypes: true }).catch(() => [])) {
				const path = join(full, e.name);
				if (e.isDirectory()) await walk(path);
				else if (e.isSymbolicLink()) {
					const sha = await linkedBlob(path);
					if (sha) found.set(`${e.name}\0${(await stat(path)).size}`, sha);
				} else if (e.name.endsWith(".md")) {
					const { meta } = parseDoc(await readFile(path, "utf8"));
					const source: unknown = meta.source ?? meta.pdf;
					if (typeof meta.file !== "string" || typeof source !== "string") continue;
					const size = await stat(join(this.#store.life, source)).then(
						(s) => s.size,
						() => null,
					);
					if (size !== null) found.set(`${meta.file}\0${size}`, source.split("/").pop()!);
				}
			}
		};
		await walk(this.#store.abs(dir));
		return found;
	}

	/**
	 * Make scope-relative `rel` a link to the file's bytes (a document: `<name>.md`, with
	 * `meta` in its frontmatter), calling `fetch` only if nothing archived has them. Returns
	 * false (and logs) when the fetch fails or declines, so one bad file never sinks a run.
	 */
	link(
		rel: string,
		fetch: () => Promise<Uint8Array | null>,
		known?: string | null,
		meta?: Record<string, unknown>,
	) {
		const pending = this.#inflight.get(rel);
		if (pending) return pending;
		const job = (async () => {
			try {
				const document = isDocument(rel);
				if (document && (await keepDocument(this.#store, mdName(rel), meta))) return true;
				const sha = (await linkedBlob(this.#store.abs(rel))) ?? known;
				if (sha && !document) {
					await this.#store.link(rel, sha);
					return true;
				}
				let data: Uint8Array | null = sha ? await this.#store.readBlob(sha) : null;
				if (!data) {
					data = await fetch();
					if (!data) return false;
					stats.downloads++;
					stats.downloadedBytes += data.byteLength;
					log(`  ↓ ${basename(rel)} (${mb(data.byteLength)})`);
				}
				await archiveFile(this.#store, rel, data, meta);
				return true;
			} catch (e) {
				logWarn(`file ${basename(rel)} failed: ${(e as Error).message}`);
				return false;
			} finally {
				this.#inflight.delete(rel);
			}
		})();
		this.#inflight.set(rel, job);
		return job;
	}
}
