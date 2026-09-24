/**
 * StudentVUE → life/studentvue/
 *
 *   grades/<school year>/periods.json                      reporting periods and their dates
 *   grades/<school year>/<n>-<period>/p<N>-<course>.json   one per class: mark, category
 *                                                          breakdown, assignments
 *   schedule/<school year>.json          terms, with the classes in each
 *   days/<YYYY-MM>/<YYYY-MM-DD>.json     timetable (class times, rooms) for every school day
 *                                        this month and next (via the web portal)
 *   attendance/<school year>.json        absences
 *   calendar/<YYYY-MM>.json              school events and no-school days
 *   messages.json                        district/school notices
 *   student.json                         grade level, school, homeroom, counselor
 *   documents/<date> <type> - <comment>.md   report cards, transcripts, …: the text, with
 *                                        the document's fields and its PDF in the
 *                                        frontmatter (see lib/document.ts)
 *
 * Responses are trimmed to the fields worth keeping: StudentVUE repeats every score four
 * ways and pads everything with display flags, GUIDs and relative times.
 */

import { rm } from "node:fs/promises";
import { need } from "../../lib/env.ts";
import { log, setPhase } from "../../lib/log.ts";
import { compact, pick } from "../../lib/pick.ts";
import { safeName, slug } from "../../lib/store.ts";
import { track, type Context } from "../../lib/track.ts";
import { createStudentvue, isoDate, schoolYear, type Studentvue } from "./client.ts";

const today = () => new Date().toLocaleDateString("sv-SE"); // local YYYY-MM-DD

// ———————————————————————————————————— trimming

const trimAssignment = (a: any) => {
	const graded = a.point !== undefined && a.point !== "";
	return pick(a, [
		"gradebookID",
		"measure",
		"type",
		...(a.date !== a.dueDate ? ["date"] : []), // assigned date, usually the same as due
		"dueDate",
		"displayScore",
		...(graded ? ["point", "pointPossible"] : ["points"]), // ungraded: "N Points Possible"
		...(a.scoreType && a.scoreType !== "Raw Score" ? ["scoreType", "scoreCalValue", "scoreMaxValue"] : []),
		"notes",
		"measureDescription",
		"resources",
		"standards",
	]);
};

const trimCourse = (c: any) =>
	compact({
		...pick(c, ["period", "courseName", "courseID", "room", "staff", "staffEMail"]),
		marks: (c.marks ?? []).map((m: any) => {
			const summary = m.gradeCalculationSummary;
			const calcs: any[] = Array.isArray(summary) ? summary : (summary?.assignmentGradeCalc ?? []);
			return compact({
				...pick(m, ["markName", "calculatedScoreString", "calculatedScoreRaw"]),
				// the TOTAL row just restates calculatedScore
				gradeCalculationSummary: calcs
					.filter((r) => r.type !== "TOTAL")
					.map((r) =>
						pick(r, ["type", "weight", "points", "pointsPossible", "weightedPct", "calculatedMark"]),
					),
				assignments: (m.assignments ?? []).map(trimAssignment),
			});
		}),
	});

const classFile = (c: any) =>
	`p${String(c.period ?? "x").split("-")[0]}-${slug(c.courseName ?? c.title ?? "class", 40)}.json`;

// ———————————————————————————————————— change notes

const noteCourseChanges = (ctx: Context, before: any, after: any) => {
	if (!before) return;
	const name = after.courseName;
	const [pm, m] = [before.marks?.[0] ?? {}, after.marks?.[0] ?? {}];
	if (pm.calculatedScoreRaw !== m.calculatedScoreRaw)
		ctx.note(
			`${name}: ${pm.calculatedScoreRaw ?? "–"} → ${m.calculatedScoreRaw ?? "–"} (${m.calculatedScoreString ?? ""})`,
		);
	const seen = new Map<number, any>((pm.assignments ?? []).map((a: any) => [a.gradebookID, a]));
	for (const a of m.assignments ?? []) {
		const p = seen.get(a.gradebookID);
		if (!p) ctx.note(`new in ${name}: ${a.measure} (${a.displayScore})`);
		else if (p.displayScore !== a.displayScore)
			ctx.note(`rescored in ${name}: ${a.measure} ${p.displayScore} → ${a.displayScore}`);
	}
};

// ———————————————————————————————————— parts of the archive

