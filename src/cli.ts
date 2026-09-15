#!/usr/bin/env node
import readline from "node:readline/promises";
import path from "node:path";
import { GeminiDriver } from "./driver/GeminiDriver.js";
import { AgentSession } from "./agent/loop.js";
import { buildProjectTree } from "./context/projectTree.js";
import { collectProjectDocs } from "./context/projectDocs.js";
import { ensureMemoryFile, readMemory, appendMemory, MEMORY_FILENAME } from "./context/memory.js";
import {
  DEFAULT_MODEL_ALIAS,
  DEFAULT_EXTENDED_THINKING,
  modelHelp,
} from "./driver/models.js";
import { tools } from "./tools/index.js";
import { killAllBackgroundProcesses } from "./tools/bash.js";
import { createDelegateTool, MAX_PARALLEL_WORKERS } from "./agent/workers.js";
import { PlanJournal, findResumablePlan, readPlan, clearPlan, PLAN_FILENAME } from "./context/plan.js";
import { createUpdatePlanTool } from "./tools/updatePlan.js";
import { createScreenshotTool } from "./tools/screenshot.js";
import { createBrowsePageTool } from "./tools/browsePage.js";
import { createBrowserTools } from "./tools/browser.js";
import { checkpoints } from "./context/checkpoint.js";
import { readClipboardImageDetailed, isImagePath, normalizeDroppedPath } from "./context/clipboard.js";
import { existsSync } from "node:fs";

/**
 * Master/worker by default: the main tab plans, delegates and validates,
 * while implementation happens in parallel worker tabs. Set
 * GEMINI_CODE_ORCHESTRATOR=0 to go back to one tab doing everything.
 */
const ORCHESTRATOR_MODE = process.env.GEMINI_CODE_ORCHESTRATOR !== "0";

/** Kept in step with package.json by `npm version`. */
export const VERSION = "0.2.1";
import { openChrome, ensureChromeRunning } from "./scripts/openChrome.js";
import { checkLogin } from "./scripts/login.js";
import { c } from "./ui/format.js";
import { setAsker } from "./ui/prompt.js";

function helpText(): string {
  return `${c.bold("Commands")}
  ${c.cyan("/model")}            show the current model
  ${c.cyan("/model <name>")}     switch model:
${modelHelp()
    .split("\n")
    .map((l) => "  " + l)
    .join("\n")}
  ${c.cyan("/thinking on|off")}  extended thinking (slower, deeper)
  ${c.cyan("/clear")}            start a fresh conversation thread
  ${c.cyan("/paste")} or ${c.cyan("Ctrl+V")}  attach an image from the clipboard
  ${c.cyan("/image <path>")}     attach an image file (or just drag one in)
  ${c.cyan("/undo")}             revert the file changes from the last task
  ${c.cyan("/plan")}             show the current plan / progress journal
  ${c.cyan("/plan clear")}       delete ${PLAN_FILENAME}
  ${c.cyan("/memory")}           show ${MEMORY_FILENAME}
  ${c.cyan("/remember <note>")}  append a note to ${MEMORY_FILENAME}
  ${c.cyan("/tools")}            list tools available to Gemini
  ${c.cyan("/help")}             this message
  ${c.cyan("/exit")}             quit (or Ctrl+C)

Anything else is sent to Gemini as a task.`;
}

