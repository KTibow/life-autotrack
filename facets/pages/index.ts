/**
 * Single web pages → life/pages/, one file per URL, laid out by the site's own path:
 *
 *   <site>/<path segments>.md         page text as markdown; frontmatter: url, title, and
 *                                     which image link became which file
 *   <site>/<path segments>.images/    every image the page shows, in page order
 *   <site>/<path segments>.attachments/…   Drive files and folders the page links
 *
 * Config is just URLs: PAGES=https://example.org/a/b,https://… Google Sites are their
 * own facet (GOOGLE_SITES); anything else a browser can read works here. Pages are
 * re-read every run; their images are fetched again only every DRIVE_RECHECK_HOURS
 * (unchanged bytes are the same blobs, so nothing churns).
 */

import { lstat, lutimes, readdir } from "node:fs/promises";
import { need } from "../../lib/env.ts";
import { pool } from "../../lib/http.ts";
import { counter, log, setPhase, stats } from "../../lib/log.ts";
import { htmlToMarkdown } from "../../lib/markdown.ts";
import { EXT, contentOf, decode, embedsToLinks, fetchPage, RECHECK_MS, unslug } from "../../lib/page.ts";
import { compact } from "../../lib/pick.ts";
import { namer, safeName } from "../../lib/store.ts";
import { openGoogle, type Google } from "../../lib/google/browser.ts";
import { driveLinksIn, parseDriveUrl, unwrapRedirects, type DriveRef } from "../../lib/google/drive.ts";
import { syncDrive } from "../../lib/google/sync.ts";
import { track, type Context } from "../../lib/track.ts";

/** the site's directory: its hostname (www. is the same site) */
const hostDir = (url: URL) => safeName(url.hostname.replace(/^www\./, ""));

/** a page's file path from its URL: the site's own path, dashes as the spaces they stand for */
const relFor = (url: URL) => {
	const segs = url.pathname
		.split("/")
		.filter(Boolean)
		.map((seg) => {
			try {
				seg = decodeURIComponent(seg);
			} catch {}
			return safeName(unslug(seg));
		});
	if (!segs.length) segs.push("home");
	return `${hostDir(url)}/${segs.join("/")}`;
};

/** the page's title as the page names itself: og:title, else the <title> tag */
const titleOf = (html: string) => {
	const og = /<meta\b[^>]*\bog:title\b[^>]*>/.exec(html)?.[0];
	return (
		decode(/\bcontent="([^"]*)"/.exec(og ?? "")?.[1] ?? "").trim() ||
		decode(/<title>([^<]*)<\/title>/.exec(html)?.[1] ?? "").trim()
	);
};

/** an image tag's URL, resolved against the page: its src, else its data-src when lazy,
 *  else the largest size in data-image-sizes (Finalsite fills src from it with JavaScript) */
const imgSrc = (tag: string, page: URL) => {
	const attr = (name: string) => decode(new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1] ?? "").trim();
	const resolve = (src: string) => {
		if (!src || src.startsWith("data:")) return undefined;
		try {
			return new URL(src, page).href;
		} catch {
			return undefined;
		}
	};
	const direct = resolve(attr("src") || attr("data-src"));
	if (direct) return direct;
	try {
		const sizes: { url?: string; width?: number }[] = JSON.parse(
			attr("data-image-sizes").replace(/%22/g, '"'),
		);
		const best = sizes.filter((s) => s.url).sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0];
		return best?.url ? resolve(best.url) : undefined;
	} catch {
		return undefined;
	}
};

