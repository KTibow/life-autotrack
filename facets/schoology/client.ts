/**
 * Minimal Schoology REST client — OAuth 1.0a (HMAC-SHA1) over fetch.
 * See https://kendell.dev/schoology-openapi/openapi.json.
 *
 * - redirects on api.schoology.com get re-signed (users/me 302s to users/{id}, and the
 *   old signature is dead on the new url); redirects elsewhere (file CDNs) are followed
 *   unsigned, since presigned storage urls reject a second auth scheme
 * - 50 requests / 5s per token: paced at 45 with one retry ladder for 429s
 * - errors carry method, status and path only — never bodies, which may hold PII
 */

import { rateLimiter, sleep } from "../../lib/http.ts";
import { log, stats } from "../../lib/log.ts";

export const API = "https://api.schoology.com/v1";

export type SchoologyAuth = {
	consumerKey: string;
	consumerSecret: string;
	tokenKey: string;
	tokenSecret: string;
};

const enc = (s: string) =>
	encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

export class SchoologyError extends Error {
	status: number;
	constructor(status: number, method: string, url: string) {
		super(`Schoology ${status} on ${method} ${new URL(url).pathname}`);
		this.status = status;
	}
}

/**
 * The OAuth 1.0a Authorization header for a request. `tokenKey` empty (the first leg of
 * `schoology:login`) leaves out oauth_token and signs with the consumer secret alone.
 */
export const authorization = async (auth: SchoologyAuth, method: string, url: string) => {
	const u = new URL(url);
	const params: Record<string, string> = {
		oauth_consumer_key: auth.consumerKey,
		oauth_nonce: crypto.randomUUID().replaceAll("-", ""),
		oauth_signature_method: "HMAC-SHA1",
		oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
		...(auth.tokenKey && { oauth_token: auth.tokenKey }),
		oauth_version: "1.0",
	};
	const signed = [...Object.entries(params), ...u.searchParams.entries()]
		.map(([k, v]) => [enc(k), enc(v)])
		.sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : 1) : a < b ? -1 : 1))
		.map(([k, v]) => `${k}=${v}`)
		.join("&");
	const base = `${method}&${enc(`${u.protocol}//${u.host}${u.pathname}`)}&${enc(signed)}`;
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(`${enc(auth.consumerSecret)}&${enc(auth.tokenSecret)}`),
		{ name: "HMAC", hash: "SHA-1" },
		false,
		["sign"],
	);
	const sig = Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(base))).toString(
		"base64",
	);
	params.oauth_signature = sig;
	return (
		'OAuth realm="Schoology API", ' +
		Object.entries(params)
			.map(([k, v]) => `${k}="${enc(v)}"`)
			.join(", ")
	);
};

export const createSchoology = (auth: SchoologyAuth) => {
	const wait = rateLimiter(45, 5000);

	/** signed GET that follows redirects correctly; returns the final Response */
	const raw = async (url: string, timeoutMs = 60_000, retries = 0): Promise<Response> => {
		let current = url;
		for (let hop = 0; hop < 5; hop++) {
			const signed = new URL(current).host === "api.schoology.com";
			if (signed) await wait();
			stats.requests++;
			const res = await fetch(current, {
				headers: signed
					? { accept: "application/json", authorization: await authorization(auth, "GET", current) }
					: {},
				redirect: "manual",
				signal: AbortSignal.timeout(timeoutMs),
			});
			if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.get("location")) {
				await res.body?.cancel();
				current = new URL(res.headers.get("location")!, current).href;
				continue;
			}
			if ((res.status === 429 || res.status >= 500) && retries < 3) {
				await res.body?.cancel();
				log(`  Schoology ${res.status} on ${new URL(current).pathname}, retrying in ${5.5 * (retries + 1)}s`);
				await sleep(5500 * (retries + 1));
				return raw(url, timeoutMs, retries + 1);
			}
			if (!res.ok) {
				await res.body?.cancel();
				throw new SchoologyError(res.status, "GET", current);
			}
			return res;
		}
		throw new Error(`Schoology: too many redirects for ${new URL(url).pathname}`);
	};

	const get = async (path: string): Promise<any> => {
		const url = path.startsWith("http") ? path : `${API}${path}`;
		const res = await raw(url);
		const text = await res.text();
		try {
			return JSON.parse(text);
		} catch {
			throw new Error(`Schoology non-JSON on ${new URL(url).pathname}`);
		}
	};

	/**
	 * Every row of a paginated collection. Collections wrap rows in a singular key
	 * (`assignment`, `update`, …) beside `total` and `links`; follow links.next.
	 */
	const all = async (path: string, key: string, pageSize = 200): Promise<any[]> => {
		const rows: any[] = [];
		const sep = path.includes("?") ? "&" : "?";
		let next: string | undefined = `${API}${path}${sep}start=0&limit=${pageSize}`;
		for (let page = 0; next && page < 200; page++) {
			const body: any = await get(next);
			const batch = body?.[key] ?? [];
			rows.push(...batch);
			next = batch.length ? body?.links?.next : undefined;
		}
		return rows;
	};

	/** download bytes (attachment download_path etc.), following CDN redirects unsigned */
	const download = async (url: string): Promise<Uint8Array> => {
		const res = await raw(url, 15 * 60_000);
		return new Uint8Array(await res.arrayBuffer());
	};

	return { get, all, download };
};

export type Schoology = ReturnType<typeof createSchoology>;
