/**
 * `pnpm schoology:login`: get a fresh SCHOOLOGY_TOKEN_KEY / SCHOOLOGY_TOKEN_SECRET for the
 * app in SCHOOLOGY_CONSUMER_KEY / SCHOOLOGY_CONSUMER_SECRET, by Schoology's three-legged
 * OAuth: a request token, the authorize page opened in the Chromium profile (sign in and
 * click Approve there), then the access token, written into .env. Needs someone at the
 * machine's screen.
 */

import { createServer } from "node:http";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { need, optional, ROOT } from "../../lib/env.ts";
import { openWindow } from "../../lib/google/browser.ts";
import { log } from "../../lib/log.ts";
import { API, authorization, createSchoology, type SchoologyAuth } from "./client.ts";

const HOST = optional("SCHOOLOGY_HOST") ?? "app.schoology.com";
const consumer = {
	consumerKey: need("SCHOOLOGY_CONSUMER_KEY"),
	consumerSecret: need("SCHOOLOGY_CONSUMER_SECRET"),
};

/** a signed GET on an oauth endpoint; they answer form-encoded */
const tokenCall = async (path: string, auth: SchoologyAuth) => {
	const url = `${API}${path}`;
	const res = await fetch(url, { headers: { authorization: await authorization(auth, "GET", url) } });
	const body = new URLSearchParams(await res.text());
	const key = body.get("oauth_token");
	const secret = body.get("oauth_token_secret");
	if (!res.ok || !key || !secret) throw new Error(`Schoology ${res.status} on GET ${path}`);
	return { key, secret };
};

/** set KEY=value lines in .env, keeping everything else (and the file's mode) as it was */
const saveEnv = async (values: Record<string, string>) => {
	const file = resolve(ROOT, ".env");
	const text = await readFile(file, "utf8").catch(() => "");
	const mode = (await stat(file).catch(() => null))?.mode ?? 0o600;
	let lines = text.split("\n");
	if (lines.at(-1) === "") lines.pop();
	for (const [k, v] of Object.entries(values)) {
		const i = lines.findIndex((l) => l.startsWith(`${k}=`));
		if (i >= 0) lines[i] = `${k}=${v}`;
		else lines.push(`${k}=${v}`);
	}
	await writeFile(`${file}.tmp`, lines.join("\n") + "\n", { mode });
	await rename(`${file}.tmp`, file);
};

// 1. request token
const request = await tokenCall("/oauth/request_token", { ...consumer, tokenKey: "", tokenSecret: "" });

// 2. the person approves in the browser; Schoology then redirects to this local callback
const server = createServer();
const approved = new Promise<void>((done) =>
	server.on("request", (req, res) => {
		const token = new URL(req.url ?? "/", "http://localhost").searchParams.get("oauth_token");
		res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
		res.end(token === request.key ? "Approved. You can close this window." : "Waiting for approval…");
		if (token === request.key) done();
	}),
);
await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
const callback = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
const authorize =
	`https://${HOST}/oauth/authorize?oauth_token=${encodeURIComponent(request.key)}` +
	`&oauth_callback=${encodeURIComponent(callback)}`;

let browser: Awaited<ReturnType<typeof openWindow>>;
try {
	browser = await openWindow(authorize);
} catch (e) {
	console.log(`Couldn't open Chromium.\n${(e as Error).message}\n\nOr open this yourself:\n${authorize}`);
	server.close();
	process.exit(1);
}
log("  waiting for you to sign in and Approve in the Chromium window (up to 15 minutes, Ctrl-C to stop)…");
process.once("SIGINT", () => void browser.close().finally(() => process.exit(130)));
const timedOut = await Promise.race([
	approved.then(() => false),
	new Promise<boolean>((t) => setTimeout(() => t(true), 15 * 60_000).unref()),
]);
server.close();
await new Promise((r) => setTimeout(r, 1000)); // let the "Approved" page show
await browser.close();
if (timedOut) {
	console.log("Not approved within 15 minutes; the window was closed. Run `pnpm schoology:login` again.");
	process.exit(1);
}

// 3. access token, checked before it replaces the old one
const access = await tokenCall("/oauth/access_token", {
	...consumer,
	tokenKey: request.key,
	tokenSecret: request.secret,
});
const me = await createSchoology({ ...consumer, tokenKey: access.key, tokenSecret: access.secret }).get(
	"/users/me",
);
await saveEnv({ SCHOOLOGY_TOKEN_KEY: access.key, SCHOOLOGY_TOKEN_SECRET: access.secret });
console.log(`Signed in as ${me.name_display ?? me.uid}; the new token is in .env.`);
process.exit(0);