const archivePage = async (ctx: Context, start: URL, google: () => Promise<Google>) => {
	const { store, files } = ctx;
	if (start.hostname === "sites.google.com")
		throw new Error("a Google Site: list it in GOOGLE_SITES (pnpm sites) instead");
	const host = hostDir(start);
	const rel = relFor(start);
	setPhase(`reading ${start.hostname}${start.pathname}`);
	const res = await fetchPage(start.href);
	if (!res?.ok) {
		await res?.body?.cancel();
		throw new Error(`HTTP ${res?.status ?? "no answer"} for ${start.pathname}`);
	}
	const type = res.headers.get("content-type") ?? "";
	if (type && !/html/i.test(type)) {
		await res.body?.cancel();
		throw new Error(`not a web page (${type.split(";")[0]})`);
	}
	const html = await res.text();
	const title = titleOf(html) || rel.split("/").pop()!;

	// what we knew last run: page url → its doc, to reuse image/Drive names and note changes
	const previous = new Map<string, { rel: string; meta: any; body: string }>();
	const walk = async (dir: string): Promise<void> => {
		for (const e of await readdir(store.abs(dir), { withFileTypes: true }).catch(() => [])) {
			if (e.isDirectory()) await walk(`${dir}/${e.name}`);
			else if (e.name.endsWith(".md")) {
				const d = await store.readDoc(`${dir}/${e.name}`);
				if (d?.meta.url) previous.set(d.meta.url, { rel: `${dir}/${e.name}`, ...d });
			}
		}
	};
	await walk(host);
	const prev = previous.get(start.href);

	let body = embedsToLinks(unwrapRedirects(contentOf(html)));

	// every image the page shows, whatever host it's on: next to the page, in page order.
	// Their URLs are stable but their content isn't, so they're re-fetched every
	// RECHECK_MS; the time of the last full fetch is the page .md's own mtime (local
	// state, never in git), exactly as for a Sites page.
	const imgs: string[] = [];
	const indexOf = new Map<string, number>();
	for (const m of body.matchAll(/<img\b[^>]*>/g)) {
		const href = imgSrc(m[0], start);
		if (!href || indexOf.has(href)) continue;
		indexOf.set(href, imgs.length);
		imgs.push(href);
	}
	const imagesRel = `${rel}.images`;
	const width = Math.max(2, String(imgs.length).length);
	const imageFiles: (string | null)[] = imgs.map(() => null);
	const prevList: (string | null)[] = Array.isArray(prev?.meta.images) ? prev!.meta.images : [];
	const prevPath = (file: string) => `${prev!.rel.slice(0, -3)}.images/${file}`;
	const checked = prev ? (await lstat(store.abs(prev.rel)).catch(() => null))?.mtimeMs : undefined;
	const recent = checked !== undefined && Date.now() - checked < RECHECK_MS;
	// while the page has as many images as last run, reuse them by position
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
			const kept = prevList.length === imgs.length ? prevList[i] : null;
			try {
				const res = await fetchPage(src);
				if (!res?.ok) {
					await res?.body?.cancel();
					throw new Error(`HTTP ${res?.status ?? "no answer"}`);
				}
				const file = `${n}${EXT[(res.headers.get("content-type") ?? "").split(";")[0]] ?? ""}`;
				const bytes = new Uint8Array(await res.arrayBuffer());
				stats.downloads++;
				stats.downloadedBytes += bytes.byteLength;
				await store.link(`${imagesRel}/${file}`, await store.blob(bytes));
				imageFiles[i] = file;
				return;
			} catch (e) {
				// a host that 404s an image one load and serves it the next: if we had it at
				// this position last run, keep that copy rather than flap
				const keptBlob = kept ? await store.readLinkTarget(prevPath(kept)) : null;
				if (kept && keptBlob) {
					await store.link(`${imagesRel}/${kept}`, keptBlob);
					imageFiles[i] = kept;
					return;
				}
				const status = /HTTP \d+/.exec((e as Error).message)?.[0] ?? "no answer";
				log(`  ${title}: image ${i + 1} is broken on the page (${status})`);
			}
		});
	}
	const imagesDir = encodeURI(`${rel.split("/").pop()}.images`)
		.replace(/\(/g, "%28")
		.replace(/\)/g, "%29");
	body = body.replace(/<img\b[^>]*>/g, (tag) => {
		const i = indexOf.get(imgSrc(tag, start) ?? "");
		if (i === undefined) return tag; // inlined data or an unresolvable URL: keep the tag
		// our copy, or (broken on the page) no URL, which would churn
		return imageFiles[i]
			? `<img src="${imagesDir}/${imageFiles[i]}">`
			: `<img src="" alt="image unavailable on the page">`;
	});
	const md = htmlToMarkdown(body, start.origin);

	// Drive files the page embeds or links, next to it (as for Schoology items). Read from
	// the HTML: markdown escapes "_" in URLs, which Drive ids are full of.
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
		for (const { url, ref } of refs.values()) {
			const file = await syncDrive(
				{ store, files, google: await google() },
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
		url: start.href,
		title,
		images: imageFiles,
		drive,
	});
	if (!prev) ctx.note(`new page on ${host}: ${title}`);
	else if (prev.body !== md.trim()) ctx.note(`updated on ${host}: ${title}`);
	await store.writeDoc(`${rel}.md`, meta, md);
	// the .md's mtime says when its images were last all fetched (see above)
	const at = fullPass ? new Date() : new Date(checked!);
	await lutimes(store.abs(`${rel}.md`), at, at).catch(() => {});
};

await track("pages", async (ctx) => {
	const starts = need("PAGES")
		.split(/[\s,]+/)
		.filter(Boolean);
	const pages: URL[] = [];
	for (const start of starts) {
		try {
			pages.push(new URL(start));
		} catch {
			ctx.warn(`${start}: not a URL`);
		}
	}
	// the browser is only touched if some page actually links to Drive
	let session: Promise<Google> | undefined;
	const google = () => (session ??= openGoogle());

	const tick = counter(pages.length, "pages");
	const failed = new Set<string>();
	for (const url of pages) {
		try {
			await archivePage(ctx, url, google);
			tick(url.pathname);
		} catch (e) {
			failed.add(hostDir(url));
			ctx.warn(`${url.href}: ${(e as Error).message}`);
		}
	}
	// only a site whose every listed page was read this run loses files it no longer shows
	for (const url of pages) if (!failed.has(hostDir(url))) ctx.store.complete(hostDir(url));
});
