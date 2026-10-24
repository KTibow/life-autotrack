/**
 * `pnpm google:login`: open the Chromium profile in a window and make sure it's signed in
 * to Google, meaning Drive accepts its cookies (not just that a session cookie exists). If
 * it isn't, sign in there (2FA included); this waits until Drive works, then closes the
 * window. Needs someone at the machine's screen.
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
		"Drive still didn't accept the session after 15 minutes; the window was closed. Run `pnpm google:login` again when you're at the screen.",
	);
	process.exit(1);
}
console.log(
	"Signed in, and Drive accepts the session. Tracker runs will use it from now on, without opening a window.",
);
