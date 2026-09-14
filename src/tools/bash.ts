import { spawn } from "node:child_process";
import { openSync, closeSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { ToolDefinition } from "../types.js";
import { confirmAction } from "./confirm.js";

const TMP_DIR = ".gemini-code-tmp";
const FOREGROUND_TIMEOUT_MS = Number(process.env.GEMINI_CODE_BASH_TIMEOUT_MS ?? 60_000);
const MAX_OUTPUT_CHARS = 20_000;

export interface BackgroundProcess {
  id: string;
  command: string;
  pid: number;
  logPath: string;
  startedAt: number;
  exitCode: number | null;
}

/** Everything we've launched in the background, so it can be read and cleaned up. */
export const backgroundProcesses = new Map<string, BackgroundProcess>();

/**
 * Commands that never return on their own.
 *
 * Running one in the foreground is the single worst thing this tool can do:
 * it blocks the agent until the timeout, produces endlessly-growing output,
 * then kills the server anyway — so the model waits a minute to learn
 * nothing. These get moved to the background automatically.
 */
const LONG_RUNNING = [
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve|watch)\b/,
  /\bnext\s+dev\b/,
  /\bvite\b(?!.*\bbuild\b)/,
  /\bnodemon\b/,
  /\bwebpack\s+(serve|--watch)\b/,
  /\buvicorn\b/,
  /\bgunicorn\b/,
  /\bflask\s+run\b/,
  /\bpython3?\s+-m\s+http\.server\b/,
  /\brails\s+s(erver)?\b/,
  /\bdocker\s+compose\s+up\b(?!.*-d)/,
  /\btail\s+-f\b/,
  /--watch\b/,
];

export function looksLongRunning(command: string): boolean {
  return LONG_RUNNING.some((re) => re.test(command));
}

function tmpDir(): string {
  const dir = path.resolve(process.cwd(), TMP_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function tail(text: string, chars = MAX_OUTPUT_CHARS): string {
  return text.length > chars ? `[...truncated...]\n${text.slice(-chars)}` : text;
}

/**
 * Kills a whole process GROUP, not just the process.
 *
 * `npm run dev` is a shell that spawns npm that spawns node; killing the
 * shell alone orphans the server, which then holds its port forever and
 * leaks across runs. Spawning detached gives each command its own group so
 * a negative PID takes the entire tree down.
 */
function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }, 3_000).unref();
}

function runForeground(command: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    // Intentionally shell-based: the point of this tool is running real
    // command lines, pipes and redirects included, exactly like Claude
    // Code's Bash tool. The control is the confirm() gate, not arg escaping.
    const child = spawn(command, { cwd: process.cwd(), shell: true, detached: true });
    let out = "";
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      if (child.pid) killGroup(child.pid);
    }, FOREGROUND_TIMEOUT_MS);

    child.stdout?.on("data", (d) => (out += d.toString()));
    child.stderr?.on("data", (d) => (out += d.toString()));

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, output: `Failed to start: ${err.message}` });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (killed) {
        resolve({
          ok: false,
          output:
            `Command timed out after ${FOREGROUND_TIMEOUT_MS / 1000}s and was killed.\n` +
            `If this is a server or watcher that doesn't exit on its own, re-run it with ` +
            `"background": true — then use check_output to read its logs.\n\n` +
            `Partial output:\n${tail(out)}`,
        });
      } else {
        resolve({
          ok: code === 0,
          output: (code === 0 ? "" : `Exit code ${code}\n`) + (tail(out) || "(no output)"),
        });
      }
    });
  });
}

