import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import path from "node:path";
import { homedir } from "node:os";
import { existsSync, mkdirSync } from "node:fs";
import { selectors } from "./selectors.js";
import type { IGeminiDriver, GeminiResponse } from "./IGeminiDriver.js";
import { resolveModel, modelHelp, EXTENDED_THINKING } from "./models.js";

const GEMINI_URL = "https://gemini.google.com/app";

/**
 * Timeouts. Generous by default and env-tunable: Gemini can think for a
 * long time on a big prompt (especially on Pro or with extended thinking),
 * and a response that's still streaming is not a failure.
 */
export const TIMEOUTS = {
  response: Number(process.env.GEMINI_CODE_RESPONSE_TIMEOUT_MS ?? 300_000),
  attachment: Number(process.env.GEMINI_CODE_UPLOAD_TIMEOUT_MS ?? 120_000),
  appShell: Number(process.env.GEMINI_CODE_SHELL_TIMEOUT_MS ?? 60_000),
};
/**
 * Where the Chrome profile lives.
 *
 * Global (~/.gemini-code/profile) so one login works from every project
 * directory once this is installed as a CLI — but an existing
 * ./.gemini-code-profile in the current project still wins, so upgrading
 * doesn't silently orphan a session you already signed into.
 * GEMINI_CODE_PROFILE overrides both.
 */
export function resolveProfileDir(cwd = process.cwd()): string {
  if (process.env.GEMINI_CODE_PROFILE) return path.resolve(process.env.GEMINI_CODE_PROFILE);
  const local = path.resolve(cwd, ".gemini-code-profile");
  if (existsSync(local)) return local;
  return path.join(homedir(), ".gemini-code", "profile");
}

export interface GeminiDriverOptions {
  /** Where the persistent Chrome profile (cookies, login session) is stored. */
  userDataDir?: string;
  /** Run with a visible window. Keep this true — headless makes you look like a bot. */
  headless?: boolean;
  /**
   * Playwright browser channel. Default "chrome" launches your real,
   * installed Google Chrome rather than Playwright's bundled "Chrome for
   * Testing" binary — Google's login flow actively detects and blocks
   * sign-in on the latter ("this browser or app may not be secure"), since
   * it's a synthetic test build, not a regular consumer browser. Pass
   * undefined only if real Chrome isn't installed (`npx playwright install
   * chromium` as a fallback), but expect the login-block issue then.
   */
  channel?: "chrome" | undefined;
}

/**
 * Drives the Gemini web app through a real, persistent Chrome profile.
 *
 * One GeminiDriver instance = one open tab = one Gemini conversation thread.
 * Conversation memory is whatever Gemini's web UI itself keeps for that
 * thread — this class never manages context/history on its own.
 */
export class GeminiDriver implements IGeminiDriver {
  private context: BrowserContext | undefined;
  private page: Page | undefined;
  /** Set only by attach() — the CDP client handle, so close() can disconnect it. */
  private connection: Browser | undefined;
  /** Last-read picker label, e.g. "Flash Extended" — used to detect toggle state. */
  private currentModelLabel = "";
  private readonly userDataDir: string;
  private readonly headless: boolean;
  private readonly channel: "chrome" | undefined;
  // false when attach()ed to a browser the user launched themselves — in
  // that case close() must never touch it (see close()'s comment).
  private ownsBrowser = true;
  // true for a tab created by spawnTab(): close() closes that page only.
  private ownsPage = false;
  // How many model responses existed at the last sendPrompt(), so we can
  // tell a fresh reply apart from the previous turn's.
  private responseCountBeforeSend = 0;

  constructor(opts: GeminiDriverOptions = {}) {
    this.userDataDir = opts.userDataDir ?? resolveProfileDir();
    this.headless = opts.headless ?? false;
    this.channel = "channel" in opts ? opts.channel : "chrome";
  }

  /**
   * Launches and controls a brand-new Chrome instance end to end, sign-in
   * included. Google's login flow actively detects browsers driven over
   * the DevTools protocol (which is what Playwright always is, regardless
   * of channel) and can refuse to complete sign-in on them
   * ("this browser or app may not be secure") — that's Google's own
   * anti-automation control working as intended, not a bug here, and nothing
   * in this codebase tries to spoof or evade it. Prefer attach() below,
   * which sidesteps the problem entirely by never automating the login
   * step. Kept as a fallback for everything *after* login, or for accounts
   * where Google doesn't block it.
   */
  async launch(): Promise<void> {
    this.context = await chromium.launchPersistentContext(this.userDataDir, {
      headless: this.headless,
      channel: this.channel,
      viewport: { width: 1280, height: 900 },
    });
    this.page = this.context.pages()[0] ?? (await this.context.newPage());
    await this.page.goto(GEMINI_URL, { waitUntil: "domcontentloaded" });
    await this.waitForAppShell();
  }

