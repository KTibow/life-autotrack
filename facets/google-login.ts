/**
 * `pnpm google:login`: start (or find) the Chromium on CHROMIUM_PROFILE_DIR and check that
 * it's signed in to Google. If not, its window is showing the sign-in page: sign in there
 * (2FA included), then run this again to confirm.
 */

import { connectGoogle } from "../lib/google/browser.ts";

const c = await connectGoogle();
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
		"Not signed in yet. The Chromium window on this machine's screen is showing Google's sign-in page:\n" +
			"sign in there with the account whose Drive files you want (2FA included), then run `pnpm google:login` again.",
	);
	process.exit(1);
}
const res = await c.google.fetch("https://drive.google.com/drive/my-drive");
await res?.body?.cancel();
if (!res) {
	console.log(
		"Almost: the browser is signed in, but Drive still asks for a sign-in. Finish it in the Chromium window, then run this again.",
	);
	process.exit(1);
}
console.log(
	"Signed in. Drive works with this session; runs will pick it up from here. Leave the Chromium window open.",
);