const archiveGrades = async (ctx: Context, sv: Studentvue) => {
	setPhase("fetching gradebooks");
	const first = await sv.maybe("Gradebook", { reportPeriod: "" });
	const periods: any[] = first?.traditionalGradebook?.reportingPeriods ?? [];
	if (!periods.length) return;
	const year = schoolYear(isoDate(periods[0].startDate));
	const current = first.traditionalGradebook.reportingPeriod?.index;
	await ctx.store.writeJson(
		`grades/${year}/periods.json`,
		periods.map((p) => pick(p, ["index", "gradePeriod", "startDate", "endDate"])),
	);
	for (const p of periods) {
		if (isoDate(p.startDate) > today()) continue; // not started: nothing to archive yet
		log(`  grades: ${p.gradePeriod}${p.index === current ? " (current)" : ""}`);
		const book = p.index === current ? first : await sv.call("Gradebook", { reportPeriod: p.index });
		const dir = `grades/${year}/${p.index}-${slug(p.gradePeriod)}`;
		for (const course of book?.traditionalGradebook?.courses ?? []) {
			const trimmed = trimCourse(course);
			const rel = `${dir}/${classFile(course)}`;
			if (p.index === current) noteCourseChanges(ctx, await ctx.store.readJson(rel), trimmed);
			await ctx.store.writeJson(rel, trimmed);
		}
		ctx.store.complete(dir);
	}
};

const archiveSchedule = async (ctx: Context, sv: Studentvue) => {
	setPhase("fetching schedule");
	const all = (
		await sv.call("StudentClassList", {
			loadAllTerms: true,
			conSchOrgYearGU: "",
			conSchTermIndex: "-1",
			termIndex: "-1",
		})
	)?.studentClassScheduleForAllTerms;
	const terms: any[] = all?.termLists ?? [];
	if (terms.length) {
		const year = schoolYear(isoDate(terms[0].beginDate));
		const classesFor = (t: any) =>
			(all.studentClassScheduleForTerms ?? []).find((s: any) => s.thisTermIndex === t.termIndex)
				?.classLists ?? [];
		await ctx.store.writeJson(
			`schedule/${year}.json`,
			terms.map((t) =>
				compact({
					...pick(t, ["termName", "beginDate", "endDate"]),
					classLists: classesFor(t).map((c: any) =>
						pick(c, ["period", "courseTitle", "roomName", "teacher", "teacherEmail", "sectionGU"]),
					),
				}),
			),
		);
	}
};

/**
 * Some schools list a block as back-to-back periods of the same section (01 8:20–9:05,
 * 02 9:05–9:50); join those into one class (01-02 8:20–9:50).
 */
const joinBlocks = (classes: any[]) =>
	classes.reduce((out: any[], c) => {
		const prev = out.at(-1);
		if (prev && c.sectionGU && prev.sectionGU === c.sectionGU && prev.endTime === c.startTime) {
			prev.period = `${String(prev.period).split("-")[0]}-${c.period}`;
			prev.endTime = c.endTime;
		} else out.push({ ...c });
		return out;
	}, []);

/**
 * One file per school day for this month and next, from the portal's DayContent (the
 * app's calendar view). The window moves once a month, so new files land in one batch;
 * after that a diff means the timetable itself changed (late start, snow day, …).
 */