  /**
   * Attaches to a Chrome window YOU already launched and signed into by
   * hand (see `npm run open-chrome` / README) — a completely normal,
   * unmodified, human-driven sign-in, so Google's automation detection
   * never enters the picture. Everything after this point (sending
   * prompts, reading responses) is automated as usual; only the
   * security-sensitive login step is deliberately kept manual.
   */
  async attach(cdpUrl = "http://localhost:9222"): Promise<void> {
    const browser = await chromium.connectOverCDP(cdpUrl);
    this.ownsBrowser = false;
    // Keep the handle so close() can drop the CDP connection. Without this
    // the open websocket keeps Node's event loop alive and the process
    // never exits — scripts appeared to hang long after finishing.
    this.connection = browser;
    this.context = browser.contexts()[0] ?? (await browser.newContext());

    // Claim a tab nobody else is driving. Several gemini-code instances can
    // share one browser, and taking "the first Gemini tab" meant a second
    // instance would type into a tab another one was mid-conversation in —
    // both then fight over the same composer.
    const candidates = this.context.pages().filter((p) => p.url().includes("gemini.google.com"));
    let claimed: Page | undefined;
    for (const candidate of candidates) {
      if (!(await this.isTabOwnedByAnother(candidate))) {
        claimed = candidate;
        break;
      }
    }

    if (!claimed) {
      claimed = await this.context.newPage();
      await claimed.goto(GEMINI_URL, { waitUntil: "domcontentloaded" });
    } else if (!claimed.url().includes("gemini.google.com")) {
      await claimed.goto(GEMINI_URL, { waitUntil: "domcontentloaded" });
    }

    this.page = claimed;
    await this.claimTab(claimed);
    await this.waitForAppShell();
  }

  /**
   * Gemini is a client-rendered Angular app: `domcontentloaded` fires on an
   * near-empty shell, well before the sign-in button or composer exist in
   * the DOM. Without this, ensureLoggedIn()'s isVisible() check races the
   * app's own render and reads "not present yet" as "not logged in" — or
   * worse, as already logged in. Wait for either state to actually appear.
   */
  private async waitForAppShell(timeoutMs = TIMEOUTS.appShell): Promise<void> {
    const page = this.requirePage();
    await Promise.race([
      page.locator(`${selectors.signInButton} >> visible=true`).first().waitFor({ timeout: timeoutMs }),
      page.locator(selectors.composerInput).first().waitFor({ timeout: timeoutMs }),
    ]).catch(() => {
      throw new Error(
        "Timed out waiting for the Gemini app to render (neither the sign-in button nor the " +
          "composer appeared). The page structure may have changed — recalibrate selectors.ts."
      );
    });
  }

  /**
   * Blocks until the profile is authenticated. If the sign-in button is
   * visible, it means this persistent profile has never logged in — that
   * has to happen once, by hand, in the visible window this opened.
   * We never touch credentials here.
   */
  async ensureLoggedIn(timeoutMs = 5 * 60_000): Promise<void> {
    const page = this.requirePage();
    // `.first()` alone isn't enough here: the page has multiple "Sign in"
    // elements and the first in DOM order is a hidden one (a collapsed nav
    // item), which would make isVisible() false even while a real,
    // clickable sign-in prompt is on screen. `>> visible=true` filters the
    // match list down to visible elements before `.first()` picks one.
    const signIn = page.locator(`${selectors.signInButton} >> visible=true`).first();

    if (!(await signIn.isVisible().catch(() => false))) return; // already signed in

    // Sessions do expire, so this isn't only a first-run path. Put the
    // window in front of the user rather than silently blocking on a
    // browser they may not even have visible.
    await page.bringToFront().catch(() => undefined);

    // Waiting 5 minutes for a human makes no sense with piped stdin — in a
    // script there is nobody to sign in, so say so and fail immediately
    // instead of hanging until the timeout.
    if (!process.stdin.isTTY) {
      throw new Error(
        "Your Gemini session is signed out, and this isn't an interactive terminal.\n" +
          "Run `gemini-code login` yourself, sign in in the Chrome window it brings up, then retry."
      );
    }

    const seconds = Math.round(timeoutMs / 1000);
    console.log(
      "\n[gemini-code] Your Gemini session is signed out.\n" +
        "A Chrome window has been brought to the front — sign in there and I'll carry on automatically.\n" +
        `(waiting up to ${seconds}s; nothing here touches your credentials)\n`
    );

    const started = Date.now();
    let lastNotice = 0;
    while (Date.now() - started < timeoutMs) {
      if (!(await signIn.isVisible().catch(() => false))) {
        console.log("[gemini-code] Signed in — continuing.\n");
        return;
      }
      // A quiet heartbeat, so a long wait doesn't look like a hang.
      const waited = Math.floor((Date.now() - started) / 1000);
      if (waited - lastNotice >= 30) {
        lastNotice = waited;
        console.log(`[gemini-code] still waiting for sign-in (${waited}s)...`);
      }
      await page.waitForTimeout(1_000);
    }

    throw new Error(
      "Timed out waiting for sign-in. Run `gemini-code login`, sign in, then try again."
    );
  }

