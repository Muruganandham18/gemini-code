import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ToolDefinition } from "../types.js";

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  ".cache",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
  ".gemini-code-profile",
  ".gemini-code-tmp",
  ".tmp-test",
]);

/** Skip anything that isn't text — a match inside a binary is noise. */
const BINARY_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|pdf|zip|gz|tar|mp4|mov|mp3|wav|woff2?|ttf|eot|so|dylib|exe|bin|lock)$/i;

const MAX_RESULTS = 200;
const MAX_FILE_BYTES = 2_000_000;

export interface SearchHit {
  file: string;
  line: number;
  text: string;
}

export async function searchCode(opts: {
  pattern: string;
  root?: string;
  glob?: string;
  caseSensitive?: boolean;
  maxResults?: number;
}): Promise<{ hits: SearchHit[]; filesScanned: number; truncated: boolean }> {
  const root = opts.root ?? process.cwd();
  const max = Math.min(opts.maxResults ?? 100, MAX_RESULTS);
  const re = new RegExp(opts.pattern, opts.caseSensitive ? "" : "i");
  // A simple *.ts / *.py style filter, not full glob semantics.
  const globRe = opts.glob
    ? new RegExp("^" + opts.glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$", "i")
    : undefined;

  const hits: SearchHit[] = [];
  let filesScanned = 0;
  let truncated = false;

  async function walk(dir: string): Promise<void> {
    if (truncated) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      if (IGNORED_DIRS.has(entry.name) || (entry.name.startsWith(".") && entry.isDirectory())) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (BINARY_EXT.test(entry.name)) continue;
      if (globRe && !globRe.test(entry.name)) continue;

      try {
        const info = await stat(full);
        if (info.size > MAX_FILE_BYTES) continue;
        const content = await readFile(full, "utf8");
        filesScanned++;
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            hits.push({ file: path.relative(root, full), line: i + 1, text: lines[i].trim().slice(0, 200) });
            if (hits.length >= max) {
              truncated = true;
              return;
            }
          }
        }
      } catch {
        // Unreadable or not valid UTF-8 — skip rather than fail the search.
      }
    }
  }

  await walk(root);
  return { hits, filesScanned, truncated };
}

export const searchCodeTool: ToolDefinition = {
  name: "search_code",
  description:
    `search_code(args: {pattern: string, glob?: string, caseSensitive?: boolean, maxResults?: number}) -> searches ` +
    `the project for a regular expression and returns file:line matches. Use this to FIND things before reading ` +
    `them — it's far cheaper than reading whole files to look around. 'glob' filters by filename (e.g. "*.ts"). ` +
    `Build/noise directories and binary files are skipped automatically.`,
  async run(args) {
    const pattern = String(args.pattern ?? "");
    if (!pattern) return { ok: false, output: "Error: 'pattern' is required." };

    try {
      new RegExp(pattern);
    } catch (err) {
      return { ok: false, output: `Error: invalid regular expression — ${(err as Error).message}` };
    }

    try {
      const { hits, filesScanned, truncated } = await searchCode({
        pattern,
        glob: typeof args.glob === "string" ? args.glob : undefined,
        caseSensitive: Boolean(args.caseSensitive),
        maxResults: Number(args.maxResults) || undefined,
      });

      if (hits.length === 0) {
        return { ok: true, output: `No matches for /${pattern}/ (searched ${filesScanned} files).` };
      }

      const body = hits.map((h) => `${h.file}:${h.line}: ${h.text}`).join("\n");
      return {
        ok: true,
        output:
          `${hits.length} match(es) in ${filesScanned} files:\n${body}` +
          (truncated ? `\n\n[stopped at the result limit — narrow the pattern or use glob]` : ""),
      };
    } catch (err) {
      return { ok: false, output: `Error searching: ${(err as Error).message}` };
    }
  },
};
