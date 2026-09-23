/**
 * Schoology → life/schoology/, laid out like the website:
 *
 *   2026-2027/s1-p3-us-history/               <term>-p<period>-<course>, from the section title
 *   ongoing/robotics-club/                    a section whose grading periods span years (clubs)
 *     section.json                            ids, titles, grading period dates
 *     materials/                              the materials tree, as folders
 *       Unit 1/
 *         Notes.md                            a page: body as markdown, fields as frontmatter
 *         HW 1.md                             an assignment (type, id, due, points, …)
 *         HW 1.attachments/worksheet.md       a PDF/Word/PowerPoint file, as markdown (its
 *                                             PDF and upload in blobs/, see lib/document.ts)
 *         HW 1.attachments/data.xlsx          any other file → symlink into blobs/
 *         HW 1.attachments/Essay prompt.md    a linked Google Doc (exported), or a linked
 *                                             Drive folder mirrored as a directory
 *         HW 1.submissions/2026-09-20 14-05 essay.md     your own submitted files
 *         Discussion.md  Discussion.comments.json
 *         Syllabus.md                         a document that is just one file
 *     updates/2026-09-22 14-05.md             (+ .attachments/, .comments.json)
 *     events/2026-10-01 Field trip.md
 *
 * Every markdown file's frontmatter has the Schoology `type`, `id` and `url`. Objects are trimmed
 * to the fields worth keeping; grades are left to StudentVUE. Sections you leave (last
 * term) stay where they are.
 */

import { readdir } from "node:fs/promises";
import { need, optional } from "../../lib/env.ts";
import { pool } from "../../lib/http.ts";
import { counter, log, mb, setPhase } from "../../lib/log.ts";
import { htmlToMarkdown } from "../../lib/markdown.ts";
import { compact, pick } from "../../lib/pick.ts";
import { namer, slug, type Namer } from "../../lib/store.ts";
import { track, type Context } from "../../lib/track.ts";
import { openGoogle, type Google } from "../../lib/google/browser.ts";
import { driveLinksIn, parseDriveUrl, type DriveRef } from "../../lib/google/drive.ts";
import { syncDrive } from "../../lib/google/sync.ts";
import { createSchoology, SchoologyError, type Schoology } from "./client.ts";

const WEB = `https://${optional("SCHOOLOGY_HOST") ?? "app.schoology.com"}`;
const MAX_FILE_BYTES = Number(optional("MAX_FILE_MB") ?? 250) * 1024 * 1024;
/** new files downloaded from Schoology per section per run; the rest wait (see archiveSection) */
const FILES_PER_RUN = Number(optional("SCHOOLOGY_FILES_PER_RUN") ?? 10);

/** 403/404 on a listing means "not available in this section", not a failure */
const orEmpty = async <T>(p: Promise<T[]>): Promise<T[]> => {
	try {
		return await p;
	} catch (e) {
		if (e instanceof SchoologyError && (e.status === 403 || e.status === 404)) return [];
		throw e;
	}
};

const md = (html: string | undefined) => htmlToMarkdown(html, WEB);

/** local "YYYY-MM-DD HH-MM" for a unix timestamp (sortable, filename-safe) */
const stamp = (unix: number | string) =>
	new Date(Number(unix) * 1000).toLocaleString("sv-SE").slice(0, 16).replace(":", "-");

const schoolYear = (iso: string) => {
	const [y, m] = iso.split("-").map(Number);
	return m >= 7 ? `${y}-${y + 1}` : `${y - 1}-${y}`;
};

/**
 * The top-level directory for a section, from its grading periods: the school year they
 * start in, or "ongoing" when they span more than a year (clubs sit in one "Ongoing
 * Student Learning" period, 2021-06-16 to 2040-07-31). No periods: this school year.
 */
