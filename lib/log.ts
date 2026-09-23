/**
 * Progress logging: every line gets elapsed time, and while a run is going a heartbeat
 * reports what it's doing plus request/download counters, so a slow run is never silent.
 * Logs names, counts and sizes only — never response bodies.
 */

const t0 = Date.now();

const stamp = () => {
	const s = Math.floor((Date.now() - t0) / 1000);
	return `[${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}]`;
};

export const log = (...parts: unknown[]) => console.log(stamp(), ...parts);
export const logWarn = (...parts: unknown[]) => console.warn(stamp(), "⚠", ...parts);

export const mb = (bytes: number) =>
	bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${bytes ? Math.max(1, Math.round(bytes / 1e3)) : 0} kB`;

/** counters bumped by API clients and the file cache */
export const stats = { requests: 0, downloads: 0, downloadedBytes: 0 };

let phase = "starting";
/** what the run is doing right now (shown by the heartbeat) */
export const setPhase = (text: string) => {
	phase = text;
};

/** print a status line every `ms` until stopped; the timer never keeps the process alive */
export const heartbeat = (ms = 15_000) => {
	let last = { ...stats };
	const timer = setInterval(() => {
		const reqs = stats.requests - last.requests;
		const dls = stats.downloads - last.downloads;
		last = { ...stats };
		log(
			`… ${phase} · ${stats.requests} requests (+${reqs}) · ${stats.downloads} downloads (+${dls}, ${mb(
				stats.downloadedBytes,
			)} total)`,
		);
	}, ms);
	timer.unref();
	return () => clearInterval(timer);
};

/** "3/7" style counter for loops: `const tick = counter(items.length, "sections"); tick(name)` */
export const counter = (total: number, what: string) => {
	let done = 0;
	return (label?: string) => {
		done++;
		log(`  [${done}/${total} ${what}]${label ? ` ${label}` : ""}`);
	};
};
