import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import path from "node:path";
import type { IGeminiDriver } from "../driver/IGeminiDriver.js";
import { tools } from "../tools/index.js";
import type { ToolDefinition } from "../types.js";
import {
  buildSystemPrimer,
  buildContextDocument,
  formatToolResult,
  type PrimerContext,
  type AgentRole,
} from "./promptTemplate.js";
import { parseGeminiReply } from "./toolCallParser.js";
import { toolCallLine, toolResultLine, noteLine } from "../ui/format.js";
import type { PlanJournal } from "../context/plan.js";

const MAX_TOOL_TURNS_PER_TASK = 25;

/**
 * Tool output longer than this gets uploaded as a file attachment rather
 * than pasted into the composer. The web UI has a practical text-length
 * limit on a single message that a real API wouldn't — pasting a big file
 * either gets truncated or fails outright, so we attach it instead.
 */
const MAX_INLINE_RESULT_CHARS = 4_000;

/**
 * Context (tree + memory + project docs) longer than this is uploaded as a
 * file instead of pasted. Lower than the tool-result limit because the
 * primer's rules share the same first message and must stay inline.
 */
const MAX_INLINE_CONTEXT_CHARS = 2_500;

const TMP_DIR = ".gemini-code-tmp";

/** Transient driver failures (send/response) are retried this many times. */
const TURN_RETRIES = Math.max(0, Number(process.env.GEMINI_CODE_TURN_RETRIES ?? 2));

export interface RunTaskOptions {
  onEvent?: (msg: string) => void;
  /**
   * Returns anything the user typed WHILE the task was running. Drained
   * before each turn and injected as steering, so you can redirect a task
   * mid-flight instead of waiting for it to finish and starting over.
   */
  getSteering?: () => string[];
}

export class AgentSession {
  private primed = false;
  /** Static tools plus any session-scoped ones (e.g. delegate_tasks). */
  private readonly tools: ToolDefinition[];
  private readonly toolsByName: Record<string, ToolDefinition>;

  constructor(
    private readonly driver: IGeminiDriver,
    private readonly context: PrimerContext = {},
    extraTools: ToolDefinition[] = [],
    /**
     * Written to after every step so an interrupted run can be resumed.
     * Optional: worker sessions and tests run without one.
     */
    private readonly journal?: PlanJournal,
    /** Shapes the primer: orchestrator delegates, worker reports back short. */
    private readonly role: AgentRole = "solo"
  ) {
    this.tools = [...tools, ...extraTools];
    this.toolsByName = Object.fromEntries(this.tools.map((t) => [t.name, t]));
  }

  /** Runs one user task to completion, including any tool-call back-and-forth. Returns Gemini's final plain-text answer. */
  async runTask(
    userTask: string,
    onEventOrOptions?: ((msg: string) => void) | RunTaskOptions
  ): Promise<string> {
    const options: RunTaskOptions =
      typeof onEventOrOptions === "function" ? { onEvent: onEventOrOptions } : onEventOrOptions ?? {};
    const log = options.onEvent ?? (() => {});

    await this.journal?.begin(userTask);
    let message = userTask;
    let attachFile: string | undefined;

    if (!this.primed) {
      this.primed = true;
      const primer = buildSystemPrimer(this.tools, this.role);
      const contextDoc = buildContextDocument(this.context);

      if (!contextDoc) {
        message = `${primer}\n\n---\n\nTASK:\n${userTask}`;
      } else if (contextDoc.length <= MAX_INLINE_CONTEXT_CHARS) {
        message = `${primer}\n\n---\n\n${contextDoc}\n\n---\n\nTASK:\n${userTask}`;
      } else {
        // Too big for the composer — send the rules inline (they must not
        // depend on Gemini opening a file) and attach the knowledge.
        attachFile = await this.writeContextFile(contextDoc);
        log(noteLine(`context is ${contextDoc.length} chars — attaching ${path.basename(attachFile)}`));
        message =
          `${primer}\n\n---\n\nProject context (structure, memory, and the project's own docs) ` +
          `is ATTACHED to this message as "${path.basename(attachFile)}". Read it first.\n\n` +
          `---\n\nTASK:\n${userTask}`;
      }
    }

    for (let turn = 0; turn < MAX_TOOL_TURNS_PER_TASK; turn++) {
      // Fold in anything the user typed since the last turn, so they can
      // steer a running task rather than wait for it to finish.
      const steering = options.getSteering?.() ?? [];
      if (steering.length) {
        log(noteLine(`steering: ${steering.join(" | ")}`));
        await this.journal?.log(`user steered: ${steering.join(" | ")}`);
        message =
          `USER UPDATE — take this into account and adjust your plan:\n${steering.join("\n")}\n\n` +
          message;
      }

      const reply = await this.exchange(message, attachFile, log);
      if (attachFile) {
        await rm(attachFile, { force: true }).catch(() => {});
        attachFile = undefined;
      }

      const parsed = parseGeminiReply(reply);

      if (parsed.kind === "final") {
        await this.journal?.complete(parsed.text);
        return parsed.text;
      }

      if (parsed.kind === "malformed") {
        log(noteLine("malformed tool call — asking Gemini to retry"));
        message = formatToolResult(
          `Error: that wasn't valid tool-call JSON: ${parsed.error}\nRaw content: ${parsed.raw}\nPlease reissue a single valid tool call (a code block containing only {"name": ..., "args": ...}), or answer in plain text instead.`
        );
        continue;
      }

      // kind === "tool_call"
      const { name, args } = parsed.call;
      log(toolCallLine(name, args));
      const tool = this.toolsByName[name];
      const result = tool
        ? await tool.run(args)
        : { ok: false, output: `Error: unknown tool "${name}". Available: ${Object.keys(this.toolsByName).join(", ")}` };

      log(toolResultLine(result.ok, result.output));
      await this.journal?.log(
        `${name}(${truncateArgs(args)}) -> ${result.ok ? "ok" : "ERROR"}: ${result.output.replace(/\s+/g, " ").slice(0, 160)}`
      );

      if (result.output.length > MAX_INLINE_RESULT_CHARS) {
        attachFile = await this.writeAttachment(name, args, result.output);
        log(noteLine(`too long to paste — attaching ${path.basename(attachFile)}`));
        message = formatToolResult(
          `Output was too long to paste (${result.output.length} characters), so it is ATTACHED to this message as "${path.basename(attachFile)}". Read the attached file for the full result.`
        );
      } else {
        message = formatToolResult(result.output);
      }
    }

    await this.journal?.markInterrupted("hit the max tool-call turns");
    return "(Stopped: hit the max tool-call turns for this task without a final answer.)";
  }

