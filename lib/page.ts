/**
 * Shared by the facets that archive web pages (Google Sites, single pages): a fetch that
 * follows redirects one hop at a time (so a wall mid-chain, like a sign-in, can be
 * noticed), reading a page's text, and the conventions both follow — embeds become links
 * under their label, images land next to the page numbered in page order.
 */

import { optional } from "./env.ts";
import { stats } from "./log.ts";

// a broken image can hang instead of failing; nothing a page serves should take longer
export const TIMEOUT_MS = 15_000;
// pages' images are fetched again at most this often (unchanged bytes make no diff)
export const RECHECK_MS = Number(optional("DRIVE_RECHECK_HOURS") ?? 12) * 3600_000;

/** fetch following redirects manually; `stop` ends the chase with null when a hop says to */
export const fetchPage = async (
	url: string,
	stop?: (url: URL) => boolean,
	timeoutMs = TIMEOUT_MS,
): Promise<Response | null> => {
	let current = new URL(url);
	for (let hop = 0; hop < 8; hop++) {
		stats.requests++;
		const res = await fetch(current, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
		const location = res.headers.get("location");
		if (res.status >= 300 && res.status < 400 && location) {
			await res.body?.cancel();
			current = new URL(location, current);
			if (stop?.(current)) return null;
			continue;
		}
		return res;
	}
	throw new Error("too many redirects");
};

export const decode = (s: string) =>
	s
		.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
		.replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");

/** a URL path segment as a name: dashes that separate words become spaces, "2026-27" keeps its */
export const unslug = (seg: string) => seg.replace(/(?<!\d)-|-(?!\d)/g, " ");

export const EXT: Record<string, string> = {
	"image/jpeg": ".jpg",
	"image/png": ".png",
	"image/gif": ".gif",
	"image/webp": ".webp",
	"image/svg+xml": ".svg",
};

/** embeds (Docs, Slides, Drive folders, YouTube, Forms, …) become links under their label */
export const embedsToLinks = (body: string) =>
	body.replace(
		/<iframe\b[^>]*?(?:aria-label="([^"]*)")?[^>]*?\b(?:data-src|src)="([^"]+)"[^>]*>(?:<\/iframe>)?/g,
		(_, label, src) => {
			// YouTube embeds carry a per-load encrypted embed_config: keep just the video
			const yt = /youtube(?:-nocookie)?\.com\/embed\/([\w-]{6,})/.exec(src);
			const href = yt ? `https://www.youtube.com/watch?v=${yt[1]}` : src;
			return `<p><a href="${href}">${label || "Embedded content"}</a></p>`;
		},
	);

/** a page's content: its <main> or <article>, else the <body>, minus the page furniture */
export const contentOf = (html: string) => {
	const element = (tag: string) => {
		const open = new RegExp(`<${tag}\\b[^>]*>`, "i").exec(html);
		const end = html.toLowerCase().lastIndexOf(`</${tag}>`);
		return open && open.index < end ? html.slice(open.index, end + tag.length + 3) : null;
	};
	// inside <main>/<article> the site chrome is already excluded, so everything in there is
	// content — including <header>s, which CMSes use for panel and section titles (Finalsite
	// wraps every tab panel's h2 in one). nav/header/footer/aside are furniture only in the
	// <body> fallback, where they're the chrome itself.
	const scoped = element("main") ?? element("article");
	const body = scoped ?? element("body") ?? html;
	const furniture = new RegExp(
		`<(script|style|noscript|template|svg${scoped ? "" : "|nav|header|footer|aside"})\\b[^>]*>([\\s\\S]*?)<\\/\\1>`,
		"gi",
	);
	let stripped = body;
	for (;;) {
		const pass = stripped.replace(furniture, "");
		if (pass === stripped) break;
		stripped = pass;
	}
	return stripped.replace(/<\/?(meta|link)\b[^>]*>/gi, "");
};
