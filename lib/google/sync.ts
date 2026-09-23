/**
 * Put what a Drive link points at into an archive directory, named as Drive names it:
 * a file becomes `<title>.<ext>` (→ blob), a folder becomes `<title>/` with its whole tree.
 *
 * What gets fetched when:
 * - uploads are fetched once; an existing link is trusted
 * - Google-native files (Docs, Sheets, Slides, Drawings) change in place, so they're
 *   re-exported when the folder listing says they changed since our last check, or every
 *   DRIVE_RECHECK_HOURS otherwise. The last check is the symlink's own mtime: local cache
 *   state that never reaches git. A re-export whose content matches the archived copy
 *   (ignoring Office packing noise, see officeFingerprint) changes nothing.
 * - with no Google session, or on an error, whatever was archived before is kept as is
 */

import { lstat, lutimes } from "node:fs/promises";
import { optional } from "../env.ts";
import { pool } from "../http.ts";
import type { Files } from "../files.ts";
import { log, logWarn, stats } from "../log.ts";
import { namer, type Namer, type Store } from "../store.ts";
import type { Google } from "./browser.ts";
import {
	downloadDrive,
	EXT,
	isNative,
	listFolder,
	officeFingerprint,
	type DriveRef,
	type FolderEntry,
} from "./drive.ts";

const RECHECK_MS = Number(optional("DRIVE_RECHECK_HOURS") ?? 12) * 3600_000;
const MAX_BYTES = Number(optional("MAX_FILE_MB") ?? 250) * 1024 * 1024;
const MAX_FOLDER_FILES = Number(optional("DRIVE_MAX_FOLDER_FILES") ?? 2000);

export type DriveContext = { store: Store; files: Files; google: Google | null };

/** "6/25/22", "Apr 11", "10:31 AM" (today) → epoch ms, or undefined */
const listingTime = (s?: string): number | undefined => {
	if (!s) return;
	const now = new Date();
	let m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s);
	if (m)
		return new Date(
			Number(m[3].length === 2 ? `20${m[3]}` : m[3]),
			Number(m[1]) - 1,
			Number(m[2]) + 1,
		).getTime();
	m = /^([A-Z][a-z]{2}) (\d{1,2})$/.exec(s);
	if (m) return new Date(`${m[1]} ${Number(m[2]) + 1}, ${now.getFullYear()}`).getTime();
	m = /^(\d{1,2}):(\d{2}) ?([AP]M)$/i.exec(s);
	if (m) {
		const h = (Number(m[1]) % 12) + (m[3].toUpperCase() === "PM" ? 12 : 0);
		return new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, Number(m[2]) + 1).getTime();
	}
};

const checkedAt = async (store: Store, rel: string) =>
	(await lstat(store.abs(rel)).catch(() => null))?.mtimeMs;
const markChecked = (store: Store, rel: string) =>
	lutimes(store.abs(rel), new Date(), new Date()).catch(() => {});

