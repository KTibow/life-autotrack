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
 * - with no Google session, or on an error, whatever was archived before is kept as is;
 *   a link that couldn't be fetched and has nothing archived keeps its whole directory, since
 *   a failed fetch must never look like a deletion
 * - Docs, decks and uploaded documents (PDF, Word, PowerPoint) become `<title>.md` with
 *   their PDF in the frontmatter (see lib/document.ts)
 * - Drive links inside a synced Doc/Sheet/deck are followed into `<file>.attachments/`,
 *   refreshed whenever that file is re-exported, up to DRIVE_LINK_DEPTH hops
 */

import { lstat, lutimes, readdir } from "node:fs/promises";
import { optional } from "../env.ts";
import { pool } from "../http.ts";
import type { Files } from "../files.ts";
import { log, logWarn, stats } from "../log.ts";
import { archiveFile, isDocument, mdName, saveDocument } from "../document.ts";
import { namer, type Namer, type Store } from "../store.ts";
import type { Google } from "./browser.ts";
import {
	downloadDrive,
	downloadPdf,
	EXT,
	isNative,
	linksInExport,
	listFolder,
	officeFingerprint,
	parseDriveUrl,
	type DriveKind,
	type DriveRef,
	type FolderEntry,
} from "./drive.ts";

const RECHECK_MS = Number(optional("DRIVE_RECHECK_HOURS") ?? 12) * 3600_000;
const MAX_BYTES = Number(optional("MAX_FILE_MB") ?? 250) * 1024 * 1024;
const MAX_FOLDER_FILES = Number(optional("DRIVE_MAX_FOLDER_FILES") ?? 2000);
const MAX_LINK_DEPTH = Number(optional("DRIVE_LINK_DEPTH") ?? 2);

export type DriveContext = {
	store: Store;
	files: Files;
	google: Google | null;
	/** Drive ids on the current chain of links (a doc linking to a doc linking back stops) */
	chain?: Set<string>;
};

const stem = (name: string) => name.replace(/\.[^.]+$/, "");

/**
 * Files linked from inside a synced file (a Doc's links, a deck's hyperlinks and speaker
 * notes) go next to it in `<name>.attachments/`, like a Schoology item's. `from` is what
 * was downloaded (its name says how to read it); null means the file wasn't re-exported
 * this run: keep what was synced from it last time. Each linked file's name from last run
 * comes from the `id` in its frontmatter (documents); one that can't be fetched and wasn't
 * found that way (a plain file, a folder) keeps the whole directory as it is.
 */
const syncLinkedFrom = async (
	ctx: DriveContext,
	ref: DriveRef,
	dir: string,
	name: string,
	from: { name: string; bytes: Uint8Array } | null,
) => {
	const sub = `${dir}/${stem(name)}.attachments`;
	const chain = ctx.chain ?? new Set<string>();
	if (!from || chain.size >= MAX_LINK_DEPTH) return ctx.store.keep(sub);
	const refs = new Map<string, DriveRef>();
	for (const url of linksInExport(from.name, from.bytes)) {
		const r = parseDriveUrl(url);
		if (r && r.id !== ref.id && !chain.has(r.id)) refs.set(r.id, r);
	}
	if (!refs.size) return;
	const inner = { ...ctx, chain: new Set([...chain, ref.id]) };
	const previous = new Map<string, string>();
	for (const e of await readdir(ctx.store.abs(sub)).catch(() => [] as string[]))
		if (e.endsWith(".md")) {
			const id = (await ctx.store.readDoc(`${sub}/${e}`))?.meta.id;
			if (id) previous.set(String(id), e);
		}
	const names = namer();
	let failed = false;
	for (const r of refs.values())
		if ((await syncDrive(inner, r, sub, names, previous.get(r.id))) === undefined) failed = true;
	if (failed) await ctx.store.keep(sub);
};

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

/** the name a file has in the archive, from its title in Drive */
const archivedName = (kind: DriveKind, title: string) => {
	if (kind === "file") return isDocument(title) ? mdName(title) : title;
	const ext = EXT[kind] ?? "";
	return `${title}${ext && !title.endsWith(ext) ? ext : ""}`;
};