function runBackground(command: string): { ok: boolean; output: string } {
  const id = `bg_${Date.now().toString(36)}`;
  const logPath = path.join(tmpDir(), `${id}.log`);
  const fd = openSync(logPath, "a");

  const child = spawn(command, {
    cwd: process.cwd(),
    shell: true,
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  child.unref();
  closeSync(fd);

  if (!child.pid) return { ok: false, output: "Failed to start the background process." };

  const record: BackgroundProcess = {
    id,
    command,
    pid: child.pid,
    logPath,
    startedAt: Date.now(),
    exitCode: null,
  };
  backgroundProcesses.set(id, record);
  child.on("exit", (code) => {
    record.exitCode = code;
  });

  return {
    ok: true,
    output:
      `Started in the background as "${id}" (pid ${child.pid}).\n` +
      `It keeps running while you continue. Use check_output with id "${id}" to read its output ` +
      `(give it a second or two to produce any), and kill_process to stop it.`,
  };
}

export const bashTool: ToolDefinition = {
  name: "run_bash",
  description:
    `run_bash(args: {command: string, background?: boolean}) -> runs a shell command in the project root. ` +
    `Returns its output, or times out after ${FOREGROUND_TIMEOUT_MS / 1000}s. ` +
    `Set background: true for anything that does NOT exit on its own — dev servers, watchers, tails — ` +
    `and it returns an id immediately instead of blocking; read its logs with check_output. ` +
    `Commands that obviously never exit (npm run dev, vite, uvicorn, …) are backgrounded automatically. ` +
    `The user confirms before each command runs.`,
  async run(args) {
    const command = String(args.command ?? "").trim();
    if (!command) return { ok: false, output: "Error: 'command' is required." };

    const wantsBackground = Boolean(args.background) || looksLongRunning(command);

    const approved = await confirmAction(
      wantsBackground ? "Run shell command (in background)?" : "Run shell command?",
      command
    );
    if (!approved) return { ok: false, output: "User declined to run this command." };

    if (wantsBackground) {
      const result = runBackground(command);
      if (result.ok && !args.background) {
        result.output =
          `This looks like a long-running process, so it was started in the background ` +
          `rather than blocking.\n${result.output}`;
      }
      return result;
    }

    return runForeground(command);
  },
};

export const checkOutputTool: ToolDefinition = {
  name: "check_output",
  description:
    `check_output(args: {id?: string, lines?: number}) -> reads recent output from a background process ` +
    `started by run_bash. Omit 'id' to list everything currently running. Use this to see whether a dev ` +
    `server actually came up, or what a build is doing.`,
  async run(args) {
    const id = args.id ? String(args.id) : undefined;

    if (!id) {
      if (backgroundProcesses.size === 0) return { ok: true, output: "No background processes." };
      const list = [...backgroundProcesses.values()]
        .map(
          (p) =>
            `- ${p.id} (pid ${p.pid}, ${Math.round((Date.now() - p.startedAt) / 1000)}s, ` +
            `${p.exitCode === null ? "running" : `exited ${p.exitCode}`}): ${p.command}`
        )
        .join("\n");
      return { ok: true, output: list };
    }

    const proc = backgroundProcesses.get(id);
    if (!proc) {
      return {
        ok: false,
        output: `No background process "${id}". Known: ${[...backgroundProcesses.keys()].join(", ") || "(none)"}`,
      };
    }

    let content = "";
    try {
      content = readFileSync(proc.logPath, "utf8");
    } catch {
      content = "";
    }
    const lines = Number(args.lines);
    if (Number.isFinite(lines) && lines > 0) {
      content = content.split("\n").slice(-lines).join("\n");
    }
    const status = proc.exitCode === null ? "running" : `exited with code ${proc.exitCode}`;
    return {
      ok: true,
      output: `${proc.id} (${status}): ${proc.command}\n\n${tail(content) || "(no output yet)"}`,
    };
  },
};

export const killProcessTool: ToolDefinition = {
  name: "kill_process",
  description:
    `kill_process(args: {id: string}) -> stops a background process started by run_bash, including any ` +
    `child processes it spawned. Do this when you're finished with a dev server you started.`,
  async run(args) {
    const id = String(args.id ?? "");
    const proc = backgroundProcesses.get(id);
    if (!proc) return { ok: false, output: `No background process "${id}".` };
    if (proc.exitCode !== null) return { ok: true, output: `"${id}" had already exited.` };

    killGroup(proc.pid);
    proc.exitCode = proc.exitCode ?? -1;
    return { ok: true, output: `Stopped "${id}" (pid ${proc.pid}) and its children.` };
  },
};

/** Stops everything we launched — called when the CLI exits so nothing is orphaned. */
export function killAllBackgroundProcesses(): void {
  for (const proc of backgroundProcesses.values()) {
    if (proc.exitCode === null) killGroup(proc.pid);
  }
}