const yearDir = (periods: any[]) => {
	const starts = periods
		.map((p) => String(p.start ?? "").slice(0, 10))
		.filter(Boolean)
		.sort();
	const ends = periods
		.map((p) => String(p.end ?? "").slice(0, 10))
		.filter(Boolean)
		.sort();
	if (starts.length && ends.length && Date.parse(ends.at(-1)!) - Date.parse(starts[0]) > 400 * 86_400_000)
		return "ongoing";
	return schoolYear(starts[0] || new Date().toLocaleDateString("sv-SE"));
};

/** "(S1) LASTNAME, F  US HISTORY(3)" + "US HISTORY" → "s1-p3-us-history" */
const sectionName = (s: any) => {
	const term = /^\s*\(([^)]+)\)/.exec(s.section_title ?? "")?.[1];
	const period = /\((\d+)\)\s*$/.exec(s.section_title ?? "")?.[1];
	return [term && slug(term), period && `p${period}`, slug(s.course_title ?? s.section_title ?? String(s.id))]
		.filter(Boolean)
		.join("-");
};

const extOf = (filename?: string) => /\.[a-z0-9]{1,8}$/i.exec(filename ?? "")?.[0] ?? "";

// ———————————————————————————————————— trimming

const attachments = (a: any) =>
	compact({
		files: (a?.files?.file ?? []).map((f: any) =>
			pick(f, ["id", "title", "filename", "filesize", "filemime", "md5_checksum", "timestamp"]),
		),
		links: (a?.links?.link ?? []).map((l: any) => pick(l, ["id", "title", "url"])),
		videos: (a?.videos?.video ?? []).map((v: any) => pick(v, ["id", "title", "url"])),
		embeds: (a?.embeds?.embed ?? []).map((e: any) => pick(e, ["id", "title", "url"])),
	});

const FIELDS: Record<string, string[]> = {
	assignment: ["title", "type", "due", "max_points", "allow_dropbox", "dropbox_locked"],
	page: ["title", "created"],
	discussion: ["title", "due", "graded", "max_points"],
	document: ["title"],
};

/** an item's page on the website */
const webUrl = (sid: string, type: string, id: unknown) =>
	type === "assignment"
		? `${WEB}/assignment/${id}/info`
		: type === "page"
			? `${WEB}/page/${id}`
			: type === "update"
				? `${WEB}/course/${sid}/updates`
				: `${WEB}/course/${sid}/materials/gp/${id}`;

const trimComments = (comments: any[]) =>
	comments.map((c) => pick(c, ["id", "uid", "parent_id", "created", "comment"]));

// ———————————————————————————————————— section archiving

type Section = { id: string; course_title: string; section_title?: string; [k: string]: unknown };