const archiveDays = async (ctx: Context, sv: Studentvue) => {
	setPhase("fetching timetables");
	const { service } = await sv.web();
	const now = new Date();
	const months = [0, 1].map((k) => new Date(now.getFullYear(), now.getMonth() + k, 1));
	const dates = months.flatMap((m) =>
		Array.from(
			{ length: new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate() },
			(_, i) => new Date(m.getFullYear(), m.getMonth(), i + 1),
		),
	);
	const mmddyyyy = (d: Date) =>
		`${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;
	let schoolDays = 0;
	for (const d of dates) {
		const asked = d.toLocaleDateString("sv-SE");
		const day = await service("DayContent", { date: mmddyyyy(d) });
		// a non-school day answers with the next school day instead
		if (isoDate(day?.date) !== asked) continue;
		const schools = (day.schools ?? []).filter((s: any) => s.classes?.length);
		if (!schools.length) continue;
		schoolDays++;
		await ctx.store.writeJson(
			`days/${asked.slice(0, 7)}/${asked}.json`,
			schools.map((s: any) =>
				compact({
					...pick(s, ["schoolName", "bellSchedName"]),
					classes: joinBlocks(
						s.classes.map((c: any) =>
							pick(c, ["period", "className", "startTime", "endTime", "roomName", "teacherName", "sectionGU"]),
						),
					),
				}),
			),
		);
	}
	log(`  timetables: ${schoolDays} school days in ${dates.length} days`);
	for (const m of months) ctx.store.complete(`days/${m.toLocaleDateString("sv-SE").slice(0, 7)}`);
};

const archiveDocuments = async (ctx: Context, sv: Studentvue) => {
	setPhase("fetching documents");
	const docs = (await sv.maybe("GetStudentDocuments"))?.studentDocuments;
	if (!docs) return;
	const list: any[] = docs.studentDocumentDatas ?? [];
	// each document's fields live in its own frontmatter (this used to be a separate list)
	await rm(ctx.store.abs("documents.json"), { force: true });
	log(`  ${list.length} documents`);
	for (const d of list) {
		const ext = /\.[a-z0-9]{1,6}$/i.exec(d.documentFileName ?? "")?.[0] ?? ".pdf";
		const title = `${d.documentType}${d.documentComment ? ` - ${d.documentComment}` : ""}`;
		const name = safeName(`${isoDate(d.documentDate)} ${title}${ext}`);
		const ok = await ctx.files.link(
			`documents/${name}`,
			async () => {
				const content = await sv.call("GetStudentDocumentContent", { documentGU: d.documentGU });
				const b64 = content?.studentAttachedDocumentData?.documentDatas?.[0]?.base64Code;
				if (!b64) throw new Error("no content returned");
				ctx.note(`new document: ${title}`);
				return Buffer.from(b64, "base64");
			},
			null,
			pick(d, ["documentGU", "documentDate", "documentType", "documentComment"]),
		);
		if (!ok) ctx.warn(`document ${d.documentGU} could not be downloaded`);
	}
	ctx.store.complete("documents");
};

await track("studentvue", async (ctx) => {
	const sv = createStudentvue({
		host: need("STUDENTVUE_HOST"),
		username: need("STUDENTVUE_USERNAME"),
		password: need("STUDENTVUE_PASSWORD"),
	});
	const { store } = ctx;
	const year = schoolYear(today());

	await archiveSchedule(ctx, sv);
	await archiveGrades(ctx, sv);
	try {
		await archiveDays(ctx, sv);
	} catch (e) {
		ctx.warn(`timetables: ${(e as Error).message}`);
	}

	setPhase("fetching attendance, calendar, messages, student info");
	const attendance = await sv.maybe("GetStudentAttendanceList");
	const absences = attendance?.periodAttendance?.absences ?? attendance?.dailyAttendance?.absences;
	if (absences)
		await store.writeJson(
			`attendance/${year}.json`,
			absences.map((a: any) =>
				compact({
					...pick(a, ["absenceDate", "reason", "codeAllDayDescription", "note"]),
					periods: (a.periods ?? []).map((p: any) => pick(p, ["number", "course", "reason", "note"])),
				}),
			),
		);

	const calendar = (await sv.maybe("GetCalendarData"))?.calendarListingData;
	const month = isoDate(calendar?.monthBegDate).slice(0, 7);
	if (month)
		await store.writeJson(
			`calendar/${month}.json`,
			// dayType 2 entries are gradebook assignments, already in grades/
			(calendar.eventLists ?? [])
				.filter((e: any) => e.dayType !== 2)
				.map((e: any) => pick(e, ["date", "title", "dayType", "startTime"])),
		);

	const messages = (await sv.maybe("GetPXPContentMessage"))?.pxpMessagesData;
	if (messages)
		await store.writeJson(
			"messages.json",
			[
				...(messages.messageListings ?? []),
				...(messages.synergyMailMessageListingByStudents ?? []).flatMap(
					(s: any) => s.synergyMailMessageListings ?? [],
				),
			].map((m: any) =>
				pick(m, ["beginDate", "endDate", "subjectNoHTML", "content", "from", "module", "attachmentDatas"]),
			),
		);

	const student = (await sv.maybe("GetStudentInfoData"))?.studentInfoDetailXML;
	if (student)
		await store.writeJson(
			"student.json",
			pick(student, ["grade", "currentSchool", "homeRoom", "homeRoomTch", "counselorName", "counselorEmail"]),
		);

	await archiveDocuments(ctx, sv);
});
