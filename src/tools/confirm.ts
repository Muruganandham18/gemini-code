import readline from "node:readline/promises";

/**
 * Serializes prompts. With parallel worker tabs, several tools can want
 * confirmation at the same moment — without this they'd each attach a
 * readline to stdin simultaneously, interleave their questions, and steal
 * each other's keystrokes. Queueing means you answer one at a time.
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
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`\n[gemini-code] ${promptLabel}\n  ${detail}\n  (y/N) `);
    return answer.trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
}