const archiveSection = async (
	ctx: Context,
	sc: Schoology,
	google: () => Promise<Google | null>,
	uid: string,
	section: Section,
	dir: string,
	periods: any[],
) => {
	const sid = String(section.id);
	const course = section.course_title;
	const label = `${course} (${dir})`;
	const { store, files } = ctx;
	const list = <T = any>(path: string, key: string) => orEmpty<T>(sc.all(path, key));
	log(`  ${label}: listing materials…`);

	const folderTree = async (folderId: string | number, depth = 0): Promise<any[]> => {
		const items: any[] = (await sc.get(`/courses/${sid}/folder/${folderId}`))["folder-item"] ?? [];
		return pool(items, 3, async (it) =>
			it.type === "folder" && depth < 12 ? { ...it, children: await folderTree(it.id, depth + 1) } : it,
		);
	};
	const [tree, assignments, pages, documents, discussions, updates, events] = await Promise.all([
		folderTree(0).catch((e) => {
			if (e instanceof SchoologyError && e.status === 403) return [] as any[];
			throw e;
		}),
		list(`/sections/${sid}/assignments?with_attachments=1`, "assignment"),
		list(`/sections/${sid}/pages?withcontent=1`, "page"),
		list(`/sections/${sid}/documents`, "document"),
		list(`/sections/${sid}/discussions?with_attachments=1`, "discussion"),
		list(`/sections/${sid}/updates?with_attachments=1`, "update"),
		list(`/sections/${sid}/events`, "event"),
	]);
	log(
		`  ${label}: ${assignments.length} assignments, ${pages.length} pages, ${documents.length} documents, ` +
			`${discussions.length} discussions, ${updates.length} updates, ${events.length} events`,
	);

	await store.writeJson(
		`${dir}/section.json`,
		compact({
			...pick(section, ["id", "course_id", "course_title", "section_title"]),
			grading_periods: periods.map((p: any) => pick(p, ["title", "start", "end"])),
		}),
	);

	// Schoology's files fill in over runs: every item is written each run (fields, its
	// files' metadata, a `url` to its page), but at most FILES_PER_RUN new files are
	// downloaded from Schoology, in the order the website lists them (Drive links are
	// Google's, and sync as usual). A class's few new files a week come right away; a
	// club's shelf of 166 PDFs trickles in without hammering Schoology. Your own
	// submissions don't wait. Files already archived are never refetched, so they don't count.
	let budget = FILES_PER_RUN;
	let deferred = 0;
	const take = (always = false) => always || budget-- > 0 || (deferred++, false);

	// what was here last run, by type:id, so new things get noted even if they also moved
	const before = new Set<string>();
	const walkMd = async (rel: string) => {
		for (const e of await readdir(store.abs(rel), { withFileTypes: true }).catch(() => [])) {
			if (e.isDirectory()) await walkMd(`${rel}/${e.name}`);
			else if (e.name.endsWith(".md")) {
				const meta = (await store.readDoc(`${rel}/${e.name}`))?.meta;
				if (meta?.id) before.add(`${meta.type}:${meta.id}`);
			}
		}
	};
	await walkMd(dir);
	const firstSeen = (type: string, id: unknown) => before.size > 0 && !before.has(`${type}:${id}`);

	// files already archived anywhere in this section, so moving an item between folders
	// doesn't mean downloading its files again
	const known = await files.scan(dir);
	/** false when the file isn't archived (too big, failed, or waiting for a later run) */
	const linkFile = async (rel: string, file: any, always = false): Promise<boolean> => {
		const size = Number(file.filesize) || 0;
		if (size > MAX_FILE_BYTES) {
			log(`  skipping ${file.filename} (${mb(size)} > MAX_FILE_MB)`);
			return false;
		}
		const name = rel.slice(rel.lastIndexOf("/") + 1);
		return files.link(
			rel,
			async () => (file.download_path && take(always) ? await sc.download(file.download_path) : null),
			known.get(`${name}\0${size}`),
			{ type: "file", id: file.id },
		);
	};
	/**
	 * An item's files next to it in `<base>.attachments/`: Schoology's own attachments, then
	 * whatever its Drive links (attached, or in the body) point at. Returns the `drive`
	 * frontmatter entry: which link became which file or folder.
	 */
	const linkAttachments = async (base: string, raw: any, html?: string) => {
		const name = namer();
		const own: any[] = raw?.files?.file ?? [];
		const ownNames = own.map((f) => name(f.filename || f.title || String(f.id)));
		await pool(own, 3, (f, i) => linkFile(`${base}.attachments/${ownNames[i]}`, f));

		const urls = [...(raw?.links?.link ?? []).map((l: any) => l.url), ...driveLinksIn(html)];
		const refs = new Map<string, { url: string; ref: DriveRef }>();
		for (const url of urls) {
			const ref = url && parseDriveUrl(url);
			if (ref && !refs.has(`${ref.kind}:${ref.id}`)) refs.set(`${ref.kind}:${ref.id}`, { url, ref });
		}
		if (!refs.size) return undefined;
		const previous = new Map<string, string>(
			((await store.readDoc(`${base}.md`))?.meta.drive ?? []).map((d: any) => [d.url, d.file]),
		);
		const drive = [];
		for (const { url, ref } of refs.values()) {
			const file = await syncDrive(
				{ store, files, google: await google() },
				ref,
				`${base}.attachments`,
				name,
				previous.get(url),
			);
			drive.push(compact({ url, file }));
		}
		return drive;
	};
	const writeComments = async (base: string, path: string) => {
		const comments = await list(path, "comment");
		if (comments.length) await store.writeJson(`${base}.comments.json`, trimComments(comments));
	};

	// — materials: the folder tree, each item written where the website shows it
	const byType: Record<string, Map<string, any>> = {
		assignment: new Map(assignments.map((a) => [String(a.id), a])),
		page: new Map(pages.map((p) => [String(p.id), p])),
		document: new Map(documents.map((d) => [String(d.id), d])),
		discussion: new Map(discussions.map((d) => [String(d.id), d])),
	};
	const kindOf = (treeType: string) => (/^assessment/.test(treeType) ? "assignment" : treeType);
	const placed = new Set<string>();

	const writeItem = async (folder: string, name: Namer, type: string, obj: any) => {
		placed.add(`${type}:${obj.id}`);
		if (firstSeen(type, obj.id) && (type === "assignment" || type === "page"))
			ctx.note(`new ${type} in ${course}: ${obj.title}`);

		// a document that is only a single file is that file (until it's archived: an item
		// like any other, with the file's metadata and a url)
		const docFiles = obj.attachments?.files?.file ?? [];
		if (type === "document" && docFiles.length === 1 && !obj.attachments?.links?.link?.length) {
			const f = docFiles[0];
			const ext = extOf(f.filename);
			const title: string = obj.title ?? "";
			const stem =
				ext && title.toLowerCase().endsWith(ext.toLowerCase()) ? title.slice(0, -ext.length) : title;
			if (await linkFile(`${folder}/${name(stem || f.filename, ext)}`, f)) return;
		}

		const base = `${folder}/${name(obj.title)}`;
		const meta: Record<string, unknown> = compact({
			type,
			id: obj.id,
			...pick(obj, FIELDS[type] ?? ["title"]),
			attachments: attachments(obj.attachments),
			url: webUrl(sid, type, obj.id),
		});
		if (type === "assignment" && Number(obj.allow_dropbox) && obj.grade_item_id) {
			// your own submission history
			const revisions = await orEmpty<any>(
				sc
					.get(`/sections/${sid}/submissions/${obj.grade_item_id}/${uid}?with_attachments=1`)
					.then((r) => r.revision ?? []),
			);
			const subName = namer();
			const subs = [];
			for (const r of revisions) {
				const names: string[] = [];
				for (const f of r.attachments?.files?.file ?? []) {
					const n = subName(`${r.created ? `${stamp(r.created)} ` : ""}${f.filename || f.title || f.id}`);
					names.push(n);
					await linkFile(`${base}.submissions/${n}`, f, true);
				}
				subs.push(compact({ ...pick(r, ["revision_id", "created", "late", "draft", "body"]), files: names }));
			}
			if (subs.length) meta.submissions = subs;
		}
		const drive = await linkAttachments(base, obj.attachments, obj.description ?? obj.body);
		await store.writeDoc(`${base}.md`, compact({ ...meta, drive }), md(obj.description ?? obj.body));
		if (type === "discussion") await writeComments(base, `/sections/${sid}/discussions/${obj.id}/comments`);
	};

	const writeFolder = async (folder: string, items: any[]): Promise<Namer> => {
		const name = namer();
		for (const it of items) {
			if (it.type === "folder") {
				await writeFolder(`${folder}/${name(it.title)}`, it.children ?? []);
				continue;
			}
			const type = kindOf(it.type);
			const obj = byType[type]?.get(String(it.id));
			if (obj) await writeItem(folder, name, type, obj);
			else {
				// something the lists don't cover (external tool, SCORM, …): keep what the tree says
				placed.add(`${type}:${it.id}`);
				await store.writeDoc(
					`${folder}/${name(it.title)}.md`,
					pick(it, ["type", "id", "title"]),
					md(it.body),
				);
			}
		}
		return name;
	};
	const rootName = await writeFolder(`${dir}/materials`, tree);
	// items in no folder (hidden from the tree, or listed at the top level)
	for (const [type, map] of Object.entries(byType))
		for (const obj of map.values())
			if (!placed.has(`${type}:${obj.id}`)) await writeItem(`${dir}/materials`, rootName, type, obj);

	// — updates
	const updateName = namer();
	for (const u of updates) {
		const base = `${dir}/updates/${updateName(stamp(u.created))}`;
		if (firstSeen("update", u.id)) ctx.note(`new update in ${course}`);
		const drive = await linkAttachments(base, u.attachments, u.body);
		await store.writeDoc(
			`${base}.md`,
			compact({
				type: "update",
				id: u.id,
				...pick(u, ["uid", "created", "last_updated", "poll"]),
				attachments: attachments(u.attachments),
				drive,
				url: webUrl(sid, "update", u.id),
			}),
			md(u.body),
		);
		if (Number(u.num_comments) > 0) await writeComments(base, `/sections/${sid}/updates/${u.id}/comments`);
	}

	// — events (assignment due dates show up as events too; those live on the assignments)
	const eventName = namer();
	for (const e of events)
		if (!e.assignment_id && !["assignment", "assessment", "discussion"].includes(e.type))
			await store.writeDoc(
				`${dir}/events/${eventName(`${String(e.start ?? "").slice(0, 10)} ${e.title}`)}.md`,
				compact({ type: "event", id: e.id, ...pick(e, ["title", "start", "end", "all_day"]) }),
				md(e.description),
			);

	if (deferred) log(`  ${label}: ${deferred} new files left for later runs (SCHOOLOGY_FILES_PER_RUN)`);
	store.complete(dir);
};

