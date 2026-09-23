/**
 * Build the site from ../life and mirror it to R2 under PUBLISH_PREFIX.
 *
 * - vite build → site/dist: index.html (data inlined, no-cache) + assets/* (hashed, immutable)
 * - sync: list the prefix, PUT only files whose md5 differs from the object's ETag,
 *   DELETE objects that no longer exist locally. Nothing outside the prefix is touched.
 * - `--dry` builds and reports what would change without writing to R2 (or, without R2
 *   credentials, just builds site/dist for a look)
 */

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { AwsClient } from "aws4fetch";
import { build } from "vite";
import { LIFE_DIR, need } from "../lib/env.ts";
import { pool } from "../lib/http.ts";
import { counter, log, mb } from "../lib/log.ts";
import { tryLock } from "../lib/lock.ts";

const dry = process.argv.includes("--dry");
const prefix = need("PUBLISH_PREFIX").replace(/^\/+|\/+$/g, "");
const dist = join(import.meta.dirname, "dist");

const TYPES: Record<string, string> = {
	html: "text/html; charset=utf-8",
	js: "text/javascript; charset=utf-8",
	css: "text/css; charset=utf-8",
	svg: "image/svg+xml",
	png: "image/png",
	jpg: "image/jpeg",
	webp: "image/webp",
	woff2: "font/woff2",
	json: "application/json",
	txt: "text/plain; charset=utf-8",
};
const typeOf = (path: string) => TYPES[path.split(".").pop()!.toLowerCase()] ?? "application/octet-stream";

const walk = async (dir: string): Promise<string[]> =>
	(
		await Promise.all(
			(await readdir(dir, { withFileTypes: true })).map((e) =>
				e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
			),
		)
	).flat();

const lock = await tryLock(join(LIFE_DIR, ".git", "autotrack", "publish.lock"));
if (!lock) {
	log("publish: already running, skipping");
	process.exit(0);
}

try {
	log(`publish: building site from ${LIFE_DIR}`);
	await build({ configFile: join(import.meta.dirname, "vite.config.ts"), logLevel: "warn" });

	const local = new Map<string, { path: string; md5: string }>();
	for (const path of await walk(dist)) {
		const key = `${prefix}/${relative(dist, path).split(sep).join("/")}`;
		local.set(key, {
			path,
			md5: createHash("md5")
				.update(await readFile(path))
				.digest("hex"),
		});
	}

	if (dry && !process.env.R2_BUCKET) {
		log(`publish: built ${local.size} files (no R2 credentials, so no diff against the bucket)`);
		process.exit(0);
	}
	const r2 = new AwsClient({
		accessKeyId: need("R2_ACCESS_KEY_ID"),
		secretAccessKey: need("R2_SECRET_ACCESS_KEY"),
		service: "s3",
		region: "auto",
	});
	const bucket = `https://${need("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com/${need("R2_BUCKET")}`;

	// what's there now (ListObjectsV2, paginated)
	log(`publish: built ${local.size} files, listing bucket under ${prefix}/`);
	const remote = new Map<string, string>();
	let token: string | undefined;
	do {
		const url = new URL(bucket);
		url.searchParams.set("list-type", "2");
		url.searchParams.set("prefix", `${prefix}/`);
		if (token) url.searchParams.set("continuation-token", token);
		const res = await r2.fetch(url);
		if (!res.ok) throw new Error(`R2 list → ${res.status}`);
		const xml = await res.text();
		for (const [, body] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
			const key = /<Key>([\s\S]*?)<\/Key>/.exec(body)?.[1];
			const etag = /<ETag>(?:&quot;|")?([^<&"]*)/.exec(body)?.[1];
			if (key) remote.set(key.replace(/&amp;/g, "&"), etag ?? "");
		}
		token = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1];
	} while (token);

	const puts = [...local].filter(([key, f]) => remote.get(key) !== f.md5);
	const deletes = [...remote.keys()].filter((key) => !local.has(key));
	log(
		`publish: ${puts.length} to upload, ${deletes.length} to delete, ${local.size - puts.length} unchanged`,
	);

	if (!dry) {
		// assets first, so a fresh index.html never references a missing bundle
		puts.sort(([a], [b]) => Number(a.endsWith(".html")) - Number(b.endsWith(".html")));
		const assets = puts.filter(([k]) => !k.endsWith(".html"));
		const pages = puts.filter(([k]) => k.endsWith(".html"));
		const uploaded = counter(puts.length, "uploaded");
		for (const batch of [assets, pages])
			await pool(batch, 8, async ([key, f]) => {
				const body = await readFile(f.path);
				const res = await r2.fetch(`${bucket}/${encodeURI(key)}`, {
					method: "PUT",
					headers: {
						"content-type": typeOf(key),
						"cache-control": key.includes("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
					},
					body,
				});
				if (!res.ok) throw new Error(`R2 PUT ${key} → ${res.status}`);
				uploaded(`${key.slice(prefix.length + 1)} (${mb(body.byteLength)})`);
			});
		await pool(deletes, 8, async (key) => {
			const res = await r2.fetch(`${bucket}/${encodeURI(key)}`, { method: "DELETE" });
			if (!res.ok && res.status !== 404) throw new Error(`R2 DELETE ${key} → ${res.status}`);
			log(`  deleted ${key.slice(prefix.length + 1)}`);
		});
		log(`publish: done → /${prefix}/`);
	}
} catch (e) {
	console.error("publish failed:", e);
	process.exitCode = 1;
} finally {
	await lock.release();
}
