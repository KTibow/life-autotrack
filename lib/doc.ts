/**
 * Markdown documents with a frontmatter header: for objects whose main content is prose
 * (an assignment's description, a page, an update). The prose is the body, the
 * object's remaining fields are the header, one `key: <json>` per line. JSON values are
 * valid YAML, so any frontmatter parser reads it; `parseDoc` is the tiny exact inverse.
 */

export const formatDoc = (meta: Record<string, unknown>, body: string) =>
	[
		"---",
		...Object.entries(meta)
			.filter(([, v]) => v !== undefined)
			.map(([k, v]) => `${k}: ${JSON.stringify(v)}`),
		"---",
		"",
		body.trim(),
	]
		.join("\n")
		.trimEnd() + "\n";

export const parseDoc = (text: string): { meta: Record<string, any>; body: string } => {
	const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
	if (!m) return { meta: {}, body: text };
	const meta: Record<string, any> = {};
	for (const line of m[1].split("\n")) {
		const i = line.indexOf(": ");
		if (i > 0) meta[line.slice(0, i)] = JSON.parse(line.slice(i + 2));
	}
	return { meta, body: m[2].trim() };
};