async function main() {
  const driver = new GeminiDriver();
  // Start Chrome ourselves if it isn't already up, so the usual case is a
  // single command. Signing in stays manual, but the profile keeps the
  // session, so that's a one-time thing rather than a per-run step.
  const launched = await ensureChromeRunning((m) => console.log(c.dim(m)));
  if (launched) console.log(c.dim("Chrome is up, attaching..."));
  await driver.attach();
  await driver.ensureLoggedIn();

  // Gather durable context BEFORE starting the thread, so the primer can
  // carry it in one shot instead of costing tool calls later.
  const tree = await buildProjectTree();
  const created = await ensureMemoryFile(tree);
  const memory = await readMemory();
  const docs = await collectProjectDocs();
  // An unfinished plan means the last run was cut short — carry it into
  // context so this session continues rather than starting over.
  const resumable = await findResumablePlan();

  // Brand the main tab too (no close guard — it's the user's own tab and
  // it navigates, which a beforeunload prompt would interfere with).
  await driver.markTab("🤖 gemini-code · main");

  await driver.newConversation();

  // Default the model (env override: GEMINI_CODE_MODEL=pro npm run dev).
  const startModel = process.env.GEMINI_CODE_MODEL ?? DEFAULT_MODEL_ALIAS;
  let modelName = "unknown";
  try {
    modelName = await driver.setModel(startModel);
    // "fast" should mean fast: extended thinking stacks on top of the base
    // model and slows it down, so turn it off unless asked for.
    await driver.setExtendedThinking(DEFAULT_EXTENDED_THINKING);
  } catch (err) {
    modelName = await driver.getCurrentModel();
    console.log(c.yellow(`Couldn't set model to "${startModel}": ${(err as Error).message.split("\n")[0]}`));
  }

  // Banner, Claude Code style.
  console.log(`
${c.magenta("✻")} ${c.bold("gemini-code")} ${c.dim(`v${VERSION} — Claude-Code-style agent on the Gemini web UI`)}

  ${c.dim("cwd")}     ${path.basename(process.cwd())}
  ${c.dim("model")}   ${modelName}
  ${c.dim("context")} project tree (${tree.split("\n").length} lines)${memory ? `, ${MEMORY_FILENAME}` : ""}${docs.length ? `, ${docs.length} doc${docs.length > 1 ? "s" : ""} (${docs.map((d) => d.path).join(", ")})` : ""}
  ${c.dim("tools")}   ${[...tools.map((t) => t.name), "delegate_tasks", "update_plan", "screenshot_page", "read_page", "browser_open", "browser_do"].join(", ")}
  ${c.dim("workers")} up to ${MAX_PARALLEL_WORKERS} parallel Gemini tabs
  ${c.dim("mode")}    ${ORCHESTRATOR_MODE ? "orchestrator — main tab plans & validates, workers implement" : "solo — one tab does everything"}
${created ? `\n  ${c.green("✓")} created ${MEMORY_FILENAME} for durable project memory` : ""}${
    resumable
      ? `\n  ${c.yellow("⟳")} found an unfinished plan in ${PLAN_FILENAME} (${resumable.status}) — your next task will continue it`
      : ""
  }
${c.dim("Type a task, or /help for commands. Ctrl+V pastes an image; typing while a task runs steers it.")}
`);

  /**
   * The main tab can delegate subtasks to parallel worker tabs. Workers get
   * the same context and tools but NOT this one, so delegation can't nest.
   */
  const journal = new PlanJournal();
  const makeMainSession = (mem: string | undefined, resumePlan?: string) => {
    const ctx = { tree, memory: mem, docs, resumePlan };
    const delegate = createDelegateTool({
      parent: driver,
      context: { tree, memory: mem, docs },
      modelAlias: startModel,
      log: (msg) => console.log(msg),
      createSession: (workerDriver, workerContext) =>
        // Workers: no delegate tool (no nesting), no journal (the main
        // thread owns the plan), and the "worker" role so they report back
        // a short summary instead of pasting code into the orchestrator.
        new AgentSession(
          workerDriver,
          workerContext,
          [
            createScreenshotTool(workerDriver),
            createBrowsePageTool(workerDriver),
            ...createBrowserTools(workerDriver),
          ],
          undefined,
          "worker"
        ),
    });
    return new AgentSession(
      driver,
      ctx,
      [
        delegate,
        createUpdatePlanTool(journal),
        createScreenshotTool(driver),
        createBrowsePageTool(driver),
        ...createBrowserTools(driver),
      ],
      journal,
      ORCHESTRATOR_MODE ? "orchestrator" : "solo"
    );
  };

  // The resume plan is injected once, into the first session only — after
  // that it's either finished or superseded by the new run's own journal.
  let session = makeMainSession(memory, resumable?.raw);

  /** Images staged by Ctrl+V, /paste or /image, sent with the next task. */
  let stagedImages: string[] = [];
  const stageImage = (file: string) => {
    stagedImages.push(file);
    console.log(`  ${c.green("✓")} attached ${path.basename(file)} — send a task to include it\n`);
  };

  // Leave the journal marked interrupted if we're killed mid-task, so the
  // next run knows there's work to pick up.
  const onSignal = async () => {
    await journal.markInterrupted("session terminated");
    // Don't leave a dev server holding its port after we're gone.
    killAllBackgroundProcesses();
    process.exit(130);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  /**
   * Line queue rather than rl.question().
   *
   * With piped stdin (`printf 'a\nb\n' | npm run dev`) readline delivers all
   * lines up front and then closes at EOF. Awaiting question() per line
   * either hangs forever after close, or drops every line after the first.
   * Buffering 'line' events and draining them keeps interactive typing and
   * scripted input both working.
   */
  const queued: string[] = [];
  let pending: ((line: string | null) => void) | null = null;
  let inputDone = false;
  /** Set while a confirmation prompt is waiting for an answer. */
  let awaitingAnswer: ((line: string) => void) | null = null;

  rl.on("line", (line) => {
    // A confirmation has first claim on the line. Without this the answer
    // would ALSO be queued and later sent to Gemini as a task — typing "y"
    // to approve a write would become a message saying "y".
    if (awaitingAnswer) {
      const answer = awaitingAnswer;
      awaitingAnswer = null;
      answer(line);
      return;
    }
    if (pending) {
      const resolve = pending;
      pending = null;
      resolve(line);
    } else {
      queued.push(line);
    }
  });

  // Confirmation prompts borrow this readline rather than opening their own,
  // which would double-echo every keystroke and race for the same input.
  setAsker((question) => {
    process.stdout.write(question);
    return new Promise<string>((resolve) => {
      awaitingAnswer = resolve;
    });
  });
  rl.on("close", () => {
    inputDone = true;
    if (pending) {
      const resolve = pending;
      pending = null;
      resolve(null);
    }
  });

  /**
   * Ctrl+V pastes an image, NOT Cmd+V.
   *
   * macOS terminals handle Cmd+V themselves and only ever deliver clipboard
   * *text* to the process — an image paste arrives as nothing at all, so
   * there is no keystroke to hook. Ctrl+V does reach us (as \x16), so that's
   * the binding, same as Claude Code.
   */
  let pasteBusy = false;
  const onPasteKey = async () => {
    if (pasteBusy) return;
    pasteBusy = true;
    try {
      const { path: img, reason } = await readClipboardImageDetailed();
      process.stdout.write("\n");
      if (img) {
        stageImage(img);
      } else {
        console.log(`  ${c.yellow(reason ?? "no image on the clipboard")}\n`);
      }
    } finally {
      pasteBusy = false;
      process.stdout.write(c.magenta("› "));
    }
  };

  if (process.stdin.isTTY) {
    process.stdin.on("keypress", (_str, key) => {
      if (key?.ctrl && key.name === "v") void onPasteKey();
    });
  }

  const nextLine = (): Promise<string | null> => {
    if (queued.length) return Promise.resolve(queued.shift()!);
    if (inputDone) return Promise.resolve(null);
    process.stdout.write(c.magenta("› "));
    return new Promise<string | null>((resolve) => {
      pending = resolve;
    });
  };

  try {
    while (true) {
      const input = await nextLine();
      if (input === null) break;
      const task = input.trim();
      if (!task) continue;
      if (["exit", "quit", "/exit", "/quit"].includes(task.toLowerCase())) break;

      // Dragging a file into most terminals inserts its (quoted) path —
      // treat a bare image path as "attach this" rather than as a task.
      const dropped = normalizeDroppedPath(task);
      if (isImagePath(dropped) && existsSync(dropped)) {
        stageImage(dropped);
        continue;
      }

      if (task.startsWith("/")) {
        const [cmd, ...rest] = task.slice(1).split(/\s+/);
        const arg = rest.join(" ");
        try {
          switch (cmd.toLowerCase()) {
            case "help":
              console.log(`\n${helpText()}\n`);
              break;

            case "model":
              if (!arg) {
                console.log(`\n  current: ${c.bold(await driver.getCurrentModel())}\n\n${modelHelp()}\n`);
              } else {
                const name = await driver.setModel(arg);
                console.log(`  ${c.green("✓")} model: ${c.bold(name)}\n`);
              }
              break;

            case "thinking": {
              const want = /^(on|true|yes|1)$/i.test(arg);
              if (!arg) {
                console.log(`\n  current: ${c.bold(await driver.getCurrentModel())}\n  usage: /thinking on|off\n`);
                break;
              }
              await driver.setExtendedThinking(want);
              console.log(`  ${c.green("✓")} ${await driver.getCurrentModel()}\n`);
              break;
            }

            case "clear":
            case "new":
              await driver.newConversation();
              // A fresh thread has no memory of the primer, so the next task
              // must re-send it — that's what a new AgentSession does.
              session = makeMainSession(await readMemory());
              console.log(`  ${c.green("✓")} fresh conversation thread\n`);
              break;

            case "paste": {
              const { path: img, reason } = await readClipboardImageDetailed();
              if (!img) {
                console.log(
                  `  ${c.yellow(reason ?? "no image on the clipboard")}\n` +
                    `  ${c.dim("copy a screenshot (Cmd+Ctrl+Shift+4), then Ctrl+V or /paste — or /image <path>")}\n`
                );
                break;
              }
              stageImage(img);
              break;
            }

            case "image": {
              if (!arg) {
                console.log("  usage: /image <path-to-image>\n");
                break;
              }
              const file = normalizeDroppedPath(arg);
              if (!existsSync(file)) {
                console.log(`  ${c.red("no such file")}: ${file}\n`);
                break;
              }
              if (!isImagePath(file)) {
                console.log(`  ${c.yellow("that doesn't look like an image")}: ${file}\n`);
                break;
              }
              stageImage(file);
              break;
            }

            case "undo": {
              const result = await checkpoints.undoLast();
              console.log(`  ${result.ok ? c.green("✓") : c.yellow("!")} ${result.message}\n`);
              break;
            }

            case "plan": {
              const current = await readPlan();
              if (!current) {
                console.log(`  ${c.dim(`no ${PLAN_FILENAME} yet — it's written as tasks run`)}\n`);
                break;
              }
              if (arg === "clear") {
                await clearPlan();
                console.log(`  ${c.green("✓")} cleared ${PLAN_FILENAME}\n`);
                break;
              }
              console.log(`\n${current.raw}\n`);
              break;
            }

            case "memory": {
              const current = await readMemory();
              console.log(`\n${c.dim(`--- ${MEMORY_FILENAME} ---`)}\n${current ?? c.dim("(empty)")}\n`);
              break;
            }

            case "remember":
              if (!arg) {
                console.log("  usage: /remember <note>\n");
                break;
              }
              await appendMemory(arg);
              console.log(`  ${c.green("✓")} saved to ${MEMORY_FILENAME}\n`);
              break;

            case "tools":
              console.log("");
              for (const t of tools) console.log(`  ${c.cyan(t.name)}\n    ${c.dim(t.description)}`);
              console.log("");
              break;

            default:
              console.log(`  ${c.yellow(`unknown command /${cmd}`)} — try /help\n`);
          }
        } catch (err) {
          console.error(`  ${c.red((err as Error).message)}\n`);
        }
        continue;
      }

      try {
        const attachments = stagedImages;
        stagedImages = [];
        checkpoints.begin(task);
        const answer = await session.runTask(task, {
          attachments,
          onEvent: (msg) => console.log(msg),
          // Anything typed while the task runs steers it on the next turn,
          // rather than sitting in the queue until the task is over.
          // Slash commands are left queued so they still run as commands.
          getSteering: () => {
            const steer: string[] = [];
            for (let i = queued.length - 1; i >= 0; i--) {
              const line = queued[i].trim();
              if (line && !line.startsWith("/")) {
                steer.unshift(line);
                queued.splice(i, 1);
              }
            }
            return steer;
          },
        });
        await checkpoints.commit();
        console.log(`\n${answer}\n`);
      } catch (err) {
        await checkpoints.commit(); // keep snapshots from a failed run too
        // One failed task shouldn't kill the whole REPL session — report it
        // and keep the prompt alive so the browser/thread stays usable.
        console.error(`\n  ${c.red("✗")} ${(err as Error).message}\n`);
      }
    }
  } finally {
    setAsker(undefined);
    rl.close();
    killAllBackgroundProcesses();
    await driver.close();
  }
}

const USAGE = `gemini-code — a Claude-Code-style agent on the Gemini web UI

Usage:
  gemini-code                 start the agent in the current directory
  gemini-code open-chrome     open a normal Chrome window to sign into (do this first)
  gemini-code login           check that the signed-in Chrome is reachable
  gemini-code --help          this message

Environment:
  GEMINI_CODE_MODEL           fastest | fast (default) | pro
  GEMINI_CODE_MAX_WORKERS     parallel worker tabs (default 3)
  GEMINI_CODE_AUTO_APPROVE=1  skip y/N confirmations for writes, shell and network
  GEMINI_CODE_PROFILE         Chrome profile dir (default ~/.gemini-code/profile)
`;

/** Subcommands, so the installed binary is self-sufficient. */
async function cli(): Promise<void> {
  const cmd = process.argv[2];
  switch (cmd) {
    case undefined:
      return main();
    case "open-chrome":
      return void openChrome();
    case "login":
      return checkLogin();
    case "-h":
    case "--help":
    case "help":
      console.log(USAGE);
      return;
    case "-v":
    case "--version": {
      console.log(`gemini-code ${VERSION}`);
      return;
    }
    default:
      console.error(`Unknown command "${cmd}"\n\n${USAGE}`);
      process.exitCode = 1;
  }
}

cli().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
