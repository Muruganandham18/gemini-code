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
/** True when a debug-enabled Chrome is already accepting CDP connections. */
export async function isChromeReachable(port = DEBUG_PORT, timeoutMs = 1_500): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://localhost:${port}/json/version`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Makes sure a debug-enabled Chrome is running, launching one if it isn't.
 *
 * Launching a browser is not the same thing as automating a login — this
 * only starts the window. Signing in stays manual (and, because the profile
 * persists cookies, is a one-time thing rather than a per-run step).
 *
 * Returns true if it had to launch one, so the caller can explain the wait.
 */
export async function ensureChromeRunning(log: (msg: string) => void = console.log): Promise<boolean> {
  if (await isChromeReachable()) return false;

  log("No debug Chrome found — launching one...");
  launchChrome();

  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 750));
    if (await isChromeReachable()) return true;
  }
  throw new Error(
    `Launched Chrome but port ${DEBUG_PORT} never came up. Try \`gemini-code open-chrome\` by hand, ` +
      `and check no other Chrome is already using the profile directory.`
  );
}

/** Spawns the browser window (no waiting, no output). */
function launchChrome(): void {
  const profileDir = resolveProfileDir();
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
    { stdio: "ignore", detached: true }
  );
  child.unref();
}

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
