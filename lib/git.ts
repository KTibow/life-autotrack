/**
 * Committing a facet's changes to the life repo without stepping on anything:
 *
 * - one commit mutex across all facets (life/.git/autotrack/commit.lock), held only for
 *   the add+commit, so facets fetch in parallel but never race on the index
 * - `git commit --only` with an explicit pathspec (the facet's scope + the blobs it
 *   used), so a human's staged work elsewhere is never swept into a bot commit
 * - pathspecs go through a file, so thousands of blobs can't overflow argv
 * - nothing happens mid-merge/rebase; the files stay on disk for the next run
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { waitLock } from "./lock.ts";

const IDENTITY = {
	GIT_AUTHOR_NAME: "life-autotrack",
	GIT_AUTHOR_EMAIL: "life-autotrack@localhost",
	GIT_COMMITTER_NAME: "life-autotrack",
	GIT_COMMITTER_EMAIL: "life-autotrack@localhost",
};

export const git = (cwd: string, args: string[], input?: string): Promise<string> =>
	new Promise((resolve, reject) => {
		const child = execFile(
			"git",
			args,
			{ cwd, env: { ...process.env, ...IDENTITY }, maxBuffer: 256 * 1024 * 1024 },
			(error, stdout, stderr) => {
				if (error) reject(new Error(`git ${args[0]} failed: ${stderr.trim() || error.message}`));
				else resolve(stdout);
			},
		);
		if (input !== undefined) child.stdin!.end(input);
	});

export const assertRepo = (life: string) => {
	if (!existsSync(join(life, ".git")))
		throw new Error(`${life} is not a git repo — create it with: mkdir ${life} && git -C ${life} init`);
};

const busy = (life: string) =>
	["MERGE_HEAD", "REBASE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "index.lock"].find((f) =>
		existsSync(join(life, ".git", f)),
	);

export type CommitResult = { committed: boolean; changes: string[]; busy?: string };

/**
 * Stage and commit exactly `paths` (repo-relative; a directory covers deletions inside
 * it). `subject` gets change counts appended; `notes` open the body.
 */
export const commitPaths = async (
	life: string,
	paths: string[],
	subject: string,
	notes: string[] = [],
): Promise<CommitResult> => {
	const dir = join(life, ".git", "autotrack");
	const lock = await waitLock(join(dir, "commit.lock"), 10 * 60_000, 30 * 60_000);
	try {
		const blocker = busy(life);
		if (blocker) {
			return { committed: false, changes: [], busy: blocker };
		}
		// a pathspec matching nothing is an error to git; blobs are never deleted, and a
		// scope dir only vanishes if a human removed it (commit that by hand)
		const present = paths.filter((p) => existsSync(join(life, p)));
		if (!present.length) return { committed: false, changes: [] };
		const pathspecFile = join(dir, "pathspec");
		await writeFile(pathspecFile, present.join("\0"));
		const fromFile = [`--pathspec-from-file=${pathspecFile}`, "--pathspec-file-nul"];

		await git(life, ["add", "-A", ...fromFile]);
		const roots = [...new Set(present.map((p) => p.split("/")[0]))];
		const status = await git(life, [
			"diff",
			"--cached",
			"--name-status",
			"-z",
			"--no-renames",
			"--",
			...roots,
		]);
		const fields = status.split("\0").filter(Boolean);
		const changes: string[] = [];
		for (let i = 0; i + 1 < fields.length; i += 2) changes.push(`${fields[i]} ${fields[i + 1]}`);
		if (!changes.length) return { committed: false, changes };

		const isBlob = (line: string) => line.slice(2).startsWith("blobs/");
		const count = (c: string) => changes.filter((l) => l[0] === c && !isBlob(l)).length;
		const blobs = changes.filter(isBlob).length;
		const listed = changes.filter((l) => !isBlob(l));
		const tally = `+${count("A")} ~${count("M")} -${count("D")}${blobs ? `, ${blobs} blobs` : ""}`;
		const body = [
			...notes,
			...(notes.length ? [""] : []),
			...listed.slice(0, 60),
			...(listed.length > 60 ? [`… and ${listed.length - 60} more`] : []),
		];
		await git(
			life,
			["commit", "--quiet", "--only", "--file=-", ...fromFile],
			`${subject} · ${tally}\n\n${body.join("\n")}\n`,
		);
		return { committed: true, changes };
	} finally {
		await lock.release();
	}
};
