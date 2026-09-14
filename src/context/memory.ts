import { readFile, writeFile, appendFile, access } from "node:fs/promises";
import path from "node:path";

export const MEMORY_FILENAME = "GEMINI.md";

function memoryPath(root = process.cwd()): string {
  return path.resolve(root, MEMORY_FILENAME);
}

/**
 * GEMINI.md is durable, human-readable project context that survives across
 * sessions — the web UI's own conversation memory dies with the thread (and
 * gets silently truncated on long ones), so anything worth keeping goes
 * here and gets replayed into the primer at the start of every session.
 */
export async function readMemory(root = process.cwd()): Promise<string | undefined> {
  try {
    const content = await readFile(memoryPath(root), "utf8");
    return content.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Creates GEMINI.md with a starter header + current tree, if absent. Returns true if created. */
export async function ensureMemoryFile(tree: string, root = process.cwd()): Promise<boolean> {
  const file = memoryPath(root);
  try {
    await access(file);
    return false; // already exists — never clobber the user's notes
  } catch {
    const initial = `# Project memory (GEMINI.md)

Durable notes for the gemini-code agent. Replayed into the model's context at
the start of every session. Edit freely — it's a normal markdown file.

## Project structure (snapshot at first run)

\`\`\`
${tree}
\`\`\`

## Notes

<!-- The agent appends notes below via the \`remember\` tool. -->
`;
    await writeFile(file, initial, "utf8");
    return true;
  }
}

/** Appends a timestamped note to the Notes section. */
export async function appendMemory(note: string, root = process.cwd()): Promise<void> {
  const stamp = new Date().toISOString().slice(0, 10);
  await appendFile(memoryPath(root), `\n- (${stamp}) ${note.trim()}\n`, "utf8");
}
