/**
 * Environment: loads life-autotrack/.env (if present) into process.env, and
 * resolves where the life repo lives (a sibling `../life` by default).
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));

const envFile = resolve(ROOT, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

/**
 * A path from the environment: `~` expanded (.env files don't do it, and an unexpanded
 * `~/x` would quietly create a directory literally named `~`), relative paths resolved
 * against this repo rather than wherever the command happened to run.
 */
export const pathEnv = (name: string, fallback?: string): string | undefined => {
	const raw = process.env[name] || fallback;
	if (!raw) return undefined;
	return resolve(ROOT, raw.replace(/^~(?=$|\/)/, homedir()));
};

export const LIFE_DIR = pathEnv("LIFE_DIR", "../life")!;

/** read a required env var, failing with a message that names it (never its value) */
export const need = (name: string): string => {
	const value = process.env[name];
	if (!value) throw new Error(`missing env var ${name} (see .env.example)`);
	return value;
};

export const optional = (name: string): string | undefined => process.env[name] || undefined;

/** how often a facet re-fetches what changes in place (Google-native files, page images) */
export const recheckMs = (facet: string, fallbackHours = 24): number =>
	Number(optional(`${facet}_RECHECK_HOURS`) ?? fallbackHours) * 3600_000;