  /**
   * Sends one message and returns Gemini's reply, retrying the WHOLE
   * exchange on failure.
   *
   * Retrying only the wait (the obvious-looking version) is useless: the
   * common failure is Gemini accepting a message and then never generating
   * a reply, so waiting again just burns another timeout. Re-sending is what
   * actually recovers. A duplicated tool result in the thread is a much
   * cheaper problem than a hung task.
   */
  private async exchange(
    message: string,
    attachFile: string | undefined,
    log: (msg: string) => void
  ) {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= TURN_RETRIES; attempt++) {
      try {
        if (attachFile && attempt === 0) {
          try {
            await this.driver.sendPrompt(message, { attachFile });
          } catch (err) {
            // Uploading is best-effort: fall back to pasting a truncated
            // version rather than killing the task. Losing some context
            // beats losing the run.
            log(noteLine(`attachment failed (${(err as Error).message.split("\n")[0]}) — pasting truncated text instead`));
            const inlineFallback = await readFile(attachFile, "utf8").catch(() => "");
            await this.driver.sendPrompt(
              `${message}\n\n(The attachment didn't upload. Here is as much of it as fits:)\n\n` +
                inlineFallback.slice(0, MAX_INLINE_RESULT_CHARS) +
                (inlineFallback.length > MAX_INLINE_RESULT_CHARS ? "\n\n[truncated]" : "")
            );
          }
        } else {
          // Retries re-send as plain text: if the upload already landed it's
          // still in the thread, and re-uploading would just duplicate it.
          await this.driver.sendPrompt(message);
        }

        await this.driver.waitForResponseComplete();
        return await this.driver.getLastResponse();
      } catch (err) {
        lastError = err as Error;
        if (attempt < TURN_RETRIES) {
          log(noteLine(`no reply (${lastError.message.split("\n")[0]}) — resending, attempt ${attempt + 2}/${TURN_RETRIES + 1}`));
          await this.journal?.log(`retrying turn: ${lastError.message.split("\n")[0]}`);
          await new Promise((r) => setTimeout(r, 3_000 * (attempt + 1)));
        }
      }
    }

    throw lastError ?? new Error("No response from Gemini after retries.");
  }

  /** Writes the project-context document to a temp file for upload. */
  private async writeContextFile(contextDoc: string): Promise<string> {
    const dir = path.resolve(process.cwd(), TMP_DIR);
    await mkdir(dir, { recursive: true });
    // Short, stable name on purpose: the attachment chip ellipsizes long
    // filenames, which broke the "did the upload land?" check. .md so Gemini
    // renders/parses it as the markdown document it is.
    const filePath = path.join(dir, "context.md");
    await writeFile(filePath, contextDoc, "utf8");
    return filePath;
  }

  /** Writes an oversized tool result to a temp file for upload, named after what produced it. */
  private async writeAttachment(
    toolName: string,
    args: Record<string, unknown>,
    output: string
  ): Promise<string> {
    const dir = path.resolve(process.cwd(), TMP_DIR);
    await mkdir(dir, { recursive: true });

    // Preserve the original extension where we can, so Gemini renders/parses
    // the attachment sensibly (a .ts file as code, not as opaque text).
    // No timestamp prefix: the attachment chip ellipsizes long filenames,
    // and the upload check matches on the name. Files are deleted right
    // after sending, so reuse is safe.
    const sourcePath = typeof args.path === "string" ? args.path : undefined;
    const base = sourcePath ? path.basename(sourcePath) : `${toolName}-output.txt`;
    const filePath = path.join(dir, base);

    await writeFile(filePath, output, "utf8");
    return filePath;
  }
}


function truncateArgs(args: Record<string, unknown>): string {
  const primary = args.path ?? args.command ?? args.url;
  if (typeof primary === "string") return primary.slice(0, 80);
  return JSON.stringify(args).slice(0, 80);
}
