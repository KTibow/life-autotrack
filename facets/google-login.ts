/**
 * `pnpm google:login`: start (or find) the Chromium on CHROMIUM_PROFILE_DIR and say whether
 * it's signed in to Google. If not, the sign-in page is open in that window: sign in
 * there (2FA included), then run this again to confirm.
 */

import { openGoogle } from "../lib/google/browser.ts";
import { log } from "../lib/log.ts";

const google = await openGoogle();
if (google) {
	const res = await google.fetch("https://drive.google.com/drive/my-drive");
	log(
		res
			? "signed in: Drive answers with this session"
			: "cookies present, but Drive wants a sign-in: finish it in the window",
	);
	await res?.body?.cancel();
}
process.exit(google ? 0 : 1);