  /**
   * Is another LIVE gemini-code driving this tab?
   *
   * Ownership is stamped into the page as a pid. Checking the pid is still
   * alive (cheap, and they're all local processes) means a tab left behind
   * by a crashed run is reclaimed rather than stranded forever.
   */
  private async isTabOwnedByAnother(page: Page): Promise<boolean> {
    const owner = await page
      .evaluate(() => (window as unknown as { __geminiCodeOwner?: { pid?: number } }).__geminiCodeOwner)
      .catch(() => undefined);
    const pid = owner?.pid;
    if (!pid || pid === process.pid) return false;
    try {
      process.kill(pid, 0); // signal 0 just tests for existence
      return true;
    } catch {
      return false; // owner is gone — the tab is free
    }
  }

  /** Stamps this process's ownership on a tab, surviving reloads. */
  private async claimTab(page: Page): Promise<void> {
    const script = `window.__geminiCodeOwner = { pid: ${process.pid}, ts: Date.now() };`;
    await page.addInitScript({ content: script }).catch(() => undefined);
    await page.evaluate(script).catch(() => undefined);
  }

  /** Reads the currently selected model from the picker's aria-label. */
  async getCurrentModel(): Promise<string> {
    const page = this.requirePage();
    const label = await page
      .locator(selectors.modePicker)
      .first()
      .getAttribute("aria-label")
      .catch(() => null);
    // Label reads e.g. "Open mode picker, currently Flash Extended".
    this.currentModelLabel = label?.replace(/^.*currently\s*/i, "").trim() || "unknown";
    return this.currentModelLabel;
  }

  /**
   * Switches the Gemini model via the picker. `alias` is a friendly name
   * ("fast", "pro", …) resolved by models.ts, which matches menu entries on
   * keywords rather than exact labels so Google's version bumps
   * ("3.5 Flash" → "3.6 Flash") don't break it.
   */
  async setModel(alias: string): Promise<string> {
    const page = this.requirePage();
    const choice = resolveModel(alias);
    if (!choice) {
      throw new Error(
        `Unknown model "${alias}". Options:\n${modelHelp()}`
      );
    }

    await page.locator(`${selectors.modePicker} >> visible=true`).first().click({ timeout: 10_000 });
    const items = page.locator(selectors.modeMenuItem);
    await items.first().waitFor({ timeout: 10_000 }).catch(() => {
      throw new Error("Model picker didn't open — recalibrate selectors.modePicker/modeMenuItem.");
    });

    const count = await items.count();
    for (let i = 0; i < count; i++) {
      const item = items.nth(i);
      if (!(await item.isVisible().catch(() => false))) continue;
      const text = (await item.innerText().catch(() => "")).trim();
      if (choice.matches(text)) {
        await item.click();
        await page.waitForTimeout(800);
        return choice.name;
      }
    }

    // Nothing matched — close the menu rather than leaving it open over the UI.
    await page.keyboard.press("Escape").catch(() => {});
    throw new Error(
      `Couldn't find "${choice.name}" in the model picker. Available entries were checked against ` +
        `keyword rules in models.ts; Google may have renamed them.`
    );
  }

  /**
   * Turns "Extended thinking" on or off. It's a toggle stacked on the base
   * model (the picker reads e.g. "Flash Extended"), so we detect the current
   * state from that label and only click when a change is actually needed —
   * clicking blindly would flip it the wrong way half the time.
   */
  async setExtendedThinking(enabled: boolean): Promise<boolean> {
    const page = this.requirePage();
    const isOn = () => EXTENDED_THINKING.labelMarker.test(this.currentModelLabel);
    await this.getCurrentModel(); // refresh the cached label
    if (isOn() === enabled) return enabled;

    await page.locator(`${selectors.modePicker} >> visible=true`).first().click({ timeout: 10_000 });
    const items = page.locator(selectors.modeMenuItem);
    await items.first().waitFor({ timeout: 10_000 });

    const count = await items.count();
    for (let i = 0; i < count; i++) {
      const item = items.nth(i);
      if (!(await item.isVisible().catch(() => false))) continue;
      if (EXTENDED_THINKING.matches((await item.innerText().catch(() => "")).trim())) {
        await item.click();
        await page.waitForTimeout(800);
        await this.getCurrentModel();
        return isOn();
      }
    }
    await page.keyboard.press("Escape").catch(() => {});
    throw new Error("Couldn't find the Extended thinking toggle in the model picker.");
  }

