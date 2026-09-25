/**
 * Google Sites → life/sites/, one directory per site, laid out like the site's own nav:
 *
 *   <Site title>/Home.md                         page text as markdown; frontmatter: url, title,
 *   <Site title>/Units/Unit 3.md                 and which image/Drive link became which file
 *   <Site title>/Units/Unit 3.images/01.jpg      images the site hosts, original size, page order
 *   <Site title>/Units/Unit 3.attachments/…      embedded or linked Drive files and folders
 *
 * Config is just start URLs: GOOGLE_SITES=https://sites.google.com/view/x,https://…
 * Pages come from the site's nav plus in-site links found on pages (hidden pages).
 * Public sites are fetched directly; a site that sends us to Google sign-in (district
 * sites) is fetched with the browser session Drive uses (see lib/google/browser.ts).
 */

import { lstat, lutimes, readdir } from "node:fs/promises";
import { need, optional, recheckMs } from "../../lib/env.ts";
import { pool } from "../../lib/http.ts";
import { log, setPhase, stats } from "../../lib/log.ts";
import { htmlToMarkdown } from "../../lib/markdown.ts";
import { EXT, TIMEOUT_MS, decode, embedsToLinks, fetchPage, unslug } from "../../lib/page.ts";
import { compact } from "../../lib/pick.ts";
import { namer, safeName } from "../../lib/store.ts";
import { openGoogle, type Google } from "../../lib/google/browser.ts";
import { driveLinksIn, parseDriveUrl, unwrapRedirects, type DriveRef } from "../../lib/google/drive.ts";
import { syncDrive } from "../../lib/google/sync.ts";
import { track, type Context } from "../../lib/track.ts";

const MAX_PAGES = Number(optional("SITES_MAX_PAGES") ?? 300);
const MAX_BYTES = Number(optional("MAX_FILE_MB") ?? 250) * 1024 * 1024;
// images and Drive files are fetched again at most this often (unchanged bytes make no diff)
const RECHECK_MS = recheckMs("SITES", 14 * 24);

class NeedsSignIn extends Error {}

// ———————————————————————————————————— fetching

/** fetch that notices Google's sign-in wall and switches to the browser session for it */
const fetcher = () => {
	let session: Promise<Google> | undefined;
	const google = () => (session ??= openGoogle());
	const authed = new Set<string>(); // sites (by root) that needed the session
	const plain = (url: string) => fetchPage(url, (u) => u.hostname === "accounts.google.com");
	return {
		get: async (url: string, root: string, init: { maxBytes?: number } = {}): Promise<Response> => {
			let res = authed.has(root) ? null : await plain(url);
			if (!res) {
				authed.add(root);
				const g = await google();
				if (g.anonymous) throw new NeedsSignIn(`${root} needs a Google sign-in (run pnpm google:login)`);
				res = await g.fetch(url, { ...init, timeoutMs: TIMEOUT_MS });
				if (!res) throw new NeedsSignIn(`${root}: this account can't see it (or the sign-in lapsed)`);
			}
			if (!res.ok) {
				await res.body?.cancel();
				throw new Error(`HTTP ${res.status} for ${new URL(url).pathname}`);
			}
			return res;
		},
		google,
	};
};

// ———————————————————————————————————— reading a Sites page

/** the site's root URL: sites.google.com/view/<name> or /<domain>/<name>; a custom domain's origin */
const siteRoot = (url: URL) => {
	if (url.hostname !== "sites.google.com") return url.origin;
	const [a, b] = url.pathname.split("/").filter(Boolean);
	return `${url.origin}/${a}/${b}`;
};

/** nav entries: path → { title, level } (desktop and mobile navs list the same pages) */
const navOf = (html: string, root: string) => {
	const rootPath = new URL(root).pathname.replace(/\/$/, "");
	const nav = new Map<string, { title: string; level: number }>();
	for (const m of html.matchAll(/<a\b[^>]*\bdata-url="([^"]+)"[^>]*\bdata-level="(\d+)"[^>]*>([^<]*)</g)) {
		const path = decode(m[1]).replace(/\/$/, "");
		if (!path.startsWith(rootPath) || nav.has(path)) continue;
		nav.set(path, { title: decode(m[3]).trim(), level: Number(m[2]) });
	}
	return nav;
};

