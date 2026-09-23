/**
 * Cross-process locks as exclusively-created files holding {pid, host, since}.
 *
 * A lock is stale (and gets stolen) when its pid is dead on this host or it is
 * older than `staleAfterMs` — so a kill -9 or a reboot never wedges the cron.
 * Locks live under life/.git/autotrack/, where git never sees them.
 */

import { hostname } from "node:os";
import { readFileSync, rmSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

type Holder = { pid: number; host: string; since: number };

const isAlive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
};

const readHolder = async (path: string): Promise<Holder | null> => {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch {
		return null; // missing, or torn mid-write: treat as unheld
	}
};

const isStale = (holder: Holder | null, staleAfterMs: number) =>
	!holder || Date.now() - holder.since > staleAfterMs || (holder.host === hostname() && !isAlive(holder.pid));

export type Lock = { release: () => Promise<void> };

/** try once; null when someone live holds it */
export const tryLock = async (path: string, staleAfterMs = 6 * 3600_000): Promise<Lock | null> => {
	await mkdir(dirname(path), { recursive: true });
	const me: Holder = { pid: process.pid, host: hostname(), since: Date.now() };
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			await writeFile(path, JSON.stringify(me), { flag: "wx" });
			// only ever remove it while it is still ours (it may have been stolen as stale)
			const releaseSync = () => {
				try {
					const holder: Holder = JSON.parse(readFileSync(path, "utf8"));
					if (holder.pid === me.pid && holder.since === me.since) rmSync(path, { force: true });
				} catch {}
			};
			// covers process.exit() and normal exit; stale detection covers kill -9
			process.once("exit", releaseSync);
			return {
				release: async () => {
					process.off("exit", releaseSync);
					releaseSync();
				},
			};
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
			if (!isStale(await readHolder(path), staleAfterMs)) return null;
			await rm(path, { force: true });
		}
	}
	return null;
};

/** wait (polling) up to timeoutMs for the lock */
export const waitLock = async (path: string, timeoutMs: number, staleAfterMs?: number): Promise<Lock> => {
	const deadline = Date.now() + timeoutMs;
	while (true) {
		const lock = await tryLock(path, staleAfterMs);
		if (lock) return lock;
		if (Date.now() > deadline) throw new Error(`timed out waiting for lock ${path}`);
		await new Promise((r) => setTimeout(r, 250 + Math.random() * 500));
	}
};
