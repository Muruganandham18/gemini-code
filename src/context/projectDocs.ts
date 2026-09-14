import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { MEMORY_FILENAME } from "./memory.js";
import { PLAN_FILENAME } from "./plan.js";

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

export interface ProjectDoc {
  /** Path relative to the project root. */
  path: string;
  content: string;
}

export interface DocsOptions {
  root?: string;
  /** Total character budget across all docs. */
  maxTotalChars?: number;
  /** Per-file cap, so one huge doc can't eat the whole budget. */
  maxFileChars?: number;
  maxDepth?: number;
}

/**
 * Collects the project's markdown as initial knowledge — READMEs, docs/,
 * architecture notes, and so on. These usually say more about intent and
 * conventions than the source does, and handing them over up front saves
 * Gemini from discovering the same things through tool calls.
 *
 * GEMINI.md is excluded here because it's carried separately as durable
 * agent memory (see memory.ts) and would otherwise appear twice.
 */
export async function collectProjectDocs(opts: DocsOptions = {}): Promise<ProjectDoc[]> {
  const root = opts.root ?? process.cwd();
  const maxTotalChars = opts.maxTotalChars ?? 60_000;
  const maxFileChars = opts.maxFileChars ?? 20_000;
  const maxDepth = opts.maxDepth ?? 4;

  const found: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (
        /\.mdx?$/i.test(entry.name) &&
        entry.name !== MEMORY_FILENAME &&
        entry.name !== PLAN_FILENAME
      )
        found.push(full);
    }
  }

  await walk(root, 1);

  // Shallower files first (README.md at the root matters more than
  // docs/internal/notes/deep.md), then alphabetically for stability.
  found.sort((a, b) => {
    const depthDiff = a.split(path.sep).length - b.split(path.sep).length;
    return depthDiff !== 0 ? depthDiff : a.localeCompare(b);
  });

  const docs: ProjectDoc[] = [];
  let budget = maxTotalChars;
  for (const file of found) {
    if (budget <= 0) break;
    try {
      const info = await stat(file);
      if (!info.isFile()) continue;
      let content = await readFile(file, "utf8");
      if (content.length > maxFileChars) {
        content = content.slice(0, maxFileChars) + `\n\n[truncated at ${maxFileChars} characters]`;
      }
      if (content.length > budget) {
        content = content.slice(0, budget) + "\n\n[truncated — context budget reached]";
      }
      budget -= content.length;
      docs.push({ path: path.relative(root, file), content });
    } catch {
      // Unreadable file — skip rather than fail the whole collection.
    }
  }
  return docs;
}
