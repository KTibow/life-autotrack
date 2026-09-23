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
 * - Tracker runs start it headless (no display needed), let it load Drive so Google can
 *   refresh the session's rotating cookies into the profile, read the cookies over the
 *   DevTools protocol, and close it. All requests are then plain fetch().
 * - Only `pnpm google:login` opens a window: sign-in and 2FA happen there, then it closes.
 * - A Chromium already running on the profile (you opened it) is borrowed, never closed.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { closeSync, openSync } from "node:fs";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { optional, pathEnv } from "../env.ts";
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

/**
 * The desktop session's display environment, for a run started over SSH or from cron:
 * those don't inherit the X cookie (XAUTHORITY) or the Wayland socket, so the display
 * turns Chromium away ("Authorization required ... Missing X server"). Anything already
 * set in the environment or .env wins.
 */
const desktopEnv = async (): Promise<Record<string, string>> => {
	const env: Record<string, string> = {};
	const uid = process.getuid?.();
	if (uid === undefined) return env;
	const runtime = process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`;
	if (!existsSync(runtime)) return env;
	if (!process.env.XDG_RUNTIME_DIR) env.XDG_RUNTIME_DIR = runtime;
	if (!process.env.WAYLAND_DISPLAY && existsSync(join(runtime, "wayland-0")))
		env.WAYLAND_DISPLAY = "wayland-0";
	if (!process.env.XAUTHORITY) {
		const names = await readdir(runtime).catch(() => [] as string[]);
		const candidates = [
			join(runtime, "gdm", "Xauthority"), // GNOME on X11
			...names.filter((n) => n.startsWith(".mutter-Xwaylandauth.")).map((n) => join(runtime, n)), // GNOME on Wayland
			...names.filter((n) => n.startsWith("xauth_")).map((n) => join(runtime, n)), // KDE / SDDM
			join(homedir(), ".Xauthority"),
		];
		const found = candidates.find((c) => existsSync(c));
		if (found) env.XAUTHORITY = found;
	}
	if (!process.env.DISPLAY && env.XAUTHORITY) env.DISPLAY = ":0";
	return env;
};

const launch = async (profile: string, headed: boolean): Promise<string> => {
	await mkdir(profile, { recursive: true });
	await rm(join(profile, "DevToolsActivePort"), { force: true });
	const [cmd, ...args] = (optional("CHROMIUM_COMMAND") ?? "chromium").split(/\s+/);
	// Chromium's own output goes here, so a failed start can say why
	const logFile = join(profile, "life-autotrack-chromium.log");
	const out = openSync(logFile, "w");
	const desktop = headed ? await desktopEnv() : {};
	log(
		`  starting Chromium (${cmd}) on ${profile}` +
			(Object.keys(desktop).length
				? ` with ${Object.entries(desktop)
						.map(([k, v]) => `${k}=${v}`)
						.join(" ")}`
				: ""),
	);
	const child = spawn(
		cmd,
		[
			...args,
			`--user-data-dir=${profile}`,
			"--remote-debugging-port=0",
			"--password-store=basic",
			"--no-first-run",
			"--no-default-browser-check",
			// headed: use Wayland when the session has it, X11 otherwise
			...(headed ? ["--ozone-platform-hint=auto"] : ["--headless=new"]),
			"https://drive.google.com/",
		],
		{ detached: true, stdio: ["ignore", out, out], env: { ...process.env, ...desktop } },
	);
	closeSync(out);
	let exited: string | undefined;
	child.on("error", (e) => (exited = `could not run "${cmd}": ${e.message}`));
	child.on("exit", (code, signal) => (exited = `exited right away (${signal ?? `code ${code}`})`));
	child.unref(); // closed over DevTools (Browser.close) once we're done with it
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
		headed &&
			!process.env.DISPLAY &&
			!process.env.WAYLAND_DISPLAY &&
			!desktop.DISPLAY &&
			!desktop.WAYLAND_DISPLAY &&
			"no display found (is someone logged in to the desktop? else set DISPLAY=:0 in .env)",
		/authorization/i.test(tail) &&
			"the display refused us: set XAUTHORITY in .env to the desktop session's X cookie (the -auth path in `ps -o args= -C Xwayland,Xorg`)",
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

export type Connection =
	| { state: "ready"; google: Google }
	| { state: "unconfigured" }
	| { state: "signed-out"; profile: string }
	| { state: "failed"; error: string };

const signedIn = (cookies: Cookie[]) =>
	cookies.some((c) => ["SID", "__Secure-1PSID"].includes(c.name) && c.domain.endsWith("google.com"));
const pageUrls = async (browser: Awaited<ReturnType<typeof cdp>>): Promise<string[]> =>
	(await browser.send("Target.getTargets")).targetInfos
		.filter((t: any) => t.type === "page")
		.map((t: any) => String(t.url));
const onDrive = (urls: string[]) => urls.some((u) => u.startsWith("https://drive.google.com/"));
const onSignIn = (urls: string[]) => urls.some((u) => u.startsWith("https://accounts.google.com/"));

/**
 * Get the profile's Google cookies. Starts Chromium if it isn't running (headless unless
 * `interactive`), waits for its Drive tab to settle so the session gets refreshed, and
 * closes it again if we started it. `interactive` (google:login) opens a window and, when
 * signed out, waits for a person to sign in there.
 */
export const connectGoogle = async ({ interactive = false } = {}): Promise<Connection> => {
	const profile = pathEnv("CHROMIUM_PROFILE_DIR");
	if (!profile) return { state: "unconfigured" };
	const headed = interactive || optional("CHROMIUM_HEADLESS") === "0";
	let browser: Awaited<ReturnType<typeof cdp>> | undefined;
	let started = false;
	try {
		let ws = await running(profile);
		if (!ws) {
			ws = await launch(profile, headed);
			started = true;
		}
		browser = await cdp(ws);
		let cookies: Cookie[] = (await browser.send("Storage.getCookies")).cookies;
		if (started) {
			// let the Drive tab load: it either lands on Drive (session refreshed) or on sign-in
			for (let i = 0; i < 40; i++) {
				const urls = await pageUrls(browser);
				cookies = (await browser.send("Storage.getCookies")).cookies;
				if ((signedIn(cookies) && onDrive(urls)) || onSignIn(urls)) break;
				await sleep(500);
			}
		}
		if (!signedIn(cookies) || (started && onSignIn(await pageUrls(browser)))) {
			if (!interactive) return { state: "signed-out", profile };
			if (!onSignIn(await pageUrls(browser))) await browser.send("Target.createTarget", { url: SIGN_IN });
			log(
				"  waiting for you to sign in to Google in the Chromium window (up to 15 minutes, Ctrl-C to stop)…",
			);
			// Ctrl-C shouldn't leave the window behind
			const b = browser;
			const stop = () => void b.send("Browser.close").finally(() => process.exit(130));
			process.once("SIGINT", stop);
			const deadline = Date.now() + 15 * 60_000;
			while (Date.now() < deadline) {
				await sleep(2000);
				cookies = (await browser.send("Storage.getCookies")).cookies;
				if (signedIn(cookies)) break;
			}
			process.off("SIGINT", stop);
			if (!signedIn(cookies)) return { state: "signed-out", profile };
			await sleep(2000); // let the post-sign-in redirects finish setting cookies
			cookies = (await browser.send("Storage.getCookies")).cookies;
		}
		return { state: "ready", google: session(cookies) };
	} catch (e) {
		return { state: "failed", error: (e as Error).message };
	} finally {
		// graceful close flushes the refreshed cookies to the profile on disk
		if (browser && started) await browser.send("Browser.close").catch(() => {});
		browser?.close();
	}
};

/** for trackers: a session, or null with a log line saying Drive is skipped this run */
export const openGoogle = async (): Promise<Google | null> => {
	const c = await connectGoogle();
	if (c.state === "ready") {
		log("  Google: session ready");
		return c.google;
	}
	if (c.state === "unconfigured") log("  Google: CHROMIUM_PROFILE_DIR not set, skipping Drive links");
	else if (c.state === "signed-out")
		logWarn(
			`Google: not signed in, skipping Drive this run. Run \`pnpm google:login\` on the machine to sign in`,
		);
	else logWarn(`Google: skipping Drive this run: ${c.error}`);
	return null;
};

const session = (cookies: Cookie[]): Google => ({
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
});

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
