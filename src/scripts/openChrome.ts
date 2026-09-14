import { spawn } from "node:child_process";
import { resolveProfileDir } from "../driver/GeminiDriver.js";

export const DEBUG_PORT = 9222;

/**
 * Launches a real, completely normal Google Chrome window — no automation
 * flags, no Playwright involvement — with remote debugging enabled so a
 * later `gemini-code` / `gemini-code login` can attach to it. Log in to
 * Gemini by hand in the window this opens, exactly like you always do;
 * Google's sign-in flow never sees anything automated, because at this
 * point nothing is.
 *
 * Uses a dedicated profile directory (not your everyday Chrome profile),
 * both because Chrome requires a non-default profile to allow remote
 * debugging at all, and to keep this cleanly separate from your normal
 * browsing — it will not touch your regular Chrome windows or data.
 */
export function openChrome(): void {
  const profileDir = resolveProfileDir();

  console.log(`[gemini-code] Launching a normal Google Chrome window (debug port ${DEBUG_PORT})`);
  console.log(`[gemini-code] Profile: ${profileDir}`);
  console.log(
    "\nSign in to Gemini by hand in the window that opens — this is your real Chrome, not an " +
      "automated one, so Google's sign-in works normally. Once you're signed in, leave this window " +
      "open and run `gemini-code` in another terminal.\n"
  );

  const child = spawn(
    "open",
    [
      "-n",
      "-a",
      "Google Chrome",
      "--args",
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${profileDir}`,
      "https://gemini.google.com/app",
    ],
    { stdio: "inherit" }
  );

  child.on("error", (err) => {
    console.error("[gemini-code] Failed to launch Chrome:", err.message);
    process.exit(1);
  });
}
