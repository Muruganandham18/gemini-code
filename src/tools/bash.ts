import { exec } from "node:child_process";
import type { ToolDefinition } from "../types.js";
import { confirmAction } from "./confirm.js";

export const bashTool: ToolDefinition = {
  name: "run_bash",
  description: `run_bash(args: {command: string}) -> runs a shell command in the project root and returns stdout+stderr. You will be asked to confirm before each command runs.`,
  async run(args) {
    const command = String(args.command ?? "");
    if (!command) return { ok: false, output: "Error: 'command' is required." };

    // Intentionally shell-based (child_process.exec, not execFile): the
    // point of this tool is running arbitrary shell command lines,
    // including pipes/redirects/globs, exactly like Claude Code's own Bash
    // tool. The safety control is the manual confirm() gate above, not
    // avoiding a shell — the command always comes from an LLM turn the
    // user reviews before it runs, never from unreviewed network input.

    const approved = await confirmAction("Run shell command?", command);
    if (!approved) {
      return { ok: false, output: "User declined to run this command." };
    }

    return new Promise((resolve) => {
      exec(command, { cwd: process.cwd(), timeout: 60_000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          resolve({ ok: false, output: `Exit code ${err.code}\nstdout:\n${stdout}\nstderr:\n${stderr}` });
        } else {
          resolve({ ok: true, output: stdout || stderr || "(no output)" });
        }
      });
    });
  },
};
