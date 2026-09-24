/**
 * National Weather Service forecast → life/weather/
 *
 *   days/<YYYY-MM>/<YYYY-MM-DD>.json   one per day: the day and night forecasts (as NWS
 *                                      words them) and the hourly forecast, keyed by hour
 *
 * A day's file is rewritten with each new forecast, so its history is how the forecast
 * changed. Hours (and the day part) already past keep their last forecast, so a past
 * day's file ends up as what was expected hour by hour. Nothing is ever pruned.
 *
 * Config: WEATHER_LOCATION=<lat>,<lon> (anywhere in the US).
 */

import { need } from "../../lib/env.ts";
import { sleep } from "../../lib/http.ts";
import { log, setPhase, stats } from "../../lib/log.ts";
import { compact } from "../../lib/pick.ts";
import { track } from "../../lib/track.ts";

// NWS asks for a User-Agent that identifies the app
const USER_AGENT = "life-autotrack (https://github.com/KTibow/life-autotrack)";

/** GET JSON from api.weather.gov, retrying its occasional 5xx */
const get = async (url: string): Promise<any> => {
	for (let attempt = 1; ; attempt++) {
		stats.requests++;
		const res = await fetch(url, {
			headers: { "user-agent": USER_AGENT, accept: "application/geo+json" },
			signal: AbortSignal.timeout(20_000),
		});
		if (res.ok) return res.json();
		await res.body?.cancel();
		if (res.status < 500 || attempt === 3) throw new Error(`HTTP ${res.status} for ${new URL(url).pathname}`);
		await sleep(2000 * attempt);
	}
};

/** 1.1111 °C → 34 (NWS computes dewpoints in °F and converts, so this is lossless) */
const toF = (c: number | null | undefined) => (c == null ? undefined : Math.round((c * 9) / 5 + 32));

const trimPeriod = (p: any) =>
	compact({
		temperature: p.temperature,
		probabilityOfPrecipitation: p.probabilityOfPrecipitation?.value,
		// restates the short forecast and the wind
		detailedForecast: p.detailedForecast,
	});

const trimHour = (h: any) =>
	compact({
		temperature: h.temperature,
		probabilityOfPrecipitation: h.probabilityOfPrecipitation?.value,
		dewpoint: toF(h.dewpoint?.value),
		relativeHumidity: h.relativeHumidity?.value,
		windSpeed: h.windSpeed,
		windDirection: h.windDirection,
		shortForecast: h.shortForecast,
	});

type Day = { day?: any; night?: any; hours: Record<string, any> };

await track("weather", async ({ store, note }) => {
	const [lat, lon] = need("WEATHER_LOCATION")
		.split(",")
		.map((s) => Number(Number(s).toFixed(4))); // NWS redirects more precise points
	if (!Number.isFinite(lat) || !Number.isFinite(lon))
		throw new Error("WEATHER_LOCATION should be <lat>,<lon>");

	setPhase("fetching forecast");
	const point = (await get(`https://api.weather.gov/points/${lat},${lon}`)).properties;
	const [forecast, hourly] = await Promise.all([get(point.forecast), get(point.forecastHourly)]);

	// times come with the forecast office's offset, so their text is already local time
	const localDate = (ms: number) => new Date(ms).toLocaleDateString("sv-SE", { timeZone: point.timeZone });
	const days = new Map<string, Day>();
	const dayOf = (date: string) => days.get(date) ?? days.set(date, { hours: {} }).get(date)!;

	for (const p of forecast.properties.periods) {
		// a period belongs to the day it's mostly in; a night (or "Overnight") to the evening it starts
		const date = localDate(Date.parse(p.endTime) - 12 * 3600_000);
		dayOf(date)[p.isDaytime ? "day" : "night"] = trimPeriod(p);
	}
	for (const h of hourly.properties.periods)
		dayOf(h.startTime.slice(0, 10)).hours[h.startTime.slice(11, 16)] = trimHour(h);

	setPhase("writing days");
	const dates = [...days.keys()].sort();
	let changes = 0;
	for (const date of dates) {
		const rel = `days/${date.slice(0, 7)}/${date}.json`;
		const before: Day | undefined = await store.readJson(rel);
		const fresh = days.get(date)!;
		// what the forecast no longer covers (it starts at the current hour) stays as last forecast
		const merged = compact({
			day: fresh.day ?? before?.day,
			night: fresh.night ?? before?.night,
			hours: Object.fromEntries(
				Object.entries({ ...before?.hours, ...fresh.hours }).sort(([a], [b]) => a.localeCompare(b)),
			),
		});
		for (const part of ["day", "night"] as const) {
			const [was, now] = [before?.[part], fresh[part]];
			if (!was || !now) continue;
			const [a, b] = [was, now].map((p) => `${p.temperature}°, ${p.probabilityOfPrecipitation ?? 0}%`);
			if (a === b) continue;
			note(`${date} ${part}: ${a} → ${b}`);
			changes++;
		}
		await store.writeJson(rel, merged);
	}
	if (!changes) note("forecast updated"); // only the wording or the hours changed (or nothing)
	log(`  ${dates[0]} to ${dates.at(-1)}, forecast issued ${forecast.properties.updateTime}`);
});
