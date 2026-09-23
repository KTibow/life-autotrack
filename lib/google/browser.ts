/**
 * A Google session borrowed from a real Chromium, so no OAuth app is needed and sign-in
 * (including 2FA) is just a person at the machine using the browser window.
 *
 * - CHROMIUM_PROFILE_DIR is a profile used only for this (never your daily one: Chromium
 *   won't start a second instance on a profile that's already open). It always runs with
 *   --password-store=basic, so its cookies don't depend on a desktop keyring and the
 *   directory can be copied between machines.
 * - CHROMIUM_COMMAND is how to start it: `chromium` (default) or, e.g.,
 *   `flatpak run org.chromium.Chromium` (then the profile dir must be one the sandbox can
 *   see, e.g. under ~/.var/app/org.chromium.Chromium/).
 * - The browser runs headed and is left open between runs: that keeps Google's rotating
 *   cookies fresh and gives 2FA prompts somewhere to appear. From cron, set DISPLAY (or
 *   WAYLAND_DISPLAY) in .env.
 * - We only read cookies over the DevTools protocol; all requests are plain fetch().
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { optional } from "../env.ts";
import { sleep } from "../http.ts";
import { log, logWarn, stats } from "../log.ts";

type Cookie = { name: string; value: string; domain: string; path: string };

const SIGN_IN = "https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fdrive.google.com%2F";

/** minimal DevTools protocol client over the browser-level websocket */
const cdp = async (wsUrl: string) => {
	const ws = new WebSocket(wsUrl);
	await new Promise((resolve, reject) => {
		ws.onopen = resolve;
		ws.onerror = () => reject(new Error("could not connect to Chromium's DevTools port"));
	});
	let nextId = 1;
	const pending = new Map<number, (msg: any) => void>();
	ws.onmessage = (e) => {
		const msg = JSON.parse(String(e.data));
		pending.get(msg.id)?.(msg);
		pending.delete(msg.id);
	};
	const send = (method: string, params: object = {}) =>
		new Promise<any>((resolve, reject) => {
			const id = nextId++;
			pending.set(id, (msg) =>
				msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result),
			);
			ws.send(JSON.stringify({ id, method, params }));
		});
	return { send, close: () => ws.close() };
};

/** the DevTools websocket of a Chromium already running on this profile, if any */
const running = async (profile: string): Promise<string | null> => {
	const file = join(profile, "DevToolsActivePort");
	if (!existsSync(file)) return null;
	const [port, path] = (await readFile(file, "utf8")).split("\n");
	try {
		await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
		return `ws://127.0.0.1:${port}${path}`;
	} catch {
		return null;
	}
};

const launch = async (profile: string): Promise<string> => {
	await mkdir(profile, { recursive: true });
	await rm(join(profile, "DevToolsActivePort"), { force: true });
	const [cmd, ...args] = (optional("CHROMIUM_COMMAND") ?? "chromium").split(/\s+/);
	// Chromium's own output goes here, so a failed start can say why
	const logFile = join(profile, "life-autotrack-chromium.log");
	const out = openSync(logFile, "w");
	log(`  starting Chromium (${cmd}) on ${profile}`);
	const child = spawn(
		cmd,
		[
			...args,
			`--user-data-dir=${profile}`,
			"--remote-debugging-port=0",
			"--password-store=basic",
			"--no-first-run",
			"--no-default-browser-check",
			"https://drive.google.com/",
		],
		{ detached: true, stdio: ["ignore", out, out] },
	);
	closeSync(out);
	let exited: string | undefined;
	child.on("error", (e) => (exited = `could not run "${cmd}": ${e.message}`));
	child.on("exit", (code, signal) => (exited = `exited right away (${signal ?? `code ${code}`})`));
	child.unref(); // left running on purpose: see the header comment
	for (let i = 0; i < 60 && !exited; i++) {
		await sleep(500);
		const ws = await running(profile);
		if (ws) return ws;
	}
	const tail = (await readFile(logFile, "utf8").catch(() => ""))
		.split("\n")
		.filter((l) => l.trim())
		.slice(-6)
		.join("\n    ");
	const hints = [
		!process.env.DISPLAY &&
			!process.env.WAYLAND_DISPLAY &&
			"no DISPLAY/WAYLAND_DISPLAY in the environment (set DISPLAY=:0 in .env)",
		existsSync(join(profile, "SingletonLock")) &&
			"this profile is already open in another Chromium started without the debugging port (close that window)",
		process.getuid?.() === 0 && "running as root: Chromium needs --no-sandbox in CHROMIUM_COMMAND",
		/snap|flatpak/.test(cmd + args.join(" ")) &&
			"sandboxed Chromium: CHROMIUM_PROFILE_DIR must be a path the sandbox can write",
	].filter(Boolean);
	throw new Error(
		[
			`Chromium didn't open its DevTools port${exited ? ` (${exited})` : " within 30s"}`,
			...(hints.length ? [`  likely: ${hints.join("; ")}`] : []),
			...(tail ? [`  its output (${logFile}):\n    ${tail}`] : []),
		].join("\n"),
	);
};