await track("schoology", async (ctx) => {
	const sc = createSchoology({
		consumerKey: need("SCHOOLOGY_CONSUMER_KEY"),
		consumerSecret: need("SCHOOLOGY_CONSUMER_SECRET"),
		// two-legged: Schoology's three-legged flow is broken for new tokens (see login.ts)
		// tokenKey: need("SCHOOLOGY_TOKEN_KEY"),
		// tokenSecret: need("SCHOOLOGY_TOKEN_SECRET"),
	});
	const { store } = ctx;
	setPhase("looking up user");
	const me = await sc.get("/users/me");
	const uid = String(me.uid ?? me.id);
	const sections: Section[] = await sc.all(`/users/${uid}/sections`, "section");
	log(`${sections.length} active sections`);
	// the browser is only touched if some item actually links to Drive
	let session: Promise<Google | null> | undefined;
	const google = () => (session ??= openGoogle());

	// where each section id lives now, so a renamed section's directory moves instead of forking
	const existing = new Map<string, string>();
	for (const year of await readdir(store.root).catch(() => [] as string[]))
		for (const name of await readdir(store.abs(year)).catch(() => [] as string[])) {
			const s = await store.readJson(`${year}/${name}/section.json`);
			if (s?.id) existing.set(String(s.id), `${year}/${name}`);
		}

	const tick = counter(sections.length, "sections");
	const inFlight = new Set<string>();
	const showPhase = () => setPhase(`archiving ${[...inFlight].join(", ") || "sections"}`);
	const taken = new Set<string>();
	await pool(sections, 3, async (s) => {
		inFlight.add(s.course_title);
		showPhase();
		try {
			const periods = await orEmpty(sc.all(`/sections/${s.id}/grading_periods`, "grading_period"));
			let dir = `${yearDir(periods)}/${sectionName(s)}`;
			if (taken.has(dir)) dir += `-${s.id}`;
			taken.add(dir);
			const prev = existing.get(String(s.id));
			if (prev && prev !== dir && (await store.move(prev, dir))) log(`  moved ${prev} → ${dir}`);
			await archiveSection(ctx, sc, google, uid, s, dir, periods);
			tick(`${s.course_title} done`);
		} catch (e) {
			tick(`${s.course_title} FAILED`);
			ctx.warn(`section ${s.id} (${s.course_title}): ${(e as Error).message}`);
		} finally {
			inFlight.delete(s.course_title);
			showPhase();
		}
	});
});
