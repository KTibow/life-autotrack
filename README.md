# life-autotrack

Archives the places school life happens (Schoology, StudentVUE, more later) into a
local git repo, `life/`, as pretty JSON plus markdown digests. Every run that finds a
change makes one commit, so anything watching the repo (a `post-commit` hook, an
openclaw-style bot polling `git log`) can react to diffs. Optionally publishes a small
private site of the current state to R2.

## Setup

```sh
mkdir life
git clone https://github.com/KTibow/life-autotrack
cd life && git init && cd ..
cd life-autotrack && pnpm install && cp .env.example .env   # then fill in .env
```

Node ≥ 24 (TypeScript runs natively, with no build step) and [uv](https://docs.astral.sh/uv/)
(documents become markdown with `uvx markitdown`). LibreOffice (`soffice`) is optional: with
it, Word/PowerPoint uploads also get a PDF and old `.doc`/`.ppt` files can be read. Then
cron it yourself, e.g.:

```cron
*/30 6-22 * * *  cd ~/life-autotrack && pnpm -s schoology
10 6-22 * * *    cd ~/life-autotrack && pnpm -s studentvue
20 * * * *       cd ~/life-autotrack && pnpm -s weather
5,35 6-22 * * *  cd ~/life-autotrack && pnpm -s site
```

Overlapping runs are safe. A facet that is already running skips (and exits 0), and
different facets fetch in parallel but take turns committing.

| command           | does                                               |
| ----------------- | -------------------------------------------------- |
| `pnpm schoology`  | archive Schoology → `life/schoology/`              |
| `pnpm studentvue` | archive StudentVUE → `life/studentvue/`            |
| `pnpm weather`    | archive the NWS forecast → `life/weather/`         |
| `pnpm site`       | build the site from `life/`, sync it to R2         |
| `pnpm site:dry`   | build (and diff against R2 if credentials are set) |
| `pnpm site:dev`   | vite dev server over the current `life/`           |
| `pnpm check`      | typecheck                                          |

## The life repo

```
life/
  blobs/<ab>/<sha256>                  every downloaded file, content-addressed, stored once
  trees/<Drive folder id>/             every linked Drive folder's contents, stored once
  schoology/                           one directory per facet ("scope"); facets only write here
    2026-2027/s1-p3-us-history/          <term>-p<period>-<course>, parsed from the section title
    ongoing/robotics-club/               a section whose grading periods span years (clubs)
      section.json                         ids, titles, grading period dates
      materials/Unit 1/HW 1.md             the materials tree as folders; items are markdown
      materials/Unit 1/HW 1.attachments/   with fields as frontmatter; documents as markdown,
                                           other files as symlinks, incl. linked Google Docs
                                           and Slides (.md), Sheets (.xlsx) and Drive folders
                                           (a symlink named as the folder, into trees/)
      materials/Unit 1/HW 1.submissions/   your own submitted files
      materials/Unit 1/Syllabus.md         a document that is just a file
      updates/2026-09-22 14-05.md  events/2026-10-01 Field trip.md
  studentvue/
    grades/2026-2027/0-s1-mid-term/p3-us-history.json   one file per class per reporting period
    schedule/2026-2027.json              terms and their classes
    days/2026-09/2026-09-22.json         timetable for every school day this month and next
    attendance/ calendar/ messages.json student.json documents/   (report cards etc., as .md)
    subs/2026-09/2026-09-24.json          the school's substitute teachers that day (needs
                                          STUDENTVUE_SCHOOL_GU; only today is fetchable, so
                                          past days keep what they got)
  weather/
    days/2026-09/2026-09-24.json         NWS day/night forecast and hourly forecast; past hours
                                         keep their last forecast
  pages/
    example.org/some/page.md             one .md per URL in PAGES, laid out by the site's own
                                         path; images (and linked Drive files) beside it
```

- **One copy of everything, trimmed.** Each object is stored once, in the file where
  you'd look for it, as the source's own fields (original names) minus what nobody
  would read or count: repeated score formats, display flags, GUIDs, relative times,
  empty values. There are no digests or summary files; if a view feels necessary, the
  original is trimmed further instead. Prose (assignment descriptions, pages, updates)
  is the body of a markdown file whose frontmatter holds the other fields, one
  `key: <json>` per line, so text diffs read like text.
- **Laid out like the source.** `tree life/schoology` looks like the website: courses
  you can find with one `ls`, folders and items by their titles. Every markdown file's
  frontmatter carries the source's `type`, `id` and `url`. Grades live only in StudentVUE.
- **Documents are markdown.** Google Docs and Slides, and uploaded PDF, Word and
  PowerPoint files, are each one `<name>.md` (text, tables, speaker notes) with their
  images in `<name>.images/`, full size, in document order. The frontmatter points into
  `blobs/` for the rest: `pdf` (the PDF: the upload itself, Google's export, or
  LibreOffice's print of a Word/PowerPoint file) and, for other uploads, `source` (the
  file as uploaded, named `file`). A Google file's PDF is only re-fetched when its text
  or images change. Anything that can't be converted is kept as the file it is.
- **Files have many names.** Bytes live once in `blobs/` (sha256). Each place a file
  appears gets a relative symlink with a human name; those links are also the download
  cache (a moved item's files are recognized by name and size, not refetched). `find -lname '*<sha>'` gives every name a file has had. Blobs are marked
  `binary` so they stay out of text diffs. Drive folders work the same way: a folder's
  contents live once in `trees/<id>/` (its subfolders are links to their own trees),
  and every place it's linked from gets a symlink named as the folder. It's listed and
  synced once per run however many places link it.
- **Files fill in over runs.** Every item is written every run, with its files' metadata
  and a `url` to its page, but each section downloads at most `SCHOOLOGY_FILES_PER_RUN`
  new files from Schoology per run (your own submissions don't wait; Drive links sync as usual). A class's few new files a week
  arrive right away; a club's shelf of PDFs trickles in without hammering Schoology.
- **Failures never look like deletions.** Stale files are only pruned from a directory
  whose data was fully fetched in that run. Past-term sections stay in place.
- **Commits are scoped.** A facet commits only its own directory plus the blobs it
  references (`git commit --only`), so your own staged work is never swept in. It
  won't commit during a merge or rebase. The author is `life-autotrack`, and the
  subject line summarizes the change, e.g. `studentvue: Algebra 2: 88.0 → 90.5 (B+)
and 1 more · +0 ~1 -0`, with the full change list in the body.
- **Progress is logged** with elapsed time, plus a heartbeat every 15s during a run.

## Google (Drive links)

Links to Drive in Schoology (attached, or in an item's text) are followed and archived
next to the item, named as they're named in Drive. There's no OAuth app: requests use the
cookies of a real Chromium on a profile of its own (`CHROMIUM_PROFILE_DIR`).

- `pnpm google:login` opens that profile in a window on the machine's screen (found
  automatically over SSH). Sign in there, 2FA and all; it waits, checks Drive works,
  and closes.
- Tracker runs start it headless, let it load Drive so Google refreshes the session
  into the profile, take the cookies, and close it; no display needed. If the session
  ever lapses, runs skip Drive, keep what's archived, and say to run `google:login`.
- The profile runs with `--password-store=basic`, so it doesn't depend on a desktop
  keyring and can be signed in on one machine and copied to another.
- Links inside those files (a Doc's links, a deck's hyperlinks and speaker notes, a
  Sheet's cells) are followed too, into `<file>.attachments/`, up to
  `DRIVE_LINK_DEPTH` hops.
- Docs → `.md` (all tabs, from the HTML export so images are full resolution), Slides →
  `.md` (from the `.pptx`, with speaker notes), each with a PDF export (see above).
- Sheets → `.xlsx`, Drawings → `.png`, uploads as uploaded (documents as markdown),
  folders as directories in `trees/` (see above). Exports are normalized so an unchanged file
  re-exports to identical bytes; Google-native files are rechecked when their folder
  says they changed, or every `<FACET>_RECHECK_HOURS` (`SCHOOLOGY_`, `SITES_`, `PAGES_`; default 24, sites 336 = two weeks).

## Adding a facet

```ts
// facets/web/index.ts
import { pick } from "../../lib/pick.ts";
import { track } from "../../lib/track.ts";

await track("web", async ({ store, files, note, warn }) => {
	await store.writeJson("thing.json", pick(data, ["id", "title"])); // → life/web/thing.json
	await store.writeDoc("pages/1.md", { id: 1, title }, markdown); // prose + frontmatter
	await files.link("files/page.pdf", () => download(u)); // fetched only if no link exists yet
	note("thing changed"); // becomes the commit subject
	store.complete("."); // everything under life/web/ was fetched: prune leftovers
});
```

`lib/` covers the hard parts: `lock.ts` (stale-safe cross-process locks), `store.ts`
(scoped atomic writes, blobs, symlinks, pruning), `files.ts` (download cache),
`git.ts` (scoped commits), `track.ts` (ties it together).

## Site

`site/` is plain Vite. `index.html` carries every class's data inline as JSON (it's the
only file that changes when data does, served `no-cache`). The JS/CSS are
content-hashed and `immutable`, so switching classes (hash routes, ←/→) never hits the
network. It's uploaded under `PUBLISH_PREFIX/` in the bucket, and only changed files
are PUT. Files in `blobs/` are never uploaded; links go to Schoology.
