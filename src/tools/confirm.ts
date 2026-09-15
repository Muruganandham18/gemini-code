import readline from "node:readline/promises";
import { getAsker } from "../ui/prompt.js";

/**
 * Serializes prompts. With parallel worker tabs, several tools can want
 * confirmation at the same moment — without this they'd interleave their
 * questions and steal each other's keystrokes.
 */
let queue: Promise<unknown> = Promise.resolve();

/**
 * Shared y/N confirmation gate for any tool that takes a side-effecting
 * local action (writing a file, running a shell command, making a network
 * request). One place so they stay in sync, and one escape-hatch env var.
 *
 * Read at call time, not module load, so tests/scripts can toggle it
 * per-invocation instead of only via the process's startup environment.
 */
export async function confirmAction(promptLabel: string, detail: string): Promise<boolean> {
  if (process.env.GEMINI_CODE_AUTO_APPROVE === "1") return true;

  const run = queue.then(() => ask(promptLabel, detail));
  // Keep the chain alive even if one prompt rejects.
  queue = run.catch(() => undefined);
  return run;
}

async function ask(promptLabel: string, detail: string): Promise<boolean> {
  const question = `\n[gemini-code] ${promptLabel}\n  ${detail}\n  (y/N) `;

  // Prefer the REPL's own readline. Opening a second interface on the same
  // stdin makes the terminal echo each keystroke twice AND delivers the
  // answer to the REPL as well, where "y" gets sent to Gemini as a task.
  const asker = getAsker();
  if (asker) {
    const answer = await asker(question);
    return answer.trim().toLowerCase() === "y";
  }

  // Standalone use (scripts, tests): nobody owns stdin, so make our own.
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return answer.trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
}
