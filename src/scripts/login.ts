import { GeminiDriver } from "../driver/GeminiDriver.js";
import { ensureChromeRunning } from "./openChrome.js";

/**
 * Verifies you're signed in, against the Chrome window `gemini-code
 * open-chrome` opened (and you signed into by hand). Doesn't launch or
 * control the sign-in step itself — see openChrome.ts / README for why.
 */
export async function checkLogin(): Promise<void> {
  const driver = new GeminiDriver();
  await ensureChromeRunning();
  try {
    await driver.attach();
  } catch (err) {
    console.error(
      "[gemini-code] Couldn't attach to Chrome on port 9222.\n" +
        "Try `gemini-code open-chrome` by hand and sign in, then run this again.\n"
    );
    throw err;
  }
  await driver.ensureLoggedIn();
  console.log("[gemini-code] Logged in. Leave that Chrome window open and run `gemini-code`.");
  await driver.close();
}
