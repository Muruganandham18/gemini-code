import type { BrowserContext, Page } from "playwright";

export interface ElementRef {
  ref: number;
  role: string;
  label: string;
  detail?: string;
}

export interface PageSnapshot {
  url: string;
  title: string;
  elements: ElementRef[];
  text: string;
}

const MAX_TEXT = 6_000;
const MAX_ELEMENTS = 80;

/**
 * A persistent browser tab the agent can drive across several tool calls.
 *
 * Distinct from the one-shot read_page/screenshot_page helpers: interacting
 * with a site means click → look → type → click again, which needs the page
 * to stay put between calls, keeping its scroll position, cookies, and any
 * state the app is holding in memory.
 *
 * Elements are addressed by NUMBERED REF rather than CSS selector. Asking a
 * model to invent `div.css-1x7f2 > button:nth-child(3)` from a text dump is
 * guesswork that silently clicks the wrong thing; handing it
 * `[12] button "Sign in"` and stamping a matching attribute on the element
 * makes the reference exact.
 */
export class BrowserSession {
  private page: Page | undefined;
  /** Origins the user has approved for this session (see tools/browser.ts). */
  readonly approvedOrigins = new Set<string>();

  constructor(private readonly context: BrowserContext) {}

  isOpen(): boolean {
    return !!this.page && !this.page.isClosed();
  }

  currentUrl(): string {
    return this.page && !this.page.isClosed() ? this.page.url() : "";
  }

  async open(url: string): Promise<PageSnapshot> {
    if (!this.page || this.page.isClosed()) {
      this.page = await this.context.newPage();
      await this.brandTab();
    }
    await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await this.settle();
    return this.snapshot();
  }

  /** Marks the tab so the user can see the agent is driving it. */
  private async brandTab(): Promise<void> {
    if (!this.page) return;
    const script = `(() => {
      const label = "🌐 gemini-code · browsing";
      setInterval(() => { if (document.title !== label) document.title = label; }, 1000);
    })()`;
    await this.page.addInitScript({ content: script }).catch(() => undefined);
    await this.page.evaluate(script).catch(() => undefined);
  }

  private async settle(): Promise<void> {
    if (!this.page) return;
    await this.page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
    await this.page.waitForTimeout(400);
  }

  private require(): Page {
    if (!this.page || this.page.isClosed()) {
      throw new Error("No browsing session is open — use browser_open first.");
    }
    return this.page;
  }

  /**
   * Reads the page into a numbered list of interactive elements plus its
   * text. Stamps `data-gc-ref` on each element so a later click/type can
   * find exactly the thing that was listed.
   */
  async snapshot(): Promise<PageSnapshot> {
    const page = this.require();
    const elements = (await page.evaluate(
      ({ maxElements }) => {
        const SELECTOR =
          'a[href], button, input, textarea, select, summary, [role="button"], [role="link"], [role="textbox"], [role="checkbox"], [role="tab"], [contenteditable="true"], [onclick]';
        const out: { ref: number; role: string; label: string; detail?: string }[] = [];
        let ref = 0;

        document.querySelectorAll("[data-gc-ref]").forEach((el) => el.removeAttribute("data-gc-ref"));

        for (const el of Array.from(document.querySelectorAll(SELECTOR))) {
          if (out.length >= maxElements) break;
          const html = el as HTMLElement;
          const rect = html.getBoundingClientRect();
          const style = window.getComputedStyle(html);
          // Invisible or zero-size controls aren't actionable, and listing
          // them just wastes the model's attention.
          if (rect.width < 2 || rect.height < 2) continue;
          if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") continue;
          if ((html as HTMLInputElement).type === "hidden") continue;

          const tag = html.tagName.toLowerCase();
          const input = html as HTMLInputElement;
          const role =
            html.getAttribute("role") ??
            (tag === "input" ? `input[${input.type || "text"}]` : tag === "a" ? "link" : tag);

          const label =
            (html.getAttribute("aria-label") ||
              html.getAttribute("placeholder") ||
              (tag === "input" || tag === "textarea" ? input.value : "") ||
              html.innerText ||
              html.getAttribute("title") ||
              html.getAttribute("name") ||
              "")
              .trim()
              .replace(/\\s+/g, " ")
              .slice(0, 80);

          const detail =
            tag === "a" ? (html as HTMLAnchorElement).getAttribute("href")?.slice(0, 80) ?? undefined : undefined;

          ref++;
          html.setAttribute("data-gc-ref", String(ref));
          out.push({ ref, role, label, detail });
        }
        return out;
      },
      { maxElements: MAX_ELEMENTS }
    )) as ElementRef[];

    const text = (await page.evaluate(() => {
      const main = document.querySelector("main, article, [role='main']");
      return ((main as HTMLElement) ?? document.body).innerText;
    })) as string;

    return {
      url: page.url(),
      title: await page.title().catch(() => ""),
      elements,
      text: text.trim().slice(0, MAX_TEXT),
    };
  }

  async click(ref: number): Promise<PageSnapshot> {
    const page = this.require();
    const target = page.locator(`[data-gc-ref="${ref}"]`).first();
    if ((await target.count()) === 0) {
      throw new Error(
        `No element [${ref}] on the current page. Refs are invalidated whenever the page changes — take a fresh snapshot.`
      );
    }
    await target.scrollIntoViewIfNeeded().catch(() => undefined);
    await target.click({ timeout: 15_000 });
    await this.settle();
    return this.snapshot();
  }

  async type(ref: number, text: string, submit = false): Promise<PageSnapshot> {
    const page = this.require();
    const target = page.locator(`[data-gc-ref="${ref}"]`).first();
    if ((await target.count()) === 0) {
      throw new Error(
        `No element [${ref}] on the current page. Refs are invalidated whenever the page changes — take a fresh snapshot.`
      );
    }
    await target.scrollIntoViewIfNeeded().catch(() => undefined);
    await target.click({ timeout: 15_000 });
    await target.fill("").catch(() => undefined);
    await target.type(text, { delay: 12 });
    if (submit) {
      await page.keyboard.press("Enter");
      await this.settle();
    }
    await this.settle();
    return this.snapshot();
  }

  async press(key: string): Promise<PageSnapshot> {
    const page = this.require();
    await page.keyboard.press(key);
    await this.settle();
    return this.snapshot();
  }

  async scroll(direction: "up" | "down"): Promise<PageSnapshot> {
    const page = this.require();
    await page.mouse.wheel(0, direction === "down" ? 900 : -900);
    await page.waitForTimeout(500);
    return this.snapshot();
  }

  async back(): Promise<PageSnapshot> {
    const page = this.require();
    await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => undefined);
    await this.settle();
    return this.snapshot();
  }

  async screenshot(outPath: string): Promise<void> {
    const page = this.require();
    await page.screenshot({ path: outPath });
  }

  async close(): Promise<void> {
    if (this.page && !this.page.isClosed()) await this.page.close().catch(() => undefined);
    this.page = undefined;
    this.approvedOrigins.clear();
  }
}

/** Renders a snapshot for the model: refs first, then the readable text. */
export function formatSnapshot(snap: PageSnapshot): string {
  const elements = snap.elements.length
    ? snap.elements
        .map((e) => `[${e.ref}] ${e.role} "${e.label}"${e.detail ? ` -> ${e.detail}` : ""}`)
        .join("\n")
    : "(no interactive elements found)";

  return (
    `PAGE: ${snap.title}\nURL: ${snap.url}\n\n` +
    `INTERACTIVE ELEMENTS (use these ref numbers with browser_do):\n${elements}\n\n` +
    `PAGE TEXT:\n${snap.text || "(no text)"}`
  );
}
