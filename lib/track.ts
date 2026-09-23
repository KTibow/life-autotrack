/**
 * Facet runner: `track("schoology", async (ctx) => { ... })`.
 *
 * 1. refuses to run if another copy of this facet is running (exits 0, cron-friendly)
 * 2. hands the facet a Store scoped to life/<name>/ and a Files downloader
 * 3. on success: prunes completed dirs, commits scope + blobs with the facet's notes
 * 4. on failure: still commits whatever was fully written (never prunes), marks the
 *    commit "(partial)", and exits 1 so cron mail / monitoring notices
 */

import { join } from "node:path";
import { LIFE_DIR } from "./env.ts";
import { Files } from "./files.ts";
import { assertRepo, commitPaths } from "./git.ts";
import { tryLock } from "./lock.ts";
import { heartbeat, log, logWarn, setPhase, stats } from "./log.ts";
import { Store } from "./store.ts";

export type Context = {
	store: Store;
	files: Files;
	/** one-line human summaries of what changed; the first becomes the commit subject */
	note: (line: string) => void;
	/** non-fatal problem: logged, recorded in the commit body, run exits 1 at the end */
	warn: (line: string) => void;
};

export const track = async (name: string, run: (ctx: Context) => Promise<void>) => {
	const started = Date.now();
	assertRepo(LIFE_DIR);
	const lock = await tryLock(join(LIFE_DIR, ".git", "autotrack", `${name}.lock`));
	if (!lock) {
		log(`${name}: already running, skipping`);
		return;
	}

	const store = new Store(LIFE_DIR, name);
	// on a first import everything is "new"; one quiet commit beats a thousand notes
	const firstRun = !store.exists(".");
	const files = new Files(store);
	log(`${name}: starting${firstRun ? " (first run: initial import)" : ""} → ${store.root}`);
	const stopHeartbeat = heartbeat();
	const notes: string[] = [];
	const warnings: string[] = [];
	const ctx: Context = {
		store,
		files,
		note: (line) => {
			if (!firstRun) notes.push(line);
		},
		warn: (line) => {
			logWarn(line);
			warnings.push(line);
		},
	};

	let failure: unknown;
	try {
		await run(ctx);
	} catch (e) {
		failure = e;
		console.error(`${name} failed:`, e);
	}
	try {
		setPhase("saving and committing");
		log(`${name}: fetch done, saving and committing`);
		if (!failure) {
			const removed = await store.prune();
			if (removed.length) log(`  pruned ${removed.length} stale files`);
		}
		const flags = [failure && "partial", warnings.length && `${warnings.length} warnings`].filter(Boolean);
		const more = notes.length > 1 ? ` and ${notes.length - 1} more` : "";
		const headline = firstRun ? "initial import" : (notes[0] ?? "update");
		const subject = `${name}: ${headline}${more}${flags.length ? ` [${flags.join(", ")}]` : ""}`;
		const body = [
			...notes.slice(1),
			...warnings.map((w) => `warning: ${w}`),
			...(failure ? [`error: ${(failure as Error).message ?? failure}`] : []),
		];
		const result = await commitPaths(LIFE_DIR, [name, ...store.blobs], subject, body);
		const secs = ((Date.now() - started) / 1000).toFixed(1);
		log(
			result.busy
				? `${name}: repo is busy (.git/${result.busy}), left changes uncommitted (${secs}s)`
				: result.committed
					? `${name}: committed ${result.changes.length} changes in ${secs}s (${stats.downloads} downloads)`
					: `${name}: no changes (${secs}s)`,
		);
	} catch (e) {
		failure ??= e;
		console.error(`${name}: commit failed:`, e);
	} finally {
		stopHeartbeat();
		await lock.release();
	}
	if (failure || warnings.length) process.exitCode = 1;
};
