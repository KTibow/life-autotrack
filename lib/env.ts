/**
 * Environment: loads life-autotrack/.env (if present) into process.env, and
 * resolves where the life repo lives (a sibling `../life` by default).
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));

const envFile = resolve(ROOT, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

export const LIFE_DIR = resolve(ROOT, process.env.LIFE_DIR || "../life");

/** read a required env var, failing with a message that names it (never its value) */
export const need = (name: string): string => {
	const value = process.env[name];
	if (!value) throw new Error(`missing env var ${name} (see .env.example)`);
	return value;
};

export const optional = (name: string): string | undefined => process.env[name] || undefined;
