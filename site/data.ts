/**
 * Build-time view of the life repo: joins Schoology sections and StudentVUE classes
 * into one list for the page. Reads only what the facets wrote; never fetches. Bodies
 * are rendered from markdown and sanitized here, so the client can trust every `body`.
 */

import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import { parseDoc } from "../lib/doc.ts";
import { LIFE_DIR as LIFE } from "../lib/env.ts";
import { simplifyClassName } from "./naming.ts";

const WEB = `https://${process.env.SCHOOLOGY_HOST || "app.schoology.com"}`;

const text = (rel: string) => {
	const full = join(LIFE, rel);
	return existsSync(full) ? readFileSync(full, "utf8") : undefined;
};
const json = (rel: string): any => {
	const t = text(rel);
	return t === undefined ? undefined : JSON.parse(t);
};
const doc = (rel: string) => {
	const t = text(rel);
	return t === undefined ? undefined : parseDoc(t);
};
const list = (rel: string): string[] => {
	const full = join(LIFE, rel);
	return existsSync(full) ? readdirSync(full).sort() : [];
};

const render = (markdown?: string) =>
	markdown
		? sanitizeHtml(marked.parse(markdown, { async: false }), {
				allowedTags: [...sanitizeHtml.defaults.allowedTags, "img"],
				allowedAttributes: { a: ["href", "title"], img: ["src", "alt", "width", "height"] },
				transformTags: { a: sanitizeHtml.simpleTransform("a", { target: "_blank", rel: "noreferrer" }) },
			}).trim()
		: "";

/** "M/D/YYYY" → "YYYY-MM-DD"; ISO-ish strings pass through (first 10 chars) */
const day = (s?: string | null) => {
	if (!s) return "";
	const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
	return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : s.slice(0, 10);
};
const today = () => new Date().toLocaleDateString("sv-SE");
const within = (from?: string, to?: string) => !!from && !!to && day(from) <= today() && today() <= day(to);

// ———————————————————————————————————— schoology

export type Material = {
	type: string;
	id?: string;
	title: string;
	url: string;
	body?: string;
	due?: string;
	children?: Material[];
};

const byName = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });

/** the materials/ directory back into a tree (folders = directories, items = .md or files) */
const materialsIn = (rel: string, sid: string): Material[] =>
	list(rel)
		.sort(byName)
		.flatMap((name): Material[] => {
			const full = join(LIFE, rel, name);
			const lst = lstatSync(full);
			if (lst.isDirectory()) {
				if (/\.(attachments|submissions)$/.test(name)) return [];
				return [
					{
						type: "folder",
						title: name,
						url: `${WEB}/course/${sid}/materials`,
						children: materialsIn(`${rel}/${name}`, sid),
					},
				];
			}
			if (lst.isSymbolicLink()) return [{ type: "file", title: name, url: `${WEB}/course/${sid}/materials` }];
			if (!name.endsWith(".md")) return [];
			const { meta, body } = doc(`${rel}/${name}`)!;
			const id = String(meta.id ?? "");
			const title = meta.title ?? name.slice(0, -3);
			const links = meta.attachments?.links ?? [];
			const url =
				meta.type === "assignment"
					? `${WEB}/assignment/${id}/info`
					: meta.type === "page"
						? `${WEB}/page/${id}`
						: meta.type === "document" && links.length === 1 && !meta.attachments?.files
							? links[0].url
							: `${WEB}/course/${sid}/materials/gp/${id}`;
			return [{ type: meta.type ?? "item", id, title, url, body: render(body) || undefined, due: meta.due }];
		});

const flatten = (items: Material[]): Material[] =>
	items.flatMap((m) => (m.children ? flatten(m.children) : [m]));

/** sections of the latest school year that are running today (or have no period dates) */
const currentSections = () => {
	const year = list("schoology")
		.filter((f) => /^\d{4}-\d{4}$/.test(f))
		.at(-1);
	if (!year) return [];
	return list(`schoology/${year}`)
		.map((name) => ({
			dir: `schoology/${year}/${name}`,
			name,
			section: json(`schoology/${year}/${name}/section.json`),
		}))
		.filter(({ section }) => section)
		.filter(({ section }) => {
			const periods: any[] = section.grading_periods ?? [];
			return !periods.length || periods.some((p) => within(p.start, p.end));
		});
};

// ———————————————————————————————————— studentvue

const latestYear = (dir: string) =>
	list(dir)
		.filter((f) => /^\d{4}-\d{4}/.test(f))
		.at(-1);

const currentCourses = (): any[] => {
	const year = latestYear("studentvue/grades");
	if (!year) return [];
	const periods: any[] = json(`studentvue/grades/${year}/periods.json`) ?? [];
	const dirs = list(`studentvue/grades/${year}`).filter((f) => !f.endsWith(".json"));
	const current = periods.find((p) => within(p.startDate, p.endDate));
	const dir = (current && dirs.find((d) => d.startsWith(`${current.index}-`))) ?? dirs.at(-1);
	return dir
		? list(`studentvue/grades/${year}/${dir}`).map((f) => json(`studentvue/grades/${year}/${dir}/${f}`))
		: [];
};

