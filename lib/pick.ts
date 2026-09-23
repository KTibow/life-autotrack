/**
 * Trimming helpers: archive only the fields worth keeping, and leave out empty ones
 * (null, "", [], {}) so absent data doesn't show up as noise in diffs.
 */

const isEmpty = (v: unknown) =>
	v === undefined ||
	v === null ||
	v === "" ||
	(Array.isArray(v) && v.length === 0) ||
	(typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0);

/** the listed keys of `obj`, in the listed order, minus empty values */
export const pick = <T extends Record<string, any>>(
	obj: T | null | undefined,
	keys: (keyof T | string)[],
) => {
	const out: Record<string, any> = {};
	if (!obj) return out;
	for (const k of keys) if (!isEmpty(obj[k as string])) out[k as string] = obj[k as string];
	return out;
};

/** drop empty values from an already-shaped object */
export const compact = (obj: Record<string, any>) =>
	Object.fromEntries(Object.entries(obj).filter(([, v]) => !isEmpty(v)));
