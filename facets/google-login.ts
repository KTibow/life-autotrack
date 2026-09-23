/**
 * `pnpm google:login`: open the Chromium profile in a window and make sure it's signed in
 * to Google. If it isn't, sign in there (2FA included); this waits, checks Drive works,
 * and closes the window. Needs someone at the machine's screen.
 */

import { connectGoogle } from "../lib/google/browser.ts";

const c = await connectGoogle({ interactive: true });
if (c.state === "unconfigured") {
	console.log(
		"Set CHROMIUM_PROFILE_DIR in .env first (a directory for a Chromium profile used only by life-autotrack).",
	);
	process.exit(1);
}
if (c.state === "failed") {
	console.log(`Couldn't start Chromium.\n${c.error}`);
	process.exit(1);
}
if (c.state === "signed-out") {
	console.log(
		"Still not signed in after 15 minutes; the window was closed. Run `pnpm google:login` again when you're at the screen.",
	);
	process.exit(1);
}
const res = await c.google.fetch("https://drive.google.com/drive/my-drive");
await res?.body?.cancel();
if (!res) {
	console.log(
		"The browser is signed in, but Drive still asks for a sign-in with this session. Run `pnpm google:login` again; if it keeps happening, paste the output.",
	);
	process.exit(1);
}
console.log(
	"Signed in, and Drive works with this session. Tracker runs will use it from here (headless, no window).",
);
