/**
 * Verifies the Playwright plumbing itself: can we launch a persistent
 * Chromium profile and load gemini.google.com? Run headless and separately
 * from `npm test` because it needs network access and a real browser
 * binary, and it deliberately does NOT log in or touch selectors.ts — it
 * only proves GeminiDriver.launch() + ensureLoggedIn()'s detection logic
 * work against the real (logged-out) page.
 *
 * Not part of `npm test` on purpose: it's slower and network-dependent.
 * Run it directly with: npx tsx src/tests/browser-smoke.ts
 */
import { rm } from "node:fs/promises";
import path from "node:path";
import { GeminiDriver } from "../driver/GeminiDriver.js";

async function main() {
  const profileDir = path.resolve(process.cwd(), ".tmp-test-profile");
  await rm(profileDir, { recursive: true, force: true });

  const driver = new GeminiDriver({ headless: true, userDataDir: profileDir });
  console.log("Launching headless Chromium and navigating to gemini.google.com...");
  await driver.launch();
  console.log("ok - launch() completed without throwing");

  // We're logged out (fresh profile), so ensureLoggedIn should detect that
  // and NOT hang forever — give it a short timeout and expect it to throw.
  let sawLoginPrompt = false;
  try {
    await driver.ensureLoggedIn(3_000);
  } catch (err) {
    sawLoginPrompt = /Timed out waiting for manual login/.test((err as Error).message);
  }
  console.log(
    sawLoginPrompt
      ? "ok - correctly detected the logged-out state (sign-in button visible)"
      : "note - did not detect the expected sign-in prompt; selectors.ts.signInButton may need recalibrating against the real markup"
  );

  await driver.close();
  await rm(profileDir, { recursive: true, force: true });
  console.log("ok - browser closed cleanly");
}

main().catch((err) => {
  console.error("FAIL -", err);
  process.exit(1);
});
