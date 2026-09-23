/**
 * Client: every class is already in the page (#life-data), so routing is just the hash:
 * `#` → class list, `#p3` → a class. ←/→ switch classes. Bodies are sanitized at build.
 */

import type { Klass, Material, SiteData } from "../data.ts";
import "./styles.css";

const data: SiteData = JSON.parse(document.getElementById("life-data")?.textContent || '{"classes":[]}');
const { classes } = data;
const page = document.getElementById("page")!;
const controls = document.getElementById("controls")!;

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fmt = (d?: string) =>
	d
		? new Date(`${d.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", {
				weekday: "short",
				month: "short",
				day: "numeric",
				timeZone: "UTC",
			})
		: "";
const ext = (href: string, label: string, cls = "") =>
	`<a class="${cls}" href="${esc(href)}" target="_blank" rel="noreferrer">${label}</a>`;

const materials = (nodes: Material[]): string =>
	`<ul class="materials">${nodes
		.map((n) => {
			const due = n.due ? `<span class="due">${fmt(n.due)}</span>` : "";
			if (n.type === "folder")
				return `<li class="m-folder"><details><summary>${esc(n.title)}</summary>${
					n.children?.length ? materials(n.children) : '<p class="muted">Empty</p>'
				}</details></li>`;
			if (n.body)
				return `<li><details><summary>${esc(n.title)}${due}</summary><div class="rich">${n.body}</div>${ext(
					n.url,
					"Open in Schoology ↗",
					"out",
				)}</details></li>`;
			return `<li>${ext(n.url, esc(n.title) + due)}</li>`;
		})
		.join("")}</ul>`;

const listView = () => {
	document.title = "life";
	controls.hidden = true;
	page.innerHTML = `<h1>Classes</h1><ul class="class-list">${classes
		.map(
			(c) => `<li><a href="#${c.slug}">
				<span class="period">${esc(c.period ?? "·")}</span>
				<span class="name">${esc(c.name)}</span>
				${c.grade?.score ? `<span class="grade tnum">${esc(c.grade.score)}% ${esc(c.grade.mark)}</span>` : ""}
			</a>${
				c.upcoming[0]
					? `<div class="next muted">next: ${esc(c.upcoming[0].title)} · ${fmt(c.upcoming[0].due)}</div>`
					: ""
			}</li>`,
		)
		.join("")}</ul>${
		classes.length
			? ""
			: '<p class="muted">Nothing archived yet — run the schoology/studentvue facets first.</p>'
	}<footer class="muted">built ${esc(data.generated?.slice(0, 16).replace("T", " "))} UTC</footer>`;
};

const classView = (c: Klass, i: number) => {
	document.title = c.name;
	const prev = classes[(i - 1 + classes.length) % classes.length];
	const next = classes[(i + 1) % classes.length];
	const g = c.grade;
	const meta = [c.period && `Period ${c.period}`, c.teacher, c.room && `Room ${c.room}`]
		.filter(Boolean)
		.map(esc);
	if (c.schoologyUrl) meta.push(ext(c.schoologyUrl, "Schoology ↗"));

	page.innerHTML = [
		`<header><h1>${esc(c.name)}</h1><p class="muted">${meta.join(" · ")}</p></header>`,
		c.upcoming.length &&
			`<section><h2>Up next</h2><div class="chips">${c.upcoming
				.slice(0, 12)
				.map((u) => {
					const inner = `<span>${esc(u.title)}</span><span class="due">${fmt(u.due)}</span>`;
					return u.url ? ext(u.url, inner, "chip") : `<div class="chip">${inner}</div>`;
				})
				.join("")}</div></section>`,
		g &&
			`<section><h2>Grade <span class="tnum">${esc(g.score ?? "–")}%</span> ${esc(g.mark)}</h2>${
				g.categories.length
					? `<table><thead><tr><th>Category</th><th>Weight</th><th>Points</th><th>Weighted</th></tr></thead><tbody>${g.categories
							.map(
								(k) =>
									`<tr><td>${esc(k.type)}</td><td>${esc(k.weight)}</td><td class="tnum">${esc(k.points)} / ${esc(
										k.possible,
									)}</td><td>${esc(k.pct)}</td></tr>`,
							)
							.join("")}</tbody></table>`
					: ""
			}<details><summary>${g.assignments.length} assignments</summary><table><tbody>${g.assignments
				.map(
					(a) =>
						`<tr class="${a.notes && /missing|missed/i.test(a.notes) ? "missing" : ""}"><td class="muted tnum">${esc(
							a.date,
						)}</td><td>${esc(a.name)}</td><td class="muted">${esc(a.type)}</td><td class="tnum">${esc(a.score)}</td></tr>`,
				)
				.join("")}</tbody></table></details></section>`,
		`<section><h2>Materials</h2>${c.materials.length ? materials(c.materials) : '<p class="muted">Nothing posted.</p>'}</section>`,
		c.updates.length &&
			`<section><h2>Updates</h2>${c.updates
				.map(
					(u) =>
						`<article class="update"><div class="muted">${esc(u.created)}</div><div class="rich">${u.body}</div></article>`,
				)
				.join("")}</section>`,
	]
		.filter(Boolean)
		.join("");

	controls.hidden = false;
	controls.innerHTML = `<a href="#${prev.slug}" data-key="ArrowLeft" aria-label="Previous class">‹</a><a class="main" href="#">${esc(
		c.name,
	)}</a><a href="#${next.slug}" data-key="ArrowRight" aria-label="Next class">›</a>`;
};

const route = () => {
	const slug = decodeURIComponent(location.hash.slice(1));
	const i = classes.findIndex((c) => c.slug === slug);
	if (i >= 0) classView(classes[i], i);
	else listView();
	scrollTo(0, 0);
};

addEventListener("hashchange", route);
addEventListener("keydown", (e) => {
	if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
	if (e.target instanceof Element && e.target.closest("input, textarea, select, [contenteditable]")) return;
	controls.querySelector<HTMLAnchorElement>(`[data-key="${e.key}"]`)?.click();
});
route();