/** top-level <section>s: where a Sites page's content lives (header banner included) */
const sectionsOf = (html: string) => {
	const out: string[] = [];
	const re = /<(\/?)section\b[^>]*>/g;
	let depth = 0;
	let start = -1;
	for (let m; (m = re.exec(html));) {
		if (!m[1]) {
			if (depth++ === 0) start = m.index;
		} else if (--depth === 0) out.push(html.slice(start, re.lastIndex));
	}
	return out.join("\n");
};

const pageTitle = (html: string) => {
	const t = decode(/<title>([^<]*)<\/title>/.exec(html)?.[1] ?? "").trim();
	const i = t.lastIndexOf(" - ");
	return { site: i > 0 ? t.slice(0, i) : t, page: i > 0 ? t.slice(i + 3) : t };
};

/** images the site hosts: uploads on googleusercontent, and sitesv-images-rt (signed per load) */
const isSiteImage = (src: string) =>
	/^https:\/\/[a-z0-9-]+\.googleusercontent\.com\//.test(src) ||
	src.startsWith("https://sites.google.com/sitesv-images-rt/");
/** the same image at another size is the same image (within one page load) */
const imageKey = (src: string) => src.replace(/=[a-z0-9-]+$/i, "");
/** URLs to try, best first: `=s0` is the upload as-is (for plain uploads); images Sites
 * copied from Docs (/docsubipk/) or proxies (/proxy/) only work as the page had them */
const imageCandidates = (src: string) => [...new Set([`${imageKey(src)}=s0`, src])];

// ———————————————————————————————————— archiving a site

type Page = { url: string; path: string };