const currentClassList = (): any[] => {
	const year = list("studentvue/schedule").at(-1);
	const terms: any[] = (year && json(`studentvue/schedule/${year}`)) ?? [];
	return (terms.find((t) => within(t.beginDate, t.endDate)) ?? terms.at(-1))?.classLists ?? [];
};

export type Category = { type: string; weight: string; points: string; possible: string; pct: string };
export type Score = { name: string; type: string; date: string; score: string; notes?: string };
export type Grade = { score?: string; mark?: string; categories: Category[]; assignments: Score[] };

const gradeOf = (course: any): Grade | undefined => {
	const mark = course?.marks?.[0];
	if (!mark) return undefined;
	return {
		score: mark.calculatedScoreRaw,
		mark: mark.calculatedScoreString,
		categories: (mark.gradeCalculationSummary ?? []).map((r: any) => ({
			type: r.type,
			weight: r.weight,
			points: r.points,
			possible: r.pointsPossible,
			pct: r.weightedPct,
		})),
		assignments: (mark.assignments ?? []).map((a: any) => ({
			name: a.measure,
			type: a.type,
			date: day(a.dueDate || a.date),
			score: a.displayScore,
			notes: a.notes || undefined,
		})),
	};
};

// ———————————————————————————————————— joined

export type Klass = {
	slug: string;
	name: string;
	period?: number;
	teacher?: string;
	room?: string;
	schoologyUrl?: string;
	materials: Material[];
	updates: { created: string; body: string }[];
	upcoming: { title: string; due: string; url?: string }[];
	grade?: Grade;
};

export type SiteData = { classes: Klass[]; generated: string };

export const load = (): SiteData => {
	const classList = currentClassList();
	const courses = currentCourses();
	const usedSv = new Set<any>();
	const classes: Klass[] = [];
	const key = (name?: string) => simplifyClassName(name ?? "");
	const courseFor = (name: string) => courses.find((c) => key(c.courseName) === key(name));

	for (const { dir, name, section } of currentSections()) {
		const sid = String(section.id);
		const period = /(?:^|-)p(\d+)-/.exec(name)?.[1];
		const sv =
			classList.find((c) => !usedSv.has(c) && period && String(c.period) === period) ??
			classList.find((c) => !usedSv.has(c) && key(c.courseTitle) === key(section.course_title));
		if (sv) usedSv.add(sv);
		const materials = materialsIn(`${dir}/materials`, sid);
		const assignments = flatten(materials).filter((m) => m.type === "assignment");
		const updates = list(`${dir}/updates`)
			.filter((f) => f.endsWith(".md"))
			.map((f) => doc(`${dir}/updates/${f}`)!)
			.sort((a, b) => Number(b.meta.created) - Number(a.meta.created))
			.slice(0, 15)
			.map((u) => ({
				created: new Date(Number(u.meta.created) * 1000).toISOString().slice(0, 10),
				body: render(u.body),
			}));
		const grade = gradeOf(courseFor(section.course_title));
		const svFuture = (grade?.assignments ?? []).filter((a) => /not (due|graded)/i.test(a.score));
		const upcoming = [
			...assignments.filter((a) => a.due).map((a) => ({ title: a.title, due: day(a.due), url: a.url })),
			...svFuture.map((a) => ({ title: a.name, due: a.date })),
		]
			.filter((a, i, all) => a.due >= today() && all.findIndex((o) => o.title === a.title) === i)
			.sort((a, b) => a.due.localeCompare(b.due));
		classes.push({
			slug: "",
			name: section.course_title,
			period: Number(period ?? sv?.period) || undefined,
			teacher: sv?.teacher,
			room: sv?.roomName,
			schoologyUrl: `${WEB}/course/${sid}/materials`,
			materials,
			updates,
			upcoming,
			grade,
		});
	}
	// studentvue-only classes (nothing on schoology)
	for (const c of classList) {
		if (usedSv.has(c)) continue;
		classes.push({
			slug: "",
			name: c.courseTitle,
			period: parseInt(c.period) || undefined,
			teacher: c.teacher,
			room: c.roomName,
			materials: [],
			updates: [],
			upcoming: [],
			grade: gradeOf(courseFor(c.courseTitle)),
		});
	}
	classes.sort((a, b) => (a.period ?? 99) - (b.period ?? 99) || a.name.localeCompare(b.name));
	const taken = new Set<string>();
	for (const c of classes) {
		let slug = c.period
			? `p${c.period}`
			: key(c.name)
					.toLowerCase()
					.replace(/[^a-z0-9]+/g, "-");
		while (taken.has(slug)) slug += "-";
		taken.add(slug);
		c.slug = slug;
	}
	return { classes, generated: new Date().toISOString() };
};
