/** HTML fields are archived once, as markdown. */

import { NodeHtmlMarkdown } from "node-html-markdown";

const nhm = new NodeHtmlMarkdown({ keepDataImages: false, useLinkReferenceDefinitions: false });

/** html → markdown, resolving root-relative urls against `base` */
export const htmlToMarkdown = (html: string | null | undefined, base?: string): string => {
	if (!html) return "";
	const resolved = base
		? html.replace(/(href|src)="(\/[^/"][^"]*)"/g, (_, attr, path) => `${attr}="${base}${path}"`)
		: html;
	return nhm.translate(resolved).trim();
};
