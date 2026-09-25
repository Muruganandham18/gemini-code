import type { GeminiDriver } from "../driver/GeminiDriver.js";
import { continuationOf, type ChatMessage } from "./protocol.js";

export interface PooledTab {
  driver: GeminiDriver;
  /** What this tab's thread holds, as the client will send it back. */
  history: ChatMessage[];
  /** Tool set the thread was primed with ("" for none). */
  toolsKey: string;
  /** Model alias last selected in this tab, to skip re-selecting it. */
  model?: string;
  busy: boolean;
}

export interface Lease {
  tab: PooledTab;
  /** Messages to send into the existing thread, or undefined for a fresh one. */
  continuation?: ChatMessage[];
}

/**
 * A fixed set of Gemini tabs shared by API requests.
 *
 * One request per tab at a time — a tab is one thread, and two prompts typed
 * into it at once would interleave. Requests beyond the pool size wait.
 *
 * The first tab is the one the server attached with; the rest are opened on
 * demand, so a server that only ever sees one request at a time costs one tab.
 */
export class TabPool {
  private readonly tabs: PooledTab[] = [];
  private readonly waiters: (() => void)[] = [];
  private spawning = 0;

  constructor(
    private readonly first: GeminiDriver,
    private readonly size: number,
    private readonly log: (msg: string) => void = () => {}
  ) {
    this.tabs.push({ driver: first, history: [], toolsKey: "", busy: false });
  }

  get stats() {
    return { tabs: this.tabs.length, busy: this.tabs.filter((t) => t.busy).length, waiting: this.waiters.length };
  }

  async acquire(messages: ChatMessage[], toolsKey: string): Promise<Lease> {
    for (;;) {
      // Best: an idle tab whose thread IS the start of this conversation, so
      // only the new turn needs sending — how chat clients keep a thread going.
      for (const tab of this.tabs) {
        if (tab.busy || tab.toolsKey !== toolsKey) continue;
        const continuation = continuationOf(tab.history, messages);
        if (continuation) {
          tab.busy = true;
          return { tab, continuation };
        }
      }

      // Next: any idle tab, preferring one with no thread worth keeping.
      const idle = this.tabs.filter((t) => !t.busy).sort((a, b) => a.history.length - b.history.length)[0];
      if (idle) {
        idle.busy = true;
        return { tab: idle };
      }

      // Next: grow the pool.
      if (this.tabs.length + this.spawning < this.size) {
        this.spawning++;
        try {
          const n = this.tabs.length + 1;
          this.log(`opening API tab ${n}/${this.size}`);
          const driver = await this.first.spawnTab(`api ${n}`);
          const tab: PooledTab = { driver, history: [], toolsKey: "", busy: true };
          this.tabs.push(tab);
          return { tab };
        } finally {
          this.spawning--;
        }
      }

      // Otherwise wait for a release.
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  release(tab: PooledTab): void {
    tab.busy = false;
    this.waiters.shift()?.();
  }

  /** Forgets a tab's thread, e.g. after a failed request left it in an unknown state. */
  reset(tab: PooledTab): void {
    tab.history = [];
    tab.toolsKey = "";
  }

  async close(): Promise<void> {
    // The first tab belongs to the attach; spawned ones are ours to close.
    for (const tab of this.tabs.slice(1)) await tab.driver.close().catch(() => undefined);
  }
}
