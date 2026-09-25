/**
 * `pnpm gc`: delete the blobs and Drive folder trees nothing in life/ uses anymore, and
 * commit that (so they stay in history). `pnpm gc --dry` only says what it would delete.
 *
 * - used means reachable from outside blobs/ and trees/: a symlink whose name ends in a
 *   blob's sha (even one broken by a move, see Store.keep), a markdown file's frontmatter
 *   pointing into blobs/ (a document's pdf and source), or a symlink into a tree, whose
 *   contents then count too; trees that only link each other go together
 * - holds every facet's lock, so no run is between writing a blob and linking it; a
 *   facet that has never run has no lock to hold, so anything written in the last day is
 *   kept regardless
 */

import { existsSync, readdirSync } from "node:fs";
import { lstat, readdir, readFile, readlink, rm, rmdir } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { parseDoc } from "../lib/doc.ts";
import { LIFE_DIR } from "../lib/env.ts";
import { assertRepo, commitPaths } from "../lib/git.ts";
import { tryLock, type Lock } from "../lib/lock.ts";
import { log, mb } from "../lib/log.ts";

const dry = process.argv.includes("--dry");
const GRACE_MS = 24 * 3600_000;
const SHA = /^[0-9a-f]{64}$/;
const BLOB_PATH = /^blobs\/[0-9a-f]{2}\/([0-9a-f]{64})$/;

assertRepo(LIFE_DIR);
const blobsDir = join(LIFE_DIR, "blobs");
const treesDir = join(LIFE_DIR, "trees");
const skip = new Set([".git", "blobs", "trees"]);

// every facet's lock: one per scope dir, plus any held by a run that hasn't made its dir yet
const locksDir = join(LIFE_DIR, ".git", "autotrack");
const names = new Set([
	...readdirSync(LIFE_DIR, { withFileTypes: true })
		.filter((e) => e.isDirectory() && !skip.has(e.name) && !e.name.startsWith("."))
		.map((e) => e.name),
	...(existsSync(locksDir) ? readdirSync(locksDir, { withFileTypes: true }) : [])
		.filter((e) => e.isFile() && e.name.endsWith(".lock") && e.name !== "commit.lock")
		.map((e) => e.name.slice(0, -5)),
]);
const locks: Lock[] = [];
const release = () => Promise.all(locks.map((l) => l.release()));
for (const name of names) {
	const lock = await tryLock(join(locksDir, `${name}.lock`));
	if (!lock) {
		await release();
		log(`gc: ${name} is running, try again later`);
		process.exit(1);
	}
	locks.push(lock);
}

try {
	// — what's used
	const usedBlobs = new Set<string>();
	const usedTrees = new Set<string>();
	const walk = async (full: string): Promise<void> => {
		const st = await lstat(full).catch(() => null);
		if (!st) return;
		if (st.isDirectory()) {
			for (const name of await readdir(full)) await walk(join(full, name));
		} else if (st.isSymbolicLink()) {
			const target = resolve(dirname(full), await readlink(full));
			if (SHA.test(basename(target))) usedBlobs.add(basename(target));
			else if (target.startsWith(treesDir + sep)) {
				const id = relative(treesDir, target).split(sep)[0];
				if (!usedTrees.has(id)) {
					usedTrees.add(id);
					await walk(join(treesDir, id));
				}
			}
		} else if (full.endsWith(".md")) {
			const { meta } = parseDoc(await readFile(full, "utf8"));
			for (const v of Object.values(meta)) {
				const m = typeof v === "string" && BLOB_PATH.exec(v);
				if (m) usedBlobs.add(m[1]);
			}
		}
	};
	for (const name of await readdir(LIFE_DIR)) if (!skip.has(name)) await walk(join(LIFE_DIR, name));

	// — what isn't (and is old enough to go)
	const old = async (full: string) => Date.now() - (await lstat(full)).mtimeMs > GRACE_MS;
	const blobs: { rel: string; size: number }[] = [];
	for (const ab of await readdir(blobsDir).catch(() => [] as string[])) {
		if (!/^[0-9a-f]{2}$/.test(ab)) continue;
		for (const sha of await readdir(join(blobsDir, ab))) {
			const full = join(blobsDir, ab, sha);
			if (!SHA.test(sha) || usedBlobs.has(sha) || !(await old(full))) continue;
			blobs.push({ rel: `blobs/${ab}/${sha}`, size: (await lstat(full)).size });
		}
	}
	const trees: string[] = [];
	for (const id of await readdir(treesDir).catch(() => [] as string[]))
		if (!usedTrees.has(id) && (await old(join(treesDir, id)))) trees.push(`trees/${id}`);

	const bytes = blobs.reduce((n, b) => n + b.size, 0);
	const summary = `${blobs.length} unused blobs (${mb(bytes)}) and ${trees.length} unused trees`;
	if (dry) {
		for (const t of trees) log(`  would remove ${t}`);
		log(`gc --dry: would remove ${summary}`);
	} else if (!blobs.length && !trees.length) {
		log("gc: nothing unused");
	} else {
		for (const b of blobs) await rm(join(LIFE_DIR, b.rel), { force: true });
		for (const t of trees) await rm(join(LIFE_DIR, t), { recursive: true, force: true });
		for (const ab of await readdir(blobsDir).catch(() => [] as string[]))
			if (/^[0-9a-f]{2}$/.test(ab)) await rmdir(join(blobsDir, ab)).catch(() => {});
		log(`gc: removed ${summary}`);
		const removed = [...blobs.map((b) => b.rel), ...trees];
		const result = await commitPaths(LIFE_DIR, [], `gc: removed ${summary}`, [], removed);
		log(
			result.busy
				? `gc: repo is busy (.git/${result.busy}), left the removal uncommitted`
				: result.committed
					? `gc: committed ${result.changes.length} removals`
					: "gc: nothing to commit (none of it was committed before)",
		);
	}
} finally {
	await release();
}