  async newConversation(): Promise<void> {
    const page = this.requirePage();
    const newChat = page.locator(`${selectors.newChatButton} >> visible=true`).first();
    if (await newChat.isVisible().catch(() => false)) {
      await newChat.click();
    } else {
      // Fallback: a fresh page load starts a fresh thread too.
      await page.goto(GEMINI_URL, { waitUntil: "domcontentloaded" });
      await this.waitForAppShell();
    }
    await this.waitForResponsesCleared();
  }

  /**
   * Waits for the previous thread's responses to actually leave the DOM
   * after starting a new chat. Without this there's a race: the old
   * responses linger for a moment, get captured as the "before" count on
   * the next send, and since the fresh thread's first response makes the
   * count 1 (not >2), waitForNewResponse() could never be satisfied and
   * the send appeared to hang.
   */
  private async waitForResponsesCleared(timeoutMs = 15_000): Promise<void> {
    const page = this.requirePage();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await this.countResponses().catch(() => 0)) === 0) return;
      await page.waitForTimeout(200);
    }
    // Not fatal — sendPrompt re-reads the baseline anyway, so a thread that
    // never clears just means we continue in the existing conversation.
  }

  /**
   * Types a prompt and sends it, optionally with a file attached.
   *
   * Sends with Enter rather than clicking the send button: that button's
   * aria-label and visibility change between turns (absent while the
   * composer is empty, swapped for the stop button mid-generation), which
   * made a button-click strategy time out on the second send of a session.
   * The button stays as a fallback for UIs//states where Enter inserts a
   * newline instead of submitting.
   */
  async sendPrompt(text: string, opts: { attachFile?: string | string[] } = {}): Promise<void> {
    const page = this.requirePage();

    // Snapshot how many responses exist BEFORE sending. waitForResponseComplete()
    // uses this to wait for a genuinely NEW response rather than re-reading the
    // previous turn — without it the loop re-parsed the last turn's tool call and
    // executed it a second time ("it's sending multiple times").
    this.responseCountBeforeSend = await this.countResponses();

    // A previous reply that is still streaming (or a worker's reply the
    // loop read early) turns the send button into "Stop", and nothing we
    // type can be submitted until it finishes.
    await page
      .locator(`${selectors.stopButton} >> visible=true`)
      .first()
      .waitFor({ state: "hidden", timeout: 120_000 })
      .catch(() => undefined);

    const box = page.locator(selectors.composerInput).first();
    await box.click();

    // Clear any leftover draft. Select-all + Backspace is more reliable than
    // fill("") on a rich-text contenteditable, which can silently no-op.
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    await page.keyboard.press("Backspace");

    const attachments = opts.attachFile
      ? Array.isArray(opts.attachFile)
        ? opts.attachFile
        : [opts.attachFile]
      : [];
    for (const file of attachments) {
      await this.attachFile(file);
    }

    // insertText types the literal string (newlines included) without firing
    // Enter keydowns, so multi-line prompts don't submit themselves early.
    //
    // Guard: a message that STARTS with a ``` fence flips the composer into
    // code-block mode, where Enter inserts a newline instead of submitting
    // and the send button can't rescue it — the message just never sends.
    // Verified against the live UI. A leading plain-text line avoids it.
    await page.keyboard.insertText(text.startsWith("```") ? `.\n${text}` : text);

    // Make sure the text actually landed before trying to submit — if the
    // composer is empty, Enter does nothing and we'd hang waiting forever.
    if (!(await this.composerHasText(10_000))) {
      throw new Error(
        "Typed the prompt but the composer stayed empty — selectors.composerInput is " +
          "probably matching the wrong element. Recalibrate it (see README step 2)."
      );
    }

    // Submit. Enter works for most messages; long/multi-line ones often need
    // the button instead. The composer clearing is the reliable "it sent"
    // signal (immediate), unlike waiting for a response (slow).
    //
    // Deliberately re-checks rather than trusting a single sample: the
    // composer can read as momentarily empty right after Enter even when the
    // message did NOT send, which previously made this skip the fallback
    // click and then hang forever waiting for a reply that never came.
    await page.keyboard.press("Enter");
    if (await this.composerCleared(2_500)) return;

    await page
      .locator(`${selectors.sendButton} >> visible=true`)
      .first()
      .click({ timeout: 10_000 })
      .catch(() => undefined);
    if (await this.composerCleared(10_000)) return;

    throw new Error(
      "Typed the prompt but couldn't submit it — neither Enter nor the send button cleared " +
        `the composer. ${await this.diagnoseSendFailure()}`
    );
  }

  /**
   * Says WHY a send didn't go through, from what's actually on the page, and
   * saves a screenshot — a bare "couldn't submit" gave nothing to act on
   * when it happened in a live run with the tab already closed.
   */
  private async diagnoseSendFailure(): Promise<string> {
    const page = this.requirePage();
    const facts: string[] = [];
    try {
      if (await page.locator(`${selectors.stopButton} >> visible=true`).count()) {
        facts.push("Gemini is still generating the previous reply (the Stop button is showing).");
      }
      const send = page.locator(`${selectors.sendButton} >> visible=true`).first();
      if (!(await send.count())) facts.push("No send button is visible.");
      else if (await send.isDisabled().catch(() => false)) facts.push("The send button is disabled.");

      const notices = await page.evaluate(`(() => {
        const sel = '[role="alert"], [role="status"], [aria-live="assertive"], snack-bar-container, ' +
          '.mat-mdc-snack-bar-container, [class*="snackbar" i], [class*="banner" i], [class*="warning" i]';
        const seen = new Set();
        for (const el of document.querySelectorAll(sel)) {
          const t = (el.innerText || "").trim().replace(/\\s+/g, " ");
          const r = el.getBoundingClientRect();
          if (t && t.length < 300 && r.width > 0 && r.height > 0) seen.add(t);
        }
        return [...seen].slice(0, 5);
      })()`) as string[];
      if (notices.length) facts.push(`On-page notice: ${notices.map((n) => `"${n}"`).join("; ")}.`);
    } catch {
      // Diagnosis is best-effort; never mask the original failure.
    }

    try {
      const dir = path.join(homedir(), ".gemini-code", "logs");
      mkdirSync(dir, { recursive: true });
      const shot = path.join(dir, `send-failure-${Date.now()}.png`);
      await page.screenshot({ path: shot });
      facts.push(`Screenshot: ${shot}`);
    } catch {
      // ditto
    }

    if (!facts.some((f) => !f.startsWith("Screenshot"))) {
      facts.unshift(
        "Nothing on the page explains it. If the message starts with a ``` fence the composer enters " +
          "code-block mode and refuses to send; otherwise recalibrate selectors.sendButton (README step 2)."
      );
    }
    return facts.join(" ");
  }

  /** True once the composer holds non-empty text (i.e. our typing landed). */
  private async composerHasText(timeoutMs: number): Promise<boolean> {
    return this.pollComposer(timeoutMs, (text) => text.length > 0);
  }

  /** True once the composer is empty again — the immediate signal that a send went through. */
  private async composerCleared(timeoutMs: number): Promise<boolean> {
    return this.pollComposer(timeoutMs, (text) => text.length === 0);
  }

  private async pollComposer(timeoutMs: number, predicate: (text: string) => boolean): Promise<boolean> {
    const page = this.requirePage();
    // `>> visible=true` matters: the page carries a second, hidden
    // contenteditable whose empty text would otherwise be read as "cleared".
    const box = page.locator(`${selectors.composerInput} >> visible=true`).first();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const text = await box.innerText().catch(() => "");
      if (predicate(text.trim())) return true;
      await page.waitForTimeout(200);
    }
    return false;
  }

  /**
   * Attaches a local file to the composer.
   *
   * Gemini creates its <input type="file"> elements only when the
   * "Upload & tools" menu is opened — before that there are zero in the DOM,
   * so calling setInputFiles() straight away just times out. So: open the
   * menu, then either intercept the file chooser (preferred, works no matter
   * how the input is created) or fall back to the input that now exists.
   */
  private async attachFile(filePath: string): Promise<void> {
    const page = this.requirePage();
    const chipsBefore = await page.locator(selectors.attachmentChip).count().catch(() => 0);

    await page.locator(`${selectors.uploadButton} >> visible=true`).first().click({ timeout: 10_000 });

    const uploadItem = page
      .locator(selectors.modeMenuItem)
      .filter({ hasText: selectors.uploadFilesText })
      .first();

    try {
      const [chooser] = await Promise.all([
        page.waitForEvent("filechooser", { timeout: 10_000 }),
        uploadItem.click({ timeout: 10_000 }),
      ]);
      await chooser.setFiles(filePath);
    } catch {
      // The menu is open now, so the inputs exist even if the chooser
      // event didn't fire (e.g. the item was already wired to an input).
      await page.locator(selectors.fileInput).first().setInputFiles(filePath, { timeout: 10_000 });
    }

    await this.waitForAttachmentReady(path.basename(filePath), chipsBefore);
  }

  /**
   * Waits for the uploaded file to show up as an attachment chip. Sending
   * while the upload is still in flight silently drops the attachment, and
   * upload time scales with file size, so a fixed sleep isn't good enough.
   */
  private async waitForAttachmentReady(
    fileName: string,
    chipsBefore: number,
    timeoutMs = TIMEOUTS.attachment
  ): Promise<void> {
    const page = this.requirePage();
    const deadline = Date.now() + timeoutMs;
    // Primary signal: one more attachment chip than before. Counting works
    // for images (which render as a bare thumbnail with no filename) as well
    // as documents. Filename text is kept only as a secondary signal, and
    // matched on a short slice because long names get ellipsized.
    const stem = fileName.replace(/\.[^.]+$/, "").slice(0, 12);

    // The filename is evidence of THIS upload only if it wasn't already on
    // the page. getByText searches the whole document, including the thread
    // above the composer — and every tool result that attached a file left
    // its name in that thread ("...ATTACHED to this message as
    // run_bash-output.txt"). run_bash reuses one fixed filename, so from the
    // SECOND oversized command output onwards the old message matched and a
    // failed upload was reported ready. The prompt then went out claiming an
    // attachment that wasn't there, Gemini answered that it couldn't see any
    // output, and the loop burned its turns re-asking until it hit the cap.
    //
    // So compare counts rather than "is one visible": a genuinely new
    // occurrence still registers, while pre-existing history does not.
    const stemsBefore = await this.countText(stem);
    while (Date.now() < deadline) {
      const chips = await page.locator(selectors.attachmentChip).count().catch(() => 0);
      const seen = chips > chipsBefore || (await this.countText(stem)) > stemsBefore;
      if (seen) {
        // Chip is present; give the upload a beat to finish processing.
        await page.waitForTimeout(1_500);
        return;
      }
      await page.waitForTimeout(300);
    }
    throw new Error(
      `Uploaded "${fileName}" but no attachment chip appeared within ${timeoutMs / 1000}s — ` +
        `the upload may have failed or selectors may need recalibrating.`
    );
  }

  /** How many times a piece of text appears on the page (0 if the lookup fails). */
  private async countText(text: string): Promise<number> {
    const page = this.requirePage();
    return page.getByText(text, { exact: false }).count().catch(() => 0);
  }

  private async countResponses(): Promise<number> {
    const page = this.requirePage();
    return page.locator(selectors.responseContainer).count();
  }

  /** Polls until a response newer than the one present at send time appears. */
  private async waitForNewResponse(timeoutMs: number): Promise<void> {
    const page = this.requirePage();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await this.countResponses().catch(() => 0)) > this.responseCountBeforeSend) return;
      await page.waitForTimeout(250);
    }
    throw new Error(
      "Sent the prompt but no new response ever appeared. Either the send didn't go through, " +
        "or selectors.responseContainer no longer matches (see README step 2)."
    );
  }

  /**
   * Waits for generation to finish. Primary signal: the "stop generating"
   * button disappears. Fallback: the response text stops changing for a
   * debounce window, in case the stop-button selector drifts out of date.
   */
  async waitForResponseComplete(opts: { timeoutMs?: number; debounceMs?: number } = {}): Promise<void> {
    const page = this.requirePage();
    const timeoutMs = opts.timeoutMs ?? TIMEOUTS.response;
    const debounceMs = opts.debounceMs ?? 1_500;
    const stop = page.locator(`${selectors.stopButton} >> visible=true`).first();

    // First wait for a genuinely NEW response to appear. Without this the
    // stability poll can immediately "stabilize" on the PREVIOUS turn's
    // text (it's already static), so we'd parse the old reply, re-run its
    // tool call, and send again — the duplicate-send bug.
    await this.waitForNewResponse(timeoutMs);

    const stopButtonGone = stop
      .waitFor({ state: "hidden", timeout: timeoutMs })
      .catch(() => undefined);

    const textStabilized = (async () => {
      const deadline = Date.now() + timeoutMs;
      let lastText = "";
      let stableSince = Date.now();
      while (Date.now() < deadline) {
        const text = await this.peekLastResponseText().catch(() => "");
        if (text !== lastText) {
          lastText = text;
          stableSince = Date.now();
        } else if (text && Date.now() - stableSince >= debounceMs) {
          return;
        }
        await page.waitForTimeout(250);
      }
    })();

    await Promise.race([stopButtonGone, textStabilized]);
  }

  /**
   * Cheap text-only peek at the latest response, used only for the
   * generation-in-progress stability poll — code blocks aren't needed
   * there, so skip that extra work on every 250ms tick.
   */
  private async peekLastResponseText(): Promise<string> {
    const page = this.requirePage();
    const responses = page.locator(selectors.responseContainer);
    const count = await responses.count();
    if (count === 0) return "";
    return (await responses.nth(count - 1).innerText()).trim();
  }

  /**
   * Reads the most recent model response: the full rendered text, plus the
   * text content of any rendered code blocks inside it, extracted
   * separately. See GeminiResponse's doc comment for why the split matters.
   */
  async getLastResponse(): Promise<GeminiResponse> {
    const page = this.requirePage();
    const responses = page.locator(selectors.responseContainer);
    const count = await responses.count();
    if (count === 0) return { text: "", codeBlocks: [] };

    const last = responses.nth(count - 1);
    const text = (await last.innerText()).trim();
    const codeBlocks = (await last.locator(selectors.codeBlock).allInnerTexts()).map((s) => s.trim());
    return { text, codeBlocks };
  }

  /**
   * Opens a NEW Gemini tab in the same browser window and returns a driver
   * bound to it — one worker, one tab, one independent conversation thread.
   *
   * Threads are the unit of isolation here: Gemini's own UI keeps history
   * per thread, so parallel workers can't contaminate each other's context
   * the way they would if they shared one tab.
   */
  /**
   * Brands a tab so the user can tell at a glance that the agent owns it.
   *
   * Chrome tab *groups* would be the ideal fit here, but they're only
   * reachable through the `chrome.tabGroups` extension API — the DevTools
   * Protocol exposes nothing for them (verified against this Chrome's own
   * /json/protocol), so Playwright can't create one. This is the next best
   * thing: a pinned title, a distinct favicon, and optionally a close guard.
   *
   * The title/favicon are re-applied on an interval because Gemini is an SPA
   * that rewrites document.title as the conversation changes — setting it
   * once would last only until the next render.
   */
  async markTab(label: string, opts: { guardClose?: boolean } = {}): Promise<void> {
    const page = this.requirePage();

    // Built as a STRING, not a function reference, on purpose. tsx/esbuild
    // compiles local functions with a `keepNames` helper, so serializing one
    // into the page fails with "ReferenceError: __name is not defined" —
    // the helper exists in Node, not in the browser. A plain string has no
    // such dependency.
    const script = `(() => {
      const label = ${JSON.stringify(label)};
      const guardClose = ${JSON.stringify(opts.guardClose ?? false)};
      const favicon = "data:image/svg+xml," + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">' +
        '<rect width="16" height="16" rx="3" fill="#7c3aed"/>' +
        '<text x="8" y="12" font-size="11" text-anchor="middle" fill="#fff">g</text></svg>'
      );

      function tick() {
        try {
          // Re-applied on an interval: Gemini is an SPA that rewrites
          // document.title as the conversation changes, so setting it once
          // would last only until the next render.
          if (document.title !== label) document.title = label;
          if (!document.head) return;
          let link = document.querySelector("link[data-gemini-code]");
          if (!link) {
            document.querySelectorAll("link[rel*='icon']").forEach(function (el) { el.remove(); });
            link = document.createElement("link");
            link.rel = "icon";
            link.setAttribute("data-gemini-code", "1");
            document.head.appendChild(link);
          }
          if (link.href !== favicon) link.href = favicon;
        } catch (e) { /* document not ready yet */ }
      }

      if (!window.__geminiCodeBranded) {
        window.__geminiCodeBranded = true;
        tick();
        setInterval(tick, 1000);
        if (guardClose) {
          // Makes Chrome ask "Leave site?" if the user closes this tab by
          // hand. Our own page.close() does NOT run beforeunload, so agent
          // cleanup is unaffected.
          window.addEventListener("beforeunload", function (e) {
            e.preventDefault();
            e.returnValue = "";
          });
        }
      }
    })()`;

    // addInitScript covers future navigations; evaluate covers the page as
    // it stands right now. Branding is cosmetic, so a failure must never
    // break a task — but it does get reported, because silently swallowing
    // it once hid a real bug here for a whole debugging pass.
    try {
      await page.addInitScript({ content: script });
      await page.evaluate(script);
    } catch (err) {
      console.error(`[gemini-code] couldn't brand tab "${label}": ${(err as Error).message.split("\n")[0]}`);
    }
  }

  async spawnTab(label?: string): Promise<GeminiDriver> {
    const context = this.context;
    if (!context) throw new Error("Cannot spawn a tab before attach()/launch().");

    const page = await context.newPage();
    await page.goto(GEMINI_URL, { waitUntil: "domcontentloaded" });

    const child = new GeminiDriver();
    child.context = context;
    child.page = page;
    child.ownsBrowser = false;
    // We created this page, so this child closes the page — but never the
    // shared browser or the CDP connection the parent owns.
    child.ownsPage = true;
    await child.waitForAppShell();
    await child.claimTab(page);
    // Brand worker tabs with a close guard: these are the ones a user is
    // most likely to shut by accident mid-task, since they appear
    // unannounced while the agent is working.
    await child.markTab(`🤖 gemini-code · ${label ?? "worker"}`, { guardClose: true });
    return child;
  }

  /**
   * Opens a URL in a throwaway tab of the SAME browser and screenshots it.
   *
   * Same browser on purpose: it means a local dev server behind a login, or
   * anything else you're already authenticated to, renders exactly as you
   * see it. That also means the page is loaded WITH your session cookies,
   * which is why the tool wrapping this asks for confirmation and shows the
   * URL — see tools/screenshot.ts.
   */
  async screenshotPage(
    url: string,
    outPath: string,
    opts: { fullPage?: boolean; selector?: string; viewport?: { width: number; height: number } } = {}
  ): Promise<{ title: string; url: string }> {
    const context = this.context;
    if (!context) throw new Error("Cannot screenshot before attach()/launch().");

    const page = await context.newPage();
    try {
      if (opts.viewport) await page.setViewportSize(opts.viewport);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
      // Give client-rendered pages a moment to actually paint something.
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
      await page.waitForTimeout(800);

      if (opts.selector) {
        const target = page.locator(opts.selector).first();
        await target.waitFor({ timeout: 15_000 });
        await target.screenshot({ path: outPath });
      } else {
        await page.screenshot({ path: outPath, fullPage: opts.fullPage ?? false });
      }
      return { title: await page.title().catch(() => ""), url: page.url() };
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  /**
   * Loads a page in a throwaway tab and extracts what a reader would see.
   *
   * The difference from a plain HTTP fetch is JavaScript: docs sites, SPAs
   * and dashboards serve an empty shell to curl, so fetch_url returns
   * markup with no content in it. Rendering first is the only way to read
   * them.
   */
  async readPageText(
    url: string,
    opts: { selector?: string; clickSelector?: string; includeLinks?: boolean; waitMs?: number } = {}
  ): Promise<{ title: string; url: string; text: string; links: string[] }> {
    const context = this.context;
    if (!context) throw new Error("Cannot browse before attach()/launch().");

    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);

      if (opts.clickSelector) {
        await page
          .locator(opts.clickSelector)
          .first()
          .click({ timeout: 10_000 })
          .catch(() => undefined);
        await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
      }
      await page.waitForTimeout(opts.waitMs ?? 600);

      const scope = opts.selector ? page.locator(opts.selector).first() : undefined;
      if (scope) await scope.waitFor({ timeout: 15_000 });

      // Prefer the semantic content region: it strips nav, cookie bars and
      // footers that otherwise dominate the extraction.
      const text = scope
        ? await scope.innerText()
        : await page.evaluate(() => {
            const main = document.querySelector("main, article, [role='main']");
            return ((main as HTMLElement) ?? document.body).innerText;
          });

      const links = opts.includeLinks
        ? await page.evaluate(() =>
            Array.from(document.querySelectorAll("a[href]"))
              .map((a) => `${(a as HTMLElement).innerText.trim().slice(0, 80)} -> ${(a as HTMLAnchorElement).href}`)
              .filter((l) => !l.startsWith(" ->"))
              .slice(0, 120)
          )
        : [];

      return { title: await page.title().catch(() => ""), url: page.url(), text: text.trim(), links };
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  /**
   * Renders a page to PDF in a throwaway tab.
   *
   * Better than a screenshot for anything long: a full-page PNG of a docs
   * page is an enormous unreadable strip, whereas a PDF keeps the text
   * selectable, paginated and small — and Gemini reads PDFs natively.
   *
   * Playwright documents page.pdf() as headless-only, but it works fine
   * against this attached headed Chrome (verified, as does the underlying
   * CDP Page.printToPDF).
   */
  async printPageToPdf(
    url: string,
    outPath: string,
    opts: { screenMedia?: boolean } = {}
  ): Promise<{ title: string; url: string }> {
    const context = this.context;
    if (!context) throw new Error("Cannot print before attach()/launch().");

    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
      // Screen media by default: print stylesheets often strip the very
      // layout you're trying to show the model.
      if (opts.screenMedia !== false) await page.emulateMedia({ media: "screen" });
      await page.waitForTimeout(600);
      await page.pdf({ path: outPath, printBackground: true, format: "A4" });
      return { title: await page.title().catch(() => ""), url: page.url() };
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  /** The shared browser context, for features that manage their own tabs. */
  browserContext(): BrowserContext {
    if (!this.context) throw new Error("Browser not started — call attach()/launch() first.");
    return this.context;
  }

  async close(): Promise<void> {
    if (this.ownsPage) {
      // A spawned worker tab: close just our own page.
      await this.page?.close().catch(() => {});
      return;
    }
    if (this.ownsBrowser) {
      // We launched it, so we close it.
      await this.context?.close();
      return;
    }
    // After attach(), the browser is the user's own long-lived window —
    // closing it would kill it out from under them. Drop only the CDP
    // connection: for a connectOverCDP browser, close() disconnects the
    // client and leaves the real browser running. This is also required
    // for the process to exit at all — an open connection keeps Node's
    // event loop alive.
    await this.connection?.close().catch(() => {});
  }

  private requirePage(): Page {
    if (!this.page) throw new Error("GeminiDriver.launch() must be called first.");
    return this.page;
  }
}
