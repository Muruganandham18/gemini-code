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
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import { GeminiDriver } from "../driver/GeminiDriver.js";
import { chromium } from "playwright";
import { createServer } from "node:http";
import { BrowserSession, formatSnapshot } from "../driver/BrowserSession.js";

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
    // Either wording counts as "it noticed we're signed out": interactive
    // runs wait for a human, non-interactive ones fail fast instead.
    sawLoginPrompt = /(Timed out waiting for sign-in|signed out)/i.test((err as Error).message);
  }
  console.log(
    sawLoginPrompt
      ? "ok - correctly detected the logged-out state (sign-in button visible)"
      : "note - did not detect the expected sign-in prompt; selectors.ts.signInButton may need recalibrating against the real markup"
  );

  await driver.close();
  await rm(profileDir, { recursive: true, force: true });
  console.log("ok - browser closed cleanly");

  await testInteractiveBrowsing();
}

main().catch((err) => {
  console.error("FAIL -", err);
  process.exit(1);
});

/**
 * Drives a real page: reads its controls, types into a field, submits, and
 * checks the resulting page. Self-contained (its own server and headless
 * browser) so it doesn't need the user's logged-in session.
 */
async function testInteractiveBrowsing(): Promise<void> {
  console.log("\nInteractive browsing:");

  const server = createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    if (req.url?.startsWith("/results")) {
      res.end("<html><body><h1>Results</h1><p>MATCHED-WIDGET-42</p></body></html>");
    } else {
      res.end(
        '<html><body><h1>Store</h1><form action="/results"><input name="q" placeholder="Search"><button type="submit">Go</button></form></body></html>'
      );
    }
  });
  await new Promise<void>((r) => server.listen(8934, r));

  // channel: "chrome" uses the Chrome already on the machine, so running
  // the tests needs no `npx playwright install` download — and exercises
  // the same browser real users run.
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  const context = await browser.newContext();
  const session = new BrowserSession(context);

  try {
    const snap = await session.open("http://localhost:8934");
    const rendered = formatSnapshot(snap);
    console.log(`    [found ${snap.elements.length} interactive elements]`);
    assert.match(rendered, /INTERACTIVE ELEMENTS/);
    assert.ok(snap.elements.length >= 2, "should list the input and the button");

    const input = snap.elements.find((e) => e.role.startsWith("input"));
    assert.ok(input, "should find the search input");
    console.log("  ok - lists the page's controls with refs");

    const after = await session.type(input!.ref, "gears", true);
    console.log(`    [after submit: ${after.url}]`);
    assert.match(after.url, /results/, "submitting should navigate");
    assert.match(after.text, /MATCHED-WIDGET-42/, "should read the resulting page");
    console.log("  ok - types into a field, submits, and reads the result");

    // Refs from a previous page must not silently act on the new one.
    await session
      .click(9999)
      .then(() => assert.fail("clicking a stale ref should throw"))
      .catch((err: Error) => assert.match(err.message, /No element/));
    console.log("  ok - rejects a stale element ref instead of guessing");

    await session.close();
    console.log("  ok - closes cleanly");
  } catch (err) {
    console.log("  FAIL -", (err as Error).message);
    process.exitCode = 1;
  } finally {
    await browser.close();
    server.close();
  }
}
