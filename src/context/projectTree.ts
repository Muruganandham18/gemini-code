import { readdir } from "node:fs/promises";
import path from "node:path";

/** Directories never worth showing the model — noise that also blows the entry budget. */
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".cache",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".gradle",
  "target",
  ".gemini-code-profile",
  ".gemini-code-tmp",
  ".tmp-test",
]);

export interface TreeOptions {
  root?: string;
  /** Stop after this many entries so a huge repo can't flood the prompt. */
  maxEntries?: number;
  /** How deep to descend. */
  maxDepth?: number;
}

/**
 * Renders an ASCII tree of the project, for handing to Gemini as up-front
 * context so it doesn't have to burn tool calls running `ls` just to learn
 * the layout.
 */
export async function buildProjectTree(opts: TreeOptions = {}): Promise<string> {
  const root = opts.root ?? process.cwd();
  const maxEntries = opts.maxEntries ?? 400;
  const maxDepth = opts.maxDepth ?? 6;

  const lines: string[] = [`${path.basename(root)}/`];
  let count = 0;
  let truncated = false;

  async function walk(dir: string, prefix: string, depth: number): Promise<void> {
    if (truncated || depth > maxDepth) return;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip rather than fail the whole tree
    }

    const visible = entries
      .filter((e) => !IGNORED_DIRS.has(e.name))
      .filter((e) => !e.name.startsWith(".") || e.name === ".env.example")
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    for (let i = 0; i < visible.length; i++) {
      if (count >= maxEntries) {
        truncated = true;
        lines.push(`${prefix}└── … (truncated at ${maxEntries} entries)`);
        return;
      }
      const entry = visible[i];
      const isLast = i === visible.length - 1;
      lines.push(`${prefix}${isLast ? "└── " : "├── "}${entry.name}${entry.isDirectory() ? "/" : ""}`);
      count++;
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), prefix + (isLast ? "    " : "│   "), depth + 1);
      }
    }
  }

  await walk(root, "", 1);
  return lines.join("\n");
}