/** fetch + archive one file; returns the name it ended up under (see syncDrive) */
const syncFile = async (
	ctx: DriveContext,
	ref: DriveRef,
	dir: string,
	name: Namer,
	opts: { previous?: string; title?: string; modified?: string },
): Promise<string | null | undefined> => {
	const { store, google } = ctx;
	// the name we'd use without downloading: last run's, or the listing title (an upload
	// archived before documents became markdown is still `Title.pdf`)
	const candidates = opts.previous
		? [opts.previous]
		: opts.title
			? [...new Set([archivedName(ref.kind, opts.title), opts.title])]
			: [];
	let guess: string | undefined;
	let checked: number | undefined;
	for (const c of candidates) {
		checked = await checkedAt(store, `${dir}/${c}`);
		guess = c;
		if (checked !== undefined) break;
	}
	const keepAll = async (kept: string) => {
		await store.keep(`${dir}/${kept}`);
		if (kept.endsWith(".md")) await store.keep(`${dir}/${stem(kept)}.images`);
		await syncLinkedFrom(ctx, ref, dir, kept, null);
	};
	const fresh =
		checked !== undefined &&
		(!isNative(ref.kind) ||
			(Date.now() - checked < RECHECK_MS && (listingTime(opts.modified) ?? 0) <= checked));
	if (guess && checked !== undefined && (fresh || !google) && name.claim(guess)) {
		if (ref.kind === "file" && isDocument(guess) && !guess.endsWith(".md")) {
			// an upload archived as a plain file before documents became markdown: convert it
			const sha = await store.readLinkTarget(`${dir}/${guess}`);
			const bytes = sha && (await store.readBlob(sha));
			if (bytes) {
				const final = (await archiveFile(store, `${dir}/${guess}`, bytes, { type: ref.kind, id: ref.id }))
					.split("/")
					.pop()!;
				await markChecked(store, `${dir}/${final}`);
				await syncLinkedFrom(ctx, ref, dir, final, { name: guess, bytes });
				return final;
			}
		}
		await keepAll(guess);
		return guess;
	}
	if (!google) return undefined;
	const got = await downloadDrive(google, ref, MAX_BYTES).catch((e) => {
		logWarn(`Drive ${ref.kind} ${ref.id}: ${(e as Error).message}`);
		return undefined;
	});
	if (got === undefined) {
		if (!guess || checked === undefined || !name.claim(guess)) return undefined;
		await keepAll(guess); // transient failure: keep last run's copy
		return guess;
	}
	if (!got) {
		// signed out, only public access: "can't see it" may just mean "not signed in"
		if (google.anonymous && guess && checked !== undefined && name.claim(guess)) {
			await keepAll(guess);
			return guess;
		}
		return google.anonymous ? undefined : null; // no access, or nothing to download (Forms)
	}

	const dot = got.name.lastIndexOf(".");
	if (got.doc) {
		// a Doc or deck: markdown, images, and a PDF export when it changed
		const final = name(dot > 0 ? got.name.slice(0, dot) : got.name, ".md");
		const changed = await saveDocument(
			store,
			`${dir}/${final}`,
			{ type: ref.kind, id: ref.id },
			got.doc,
			() => downloadPdf(google, ref),
		);
		if (changed) {
			stats.downloads++;
			stats.downloadedBytes += got.bytes.byteLength;
			log(`  ↓ ${final} (Drive${guess === final && checked !== undefined ? ", changed" : ""})`);
		}
		await markChecked(store, `${dir}/${final}`);
		await syncLinkedFrom(ctx, ref, dir, final, got);
		return final;
	}

	const named = dot > 0 ? name(got.name.slice(0, dot), got.name.slice(dot)) : name(got.name);
	if (ref.kind === "file" && isDocument(named)) {
		// an uploaded PDF/Word/PowerPoint file (fetched once, like every upload)
		stats.downloads++;
		stats.downloadedBytes += got.bytes.byteLength;
		log(`  ↓ ${named} (Drive)`);
		const final = (await archiveFile(store, `${dir}/${named}`, got.bytes, { type: ref.kind, id: ref.id }))
			.split("/")
			.pop()!;
		await markChecked(store, `${dir}/${final}`);
		await syncLinkedFrom(ctx, ref, dir, final, { name: named, bytes: got.bytes });
		return final;
	}
	const final = named;
	const rel = `${dir}/${final}`;
	const before = await store.readLinkTarget(rel);
	// Office exports aren't byte-stable (Slides renumbers images every time): if the content
	// matches what's archived, keep the archived copy so nothing changes
	if (before && (ref.kind === "spreadsheets" || ref.kind === "presentation")) {
		const old = await store.readBlob(before);
		if (old && officeFingerprint(old) === officeFingerprint(got.bytes)) {
			await store.link(rel, before);
			await markChecked(store, rel);
			await syncLinkedFrom(ctx, ref, dir, final, got);
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
	await syncLinkedFrom(ctx, ref, dir, final, got);
	return final;
};

const syncFolder = async (
	ctx: DriveContext,
	id: string,
	dir: string,
	name: Namer,
	opts: { previous?: string; title?: string; budget: { files: number }; depth: number },
): Promise<string | null | undefined> => {
	const { store, google } = ctx;
	const keepPrevious = async () => {
		if (!opts.previous || !store.exists(`${dir}/${opts.previous}`) || !name.claim(opts.previous))
			return undefined;
		await store.keep(`${dir}/${opts.previous}`);
		return opts.previous;
	};
	if (!google) return keepPrevious();
	const listing = await listFolder(google, id).catch((e) => {
		logWarn(`Drive folder ${id}: ${(e as Error).message}`);
		return undefined;
	});
	if (listing === undefined) return keepPrevious();
	if (!listing) return google.anonymous ? keepPrevious() : null;
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
 * under now, null if there's nothing (no access, a Form), or undefined if it couldn't be
 * fetched this run and nothing archived was kept in its place.
 */
export const syncDrive = async (
	ctx: DriveContext,
	ref: DriveRef,
	dir: string,
	name: Namer,
	previous?: string,
): Promise<string | null | undefined> => {
	if (ref.kind === "folder") {
		const budget = { files: MAX_FOLDER_FILES };
		const result = await syncFolder(ctx, ref.id, dir, name, { previous, budget, depth: 0 });
		if (budget.files < 0) logWarn(`Drive folder ${ref.id}: stopped at DRIVE_MAX_FOLDER_FILES`);
		return result;
	}
	return syncFile(ctx, ref, dir, name, { previous });
};
