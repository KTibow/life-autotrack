/**
 * StudentVUE (New) JSON API client, per
 * https://github.com/KTibow/sv-docs/blob/method-per-section/JSON-API.md
 *
 * - login: HTTP Basic; data calls: Bearer, with arguments.request as a JSON *string*
 * - errors arrive inside HTTP 200 bodies; "feature not enabled here" (2100, and 400s
 *   whose message embeds 2100) becomes SvUnavailable so callers can treat it as empty
 * - 401 → refresh token (or re-login) once
 * - errors carry method + code only, never bodies, which are full of PII
 */

import { log, stats } from "../../lib/log.ts";

export type SvCreds = { host: string; username: string; password: string };

export class SvUnavailable extends Error {}

const HEADERS = {
	"content-type": "application/json",
	"user-agent": "ksoap",
	AppNameOSAndVersion: "StudentVUE|Android|1.9.16",
};

export const createStudentvue = (creds: SvCreds) => {
	const base = `https://${creds.host}/api/v1/mobile/PXPWebServices`;
	let access: string | null = null;
	let refresh: string | null = null;

	const post = async (method: string, authorization: string, body: unknown) => {
		stats.requests++;
		const started = Date.now();
		const res = await fetch(`${base}/${method}`, {
			method: "POST",
			headers: { ...HEADERS, authorization },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(120_000),
		});
		const text = await res.text();
		log(`  StudentVUE ${method} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
		let json: any;
		try {
			json = JSON.parse(text);
		} catch {
			throw new Error(`StudentVUE ${method}: HTTP ${res.status}, non-JSON response`);
		}
		return { status: res.status, json };
	};

	const acceptTokens = (method: string, json: any) => {
		if (!json?.access_token) {
			throw new Error(`StudentVUE ${method} failed${json?.error?.code ? ` (code ${json.error.code})` : ""}`);
		}
		access = json.access_token;
		refresh = json.refresh_token ?? null;
	};

	const login = async () => {
		const basic = Buffer.from(`${creds.username}:${creds.password}`).toString("base64");
		const request = JSON.stringify({ userID: null, password: null, userType: "Student" });
		const { json } = await post("AttemptLogin", `Basic ${basic}`, { arguments: { request } });
		acceptTokens("AttemptLogin", json);
	};

	const renew = async () => {
		if (refresh) {
			const { status, json } = await post("RefreshToken", `Bearer ${refresh}`, {});
			if (status === 200 && json?.access_token) return acceptTokens("RefreshToken", json);
		}
		await login();
	};

	const call = async (
		method: string,
		request: Record<string, unknown> = {},
		retried = false,
	): Promise<any> => {
		if (!access) await login();
		const body = {
			arguments: { request: JSON.stringify({ childIntID: 0, languageCode: "en", ...request }) },
		};
		const { status, json } = await post(method, `Bearer ${access}`, body);
		if (status === 401 && !retried) {
			await renew();
			return call(method, request, true);
		}
		if (status !== 200) throw new Error(`StudentVUE ${method}: HTTP ${status}`);
		if (json.error) {
			const { code, message } = json.error;
			if (code === "2100" || /^2100 -|not available for this school|not enabled/i.test(message ?? ""))
				throw new SvUnavailable(`StudentVUE ${method}: unavailable (${code})`);
			throw new Error(`StudentVUE ${method}: error code ${code}`);
		}
		return json.data;
	};

	/** like call(), but "not enabled at this school" → undefined */
	const maybe = async (method: string, request?: Record<string, unknown>) => {
		try {
			return await call(method, request);
		} catch (e) {
			if (e instanceof SvUnavailable) {
				log(`  StudentVUE ${method}: not enabled at this school, skipping`);
				return undefined;
			}
			throw e;
		}
	};

	/**
	 * A session on the PXP2 web portal, for data the JSON API doesn't expose (e.g. the
	 * timetable for any date). Same handoff the app's WebView does: mint an SSO token
	 * with GenerateAuthToken (exactly the app's class-website variant; the documented
	 * pxpRedirect variant 500s the portal), load a PXP2 page with it, keep the cookies.
	 */
	const web = async () => {
		const token = (
			await call("GenerateAuthToken", {
				username: creds.username,
				tokenForClassWebSite: "true",
				usertype: "0",
				isParentStudent: "0",
				assignmentID: "1",
				documentID: "1",
			})
		)?.authToken?.encyToken;
		if (!token) throw new Error("StudentVUE GenerateAuthToken returned no token");
		const jar = new Map<string, string>();
		let url = `https://${creds.host}/PXP2_Calendar.aspx?&token=${encodeURIComponent(token)}&AGU=0&LNG=00&regenerateSessionId=True&mobile=true&advancedSession=true&THEME=2&fontScalar=1`;
		for (let hop = 0; hop < 8; hop++) {
			stats.requests++;
			const res = await fetch(url, {
				redirect: "manual",
				headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") },
				signal: AbortSignal.timeout(60_000),
			});
			for (const c of res.headers.getSetCookie()) {
				const [kv] = c.split(";");
				const i = kv.indexOf("=");
				jar.set(kv.slice(0, i), kv.slice(i + 1));
			}
			await res.body?.cancel();
			const location = res.headers.get("location");
			if (!location) {
				if (!res.ok) throw new Error(`StudentVUE portal: HTTP ${res.status}`);
				break;
			}
			url = new URL(location, url).href;
		}
		if (!jar.has("ASP.NET_SessionId")) throw new Error("StudentVUE portal: no session cookie");
		log("  StudentVUE portal session opened");
		const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");

		/** POST a PXP2WebCommonService method; ASMX wraps the JSON result as a string in `d` */
		const service = async (method: string, body: unknown): Promise<any> => {
			stats.requests++;
			const res = await fetch(`https://${creds.host}/Service/PXP2WebCommonService.asmx/${method}`, {
				method: "POST",
				headers: { "content-type": "application/json; charset=utf-8", cookie },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(60_000),
			});
			const text = await res.text();
			if (!res.ok) throw new Error(`StudentVUE portal ${method}: HTTP ${res.status}`);
			try {
				const d = JSON.parse(text).d;
				return typeof d === "string" ? JSON.parse(d) : d;
			} catch {
				throw new Error(`StudentVUE portal ${method}: unexpected response`);
			}
		};
		return { service };
	};

	return { call, maybe, web };
};

export type Studentvue = ReturnType<typeof createStudentvue>;

/** "M/D/YYYY" or "MM/DD/YYYY[ time]" → "YYYY-MM-DD" */
export const isoDate = (s: string | null | undefined): string => {
	const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s ?? "");
	return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : "";
};

/** "2025-2026" for any date in that school year (July rollover) */
export const schoolYear = (iso: string): string => {
	const [y, m] = iso.split("-").map(Number);
	return m >= 7 ? `${y}-${y + 1}` : `${y - 1}-${y}`;
};
