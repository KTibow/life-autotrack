/**
 * Downloads, with the symlinks themselves as the cache: a file is fetched only when no
 * link to it resolves to a blob on disk. A facet can also pass `known`, a blob it found
 * some other way (e.g. `scan()` of the links already in a directory, matched by name and
 * size, which catches files a teacher moved to another folder). The same bytes under
 * many names dedupe into one blob by sha256.
 *
 * Sources' files are treated as immutable, so an existing link is never re-verified.
 */

import { existsSync } from "node:fs";
import { readdir, readlink, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
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
	 * Every link under scope-relative `dir`, keyed by `<file name>\0<size>` → sha256.
	 * Lets a facet recognize a file it already has under another path.
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
				}
			}
		};
		await walk(this.#store.abs(dir));
		return found;
	}

	/**
	 * Make scope-relative `rel` a link to the file's bytes, calling `fetch` only if no
	 * existing link has them. Returns false (and logs) when the fetch fails or declines,
	 * so one bad file never sinks a run.
	 */
	link(rel: string, fetch: () => Promise<Uint8Array | null>, known?: string | null) {
		const pending = this.#inflight.get(rel);
		if (pending) return pending;
		const job = (async () => {
			try {
				const sha = (await linkedBlob(this.#store.abs(rel))) ?? known;
				if (sha) {
					await this.#store.link(rel, sha);
					return true;
				}
				const data = await fetch();
				if (!data) return false;
				stats.downloads++;
				stats.downloadedBytes += data.byteLength;
				log(`  ↓ ${basename(rel)} (${mb(data.byteLength)})`);
				await this.#store.link(rel, await this.#store.blob(data));
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