const archiveSite = async (ctx: Context, http: ReturnType<typeof fetcher>, start: string) => {
	const { store, files } = ctx;
	const root = siteRoot(new URL(start));
	const rootPath = new URL(root).pathname.replace(/\/$/, "");
	setPhase(`reading ${root}`);
	const first = await (await http.get(start, root)).text();
	const nav = navOf(first, root);
	const siteTitle = pageTitle(first).site || rootPath.split("/").pop() || new URL(root).hostname;
	const dir = safeName(siteTitle);
	log(`  ${siteTitle}: ${nav.size} pages in the nav`);

	// what we knew last run: page url → its doc, to reuse image/Drive names and note changes
	const previous = new Map<string, { rel: string; meta: any; body: string }>();
	const walk = async (rel: string): Promise<void> => {
		for (const e of await readdir(store.abs(rel), { withFileTypes: true }).catch(() => [])) {
			if (e.isDirectory()) await walk(`${rel}/${e.name}`);
			else if (e.name.endsWith(".md")) {
				const d = await store.readDoc(`${rel}/${e.name}`);
				if (d?.meta.url) previous.set(d.meta.url, { rel: `${rel}/${e.name}`, ...d });
			}
		}
	};
	await walk(dir);
	const firstRunOfSite = previous.size === 0;

	/** a page's file path from its URL path, with nav titles for every level we know */
	const relFor = (path: string) => {
		const segs = path.slice(rootPath.length).split("/").filter(Boolean);
		if (!segs.length) segs.push("home");
		const names = segs.map((seg, i) => {
			const known = nav.get(`${rootPath}/${segs.slice(0, i + 1).join("/")}`)?.title;
			return safeName(known || unslug(decodeURIComponent(seg)));
		});
		return `${dir}/${names.join("/")}`;
	};

	const queue: Page[] = [];
	const seen = new Set<string>();
	const enqueue = (href: string) => {
		let url: URL;
		try {
			url = new URL(decode(href), root);
		} catch {
			return;
		}
		url.hash = "";
		url.search = "";
		const path = url.pathname.replace(/\/$/, "");
		if (url.origin !== new URL(root).origin || !(path === rootPath || path.startsWith(`${rootPath}/`)))
			return;
		if (/\.[a-z0-9]{2,5}$/i.test(path)) return; // files the site serves, not pages
		if (path === rootPath && nav.size) return; // the root is the home page, which the nav lists
		if (seen.has(path) || seen.size >= MAX_PAGES) return;
		seen.add(path);
		queue.push({ url: url.href, path });
	};
	enqueue(start);
	for (const path of nav.keys()) enqueue(path);

	let done = 0;
	const tick = (title: string) => log(`  [${++done} pages] ${title}`);
	let failed = 0;
	const archivePage = async (page: Page) => {
		const html = page.url === start ? first : await (await http.get(page.url, root)).text();
		for (const m of html.matchAll(/href="([^"]+)"/g)) enqueue(m[1]);
		const rel = relFor(page.path);
		const prev = previous.get(page.url);
		const title = nav.get(page.path)?.title || pageTitle(html).page;

		let body = unwrapRedirects(sectionsOf(html)).replace(/<(script|style)\b[\s\S]*?<\/\1>/g, "");
		body = embedsToLinks(body);

		// images the site itself hosts: original size, in page order, next to the page.
		// Their URLs aren't stable (some are signed per page load, others change over time),
		// so they're not recorded: an image is its content (the blob it links to), and the
		// frontmatter lists just the files in page order, null for images broken on the site.
		const imgs: string[] = [];
		const indexOf = new Map<string, number>();
		for (const m of body.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)) {
			const src = decode(m[1]);
			if (!isSiteImage(src) || indexOf.has(imageKey(src))) continue;
			indexOf.set(imageKey(src), imgs.length);
			imgs.push(src);
		}
		const imagesRel = `${rel}.images`;
		const width = Math.max(2, String(imgs.length).length);
		const imageFiles: (string | null)[] = imgs.map(() => null);
		const prevList: (string | null)[] = Array.isArray(prev?.meta.images) ? prev!.meta.images : [];
		const prevPath = (file: string) => `${prev!.rel.slice(0, -3)}.images/${file}`;
		// while the page has as many images as last run, reuse them by position; every
		// RECHECK_MS fetch them all again (unchanged bytes → same blobs → no diff). The time of
		// the last full fetch is the page .md's own mtime (local state, never in git).
		const checked = prev ? (await lstat(store.abs(prev.rel)).catch(() => null))?.mtimeMs : undefined;
		const recent = checked !== undefined && Date.now() - checked < RECHECK_MS;
		const reused =
			recent && prevList.length === imgs.length
				? await Promise.all(prevList.map((f) => (f ? store.readLinkTarget(prevPath(f)) : "broken")))
				: null;
		let fullPass = false;
		if (reused?.every(Boolean)) {
			for (const [i, f] of prevList.entries())
				if (f) {
					await store.link(`${imagesRel}/${f}`, reused[i]!);
					imageFiles[i] = f;
				}
		} else {
			fullPass = true;
			await pool(imgs, 3, async (src, i) => {
				const n = String(i + 1).padStart(width, "0");
				let error: unknown;
				const kept = prevList.length === imgs.length ? prevList[i] : null;
				for (const [ci, candidate] of imageCandidates(src).entries()) {
					// only the best source may replace what we have: when full size fails and we'd
					// fall back to the page's smaller copy, keep last run's instead of flapping
					if (ci > 0 && kept) break;
					try {
						const res = await http.get(candidate, root, { maxBytes: MAX_BYTES });
						const file = `${n}${EXT[(res.headers.get("content-type") ?? "").split(";")[0]] ?? ""}`;
						const bytes = new Uint8Array(await res.arrayBuffer());
						stats.downloads++;
						stats.downloadedBytes += bytes.byteLength;
						await store.link(`${imagesRel}/${file}`, await store.blob(bytes));
						imageFiles[i] = file;
						return;
					} catch (e) {
						error = e;
					}
				}
				// Google sometimes 404s an image one load and serves it the next: if we had it at
				// this position last run, keep that copy rather than flap
				const keptBlob = kept ? await store.readLinkTarget(prevPath(kept)) : null;
				if (kept && keptBlob) {
					await store.link(`${imagesRel}/${kept}`, keptBlob);
					imageFiles[i] = kept;
					return;
				}
				// 403/404/no answer: broken on the site itself (e.g. copied from a Doc since deleted)
				const status = /HTTP \d+/.exec((error as Error).message)?.[0] ?? "no answer";
				log(`  ${title}: image ${i + 1} is broken on the site (${status})`);
			});
		}
		const imagesDir = encodeURI(`${rel.split("/").pop()}.images`)
			.replace(/\(/g, "%28")
			.replace(/\)/g, "%29");
		body = body.replace(/<img\b[^>]*\bsrc="([^"]+)"[^>]*>/g, (m, src) => {
			const i = indexOf.get(imageKey(decode(src)));
			if (i === undefined) return m; // hotlinked from elsewhere: keep the URL
			// the site's own images: our copy, or (broken on the site) no URL, which would churn
			return imageFiles[i]
				? `<img src="${imagesDir}/${imageFiles[i]}">`
				: `<img src="" alt="image unavailable on the site">`;
		});
		const md = htmlToMarkdown(body, "https://sites.google.com");

		// Drive files the page embeds or links, next to it (as for Schoology items). Read
		// from the HTML: markdown escapes "_" in URLs, which Drive ids are full of.
		const refs = new Map<string, { url: string; ref: DriveRef }>();
		for (const raw of driveLinksIn(body)) {
			const url = raw.replace(/&amp;/g, "&");
			const ref = parseDriveUrl(url);
			if (ref && !refs.has(ref.id)) refs.set(ref.id, { url, ref });
		}
		const drive = [];
		if (refs.size) {
			const prevDrive = new Map<string, string>((prev?.meta.drive ?? []).map((d: any) => [d.url, d.file]));
			const names = namer();
			const google = await http.google();
			for (const { url, ref } of refs.values()) {
				const file = await syncDrive(
					{ store, files, google, recheckMs: RECHECK_MS },
					ref,
					`${rel}.attachments`,
					names,
					prevDrive.get(url),
				);
				drive.push(compact({ url, file }));
			}
		}

		const meta = compact({
			type: "page",
			url: page.url,
			title,
			images: imageFiles,
			drive,
		});
		if (!firstRunOfSite && !prev) ctx.note(`new page on ${siteTitle}: ${title}`);
		else if (prev && prev.body !== md.trim()) ctx.note(`updated on ${siteTitle}: ${title}`);
		await store.writeDoc(`${rel}.md`, meta, md);
		// the .md's mtime says when its images were last all fetched (see above)
		const at = fullPass ? new Date() : new Date(checked!);
		await lutimes(store.abs(`${rel}.md`), at, at).catch(() => {});
		tick(title);
	};

	// the queue grows as pages reveal links; drain it a few at a time
	for (let i = 0; i < queue.length;) {
		const batch = queue.slice(i, i + 4);
		i += batch.length;
		await Promise.all(
			batch.map((p) =>
				archivePage(p).catch((e) => {
					if (e instanceof NeedsSignIn) throw e;
					failed++;
					ctx.warn(`${siteTitle}: ${p.path}: ${(e as Error).message}`);
				}),
			),
		);
	}
	log(`  ${siteTitle}: ${queue.length - failed}/${queue.length} pages archived`);
	if (!failed) store.complete(dir);
};

await track("sites", async (ctx) => {
	const starts = need("GOOGLE_SITES")
		.split(/[\s,]+/)
		.filter(Boolean);
	const http = fetcher();
	for (const start of starts) {
		try {
			await archiveSite(ctx, http, start);
		} catch (e) {
			ctx.warn(`${start}: ${(e as Error).message}`);
		}
	}
});