export type Google = {
	/** fetch with the session's cookies, following redirects; null when Google wants a sign-in */
	fetch: (url: string, init?: { accept?: string; maxBytes?: number }) => Promise<Response | null>;
};

const cookieHeader = (cookies: Cookie[], url: URL) =>
	cookies
		.filter((c) => {
			const domain = c.domain.replace(/^\./, "");
			return (
				(url.hostname === domain || url.hostname.endsWith(`.${domain}`)) && url.pathname.startsWith(c.path)
			);
		})
		.map((c) => `${c.name}=${c.value}`)
		.join("; ");

/**
 * Connect to (or start) the profile's Chromium and return a signed-in session, or null
 * (with a log line saying why) so callers skip Google work and keep what they have.
 */
export const openGoogle = async (): Promise<Google | null> => {
	const profile = optional("CHROMIUM_PROFILE_DIR");
	if (!profile) {
		log("  Google: CHROMIUM_PROFILE_DIR not set, skipping Drive links");
		return null;
	}
	let cookies: Cookie[];
	try {
		const browser = await cdp((await running(profile)) ?? (await launch(profile)));
		try {
			cookies = (await browser.send("Storage.getCookies")).cookies;
			const signedIn = cookies.some(
				(c) => ["SID", "__Secure-1PSID"].includes(c.name) && c.domain.endsWith("google.com"),
			);
			if (!signedIn) {
				const { targetInfos } = await browser.send("Target.getTargets");
				// a fresh launch's own tab (drive.google.com) is already on its way to the sign-in page
				if (!targetInfos.some((t: any) => /^https:\/\/(accounts|drive)\.google\.com/.test(String(t.url))))
					await browser.send("Target.createTarget", { url: SIGN_IN });
				logWarn(
					`Google: not signed in. Sign in in the Chromium window (${profile}); skipping Drive this run`,
				);
				return null;
			}
		} finally {
			browser.close();
		}
	} catch (e) {
		logWarn(`Google: skipping Drive this run: ${(e as Error).message}`);
		return null;
	}
	log("  Google: session ready");

	return {
		fetch: async (start, init = {}) => {
			let url = new URL(start);
			for (let hop = 0; hop < 12; hop++) {
				stats.requests++;
				const res = await fetch(url, {
					redirect: "manual",
					headers: { cookie: cookieHeader(cookies, url), ...(init.accept && { accept: init.accept }) },
					signal: AbortSignal.timeout(10 * 60_000),
				});
				// services hand out their own cookies (e.g. Drive's OSID) along redirect chains
				for (const line of res.headers.getSetCookie()) setCookie(cookies, line, url);
				const location = res.headers.get("location");
				if (res.status >= 300 && res.status < 400 && location) {
					await res.body?.cancel();
					url = new URL(location, url);
					continue;
				}
				const type = res.headers.get("content-type") ?? "";
				if (
					type.startsWith("text/html") &&
					(url.hostname === "accounts.google.com" || Number(res.headers.get("content-length") || 0) < 4096)
				) {
					const html = await res.text();
					// Drive's "Redirecting..." page: a JS redirect, usually a passive sign-in hop
					const next = /<title>Redirecting\.\.\.<\/title>[\s\S]*?var url = '([^']+)'/.exec(html)?.[1];
					if (next) {
						url = new URL(
							next
								.replace(/\\x([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
								.replace(/\\\//g, "/"),
						);
						continue;
					}
					// ended on a page that wants a person: not signed in (or no access)
					if (url.hostname === "accounts.google.com") return null;
					return new Response(html, { status: res.status, headers: res.headers });
				}
				const length = Number(res.headers.get("content-length"));
				if (init.maxBytes && length > init.maxBytes) {
					await res.body?.cancel();
					throw new Error(`too large (${Math.round(length / 1e6)} MB > MAX_FILE_MB)`);
				}
				return res;
			}
			throw new Error("too many redirects");
		},
	};
};

/** apply one Set-Cookie header to the in-memory jar (this run only; the browser keeps its own) */
const setCookie = (jar: Cookie[], line: string, url: URL) => {
	const [pair, ...attrs] = line.split(";").map((p) => p.trim());
	const eq = pair.indexOf("=");
	if (eq <= 0) return;
	const attr = (name: string) =>
		attrs.find((a) => a.toLowerCase().startsWith(`${name}=`))?.slice(name.length + 1);
	const cookie: Cookie = {
		name: pair.slice(0, eq),
		value: pair.slice(eq + 1),
		domain: attr("domain") ?? url.hostname,
		path: attr("path") ?? "/",
	};
	const expired = attr("max-age") === "0" || (attr("expires") && Date.parse(attr("expires")!) < Date.now());
	const same = (c: Cookie) =>
		c.name === cookie.name &&
		c.domain.replace(/^\./, "") === cookie.domain.replace(/^\./, "") &&
		c.path === cookie.path;
	const i = jar.findIndex(same);
	if (i >= 0) jar.splice(i, 1);
	if (!expired) jar.push(cookie);
};
