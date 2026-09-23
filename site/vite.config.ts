import { defineConfig, type Plugin } from "vite";
import { load } from "./data.ts";

/**
 * Inline the joined life data into index.html. The JS/CSS bundles are content-hashed
 * and cache forever; index.html is the only thing that changes when data does, and
 * one fetch of it gives the client every class, so tabbing between them is free.
 */
const lifeData = (): Plugin => ({
	name: "life-data",
	transformIndexHtml: {
		order: "pre",
		handler: (html) => {
			const json = JSON.stringify(load()).replace(/</g, "\\u003c");
			return html.replace(
				"<!--life-data-->",
				`<script id="life-data" type="application/json">${json}</script>`,
			);
		},
	},
});

// everything is served from under the obscure prefix, e.g. https://host/<prefix>/
const prefix = process.env.PUBLISH_PREFIX?.replace(/^\/+|\/+$/g, "");

export default defineConfig({
	root: import.meta.dirname,
	base: prefix ? `/${prefix}/` : "/",
	plugins: [lifeData()],
	build: { outDir: "dist", emptyOutDir: true, assetsDir: "assets" },
});