/** fetch + link one file; returns the name it ended up under, or null */
const syncFile = async (
	ctx: DriveContext,
	ref: DriveRef,
	dir: string,
	name: Namer,
	opts: { previous?: string; title?: string; modified?: string },
): Promise<string | null> => {
	const { store, files, google } = ctx;
	// the name we'd use without downloading: last run's, or the listing title
	const guess =
		opts.previous ??
		(opts.title
			? `${opts.title}${EXT[ref.kind] && !opts.title.endsWith(EXT[ref.kind]!) ? EXT[ref.kind] : ""}`
			: undefined);
	const checked = guess ? await checkedAt(store, `${dir}/${guess}`) : undefined;
	const fresh =
		checked !== undefined &&
		(!isNative(ref.kind) ||
			(Date.now() - checked < RECHECK_MS && (listingTime(opts.modified) ?? 0) <= checked));
	if (guess && checked !== undefined && (fresh || !google) && name.claim(guess)) {
		await store.keep(`${dir}/${guess}`);
		return guess;
	}
	if (!google) return null;
	const got = await downloadDrive(google, ref, MAX_BYTES).catch((e) => {
		logWarn(`Drive ${ref.kind} ${ref.id}: ${(e as Error).message}`);
		return undefined;
	});
	if (got === undefined && guess && checked !== undefined && name.claim(guess)) {
		await store.keep(`${dir}/${guess}`); // transient failure: keep last run's copy
		return guess;
	}
	if (!got) return null; // no access, or nothing to download (Forms)
	const dot = got.name.lastIndexOf(".");
	const final = dot > 0 ? name(got.name.slice(0, dot), got.name.slice(dot)) : name(got.name);
	const rel = `${dir}/${final}`;
	const before = await store.readLinkTarget(rel);
	// Office exports aren't byte-stable (Slides renumbers images every time): if the content
	// matches what's archived, keep the archived copy so nothing changes
	if (before && (ref.kind === "spreadsheets" || ref.kind === "presentation")) {
		const old = await store.readBlob(before);
		if (old && officeFingerprint(old) === officeFingerprint(got.bytes)) {
			await store.link(rel, before);
			await markChecked(store, rel);
			return final;
		}
	}
	const blob = await store.blob(got.bytes);
	await store.link(rel, blob);
	if (before !== blob.sha256) {
		stats.downloads++;
		stats.downloadedBytes += got.bytes.byteLength;
		log(`  ↓ ${final} (Drive${before ? ", changed" : ""})`);
	}
	await markChecked(store, rel);
	return final;
};

const syncFolder = async (
	ctx: DriveContext,
	id: string,
	dir: string,
	name: Namer,
	opts: { previous?: string; title?: string; budget: { files: number }; depth: number },
): Promise<string | null> => {
	const { store, google } = ctx;
	const keepPrevious = async () => {
		if (!opts.previous || !store.exists(`${dir}/${opts.previous}`) || !name.claim(opts.previous)) return null;
		await store.keep(`${dir}/${opts.previous}`);
		return opts.previous;
	};
	if (!google) return keepPrevious();
	const listing = await listFolder(google, id).catch((e) => {
		logWarn(`Drive folder ${id}: ${(e as Error).message}`);
		return undefined;
	});
	if (listing === undefined) return keepPrevious();
	if (!listing) return null;
	const folderName = name(listing.title || opts.title || id);
	const sub = `${dir}/${folderName}`;
	if (opts.previous && opts.previous !== folderName && (await store.move(`${dir}/${opts.previous}`, sub)))
		log(`  Drive folder renamed: ${opts.previous} → ${folderName}`);
	const inner = namer();
	// subfolders one at a time (names claimed in listing order), files 4 at a time
	for (const entry of listing.entries.filter((e) => e.kind === "folder"))
		await syncEntry(ctx, entry, sub, inner, opts.budget, opts.depth + 1);
	await pool(
		listing.entries.filter((e) => e.kind !== "folder"),
		4,
		(entry) => syncEntry(ctx, entry, sub, inner, opts.budget, opts.depth + 1),
	);
	return folderName;
};

const syncEntry = async (
	ctx: DriveContext,
	entry: FolderEntry,
	dir: string,
	name: Namer,
	budget: { files: number },
	depth: number,
) => {
	if (entry.kind === "folder") {
		if (depth > 10) return;
		await syncFolder(ctx, entry.id, dir, name, { previous: entry.title, title: entry.title, budget, depth });
	} else {
		if (budget.files-- <= 0) return;
		await syncFile(ctx, entry, dir, name, { title: entry.title, modified: entry.modified });
	}
};

/**
 * Sync a linked Drive file or folder into scope-relative `dir`. `previous` is the name
 * it had there last run (so a signed-out or failing run keeps it). Returns the name it's
 * under now, or null if there's nothing (no access, a Form).
 */
export const syncDrive = async (
	ctx: DriveContext,
	ref: DriveRef,
	dir: string,
	name: Namer,
	previous?: string,
): Promise<string | null> => {
	if (ref.kind === "folder") {
		const budget = { files: MAX_FOLDER_FILES };
		const result = await syncFolder(ctx, ref.id, dir, name, { previous, budget, depth: 0 });
		if (budget.files < 0) logWarn(`Drive folder ${ref.id}: stopped at DRIVE_MAX_FOLDER_FILES`);
		return result;
	}
	return syncFile(ctx, ref, dir, name, { previous });
};
