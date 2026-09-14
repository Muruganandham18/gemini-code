import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ToolDefinition } from "../types.js";
import { confirmAction } from "./confirm.js";
import { checkpoints } from "../context/checkpoint.js";

/** Keeps the confirmation prompt readable when a replacement is large. */
function preview(text: string, lines = 6): string {
  const parts = text.split("\n");
  const shown = parts.slice(0, lines).join("\n");
  return parts.length > lines ? `${shown}\n… (+${parts.length - lines} more lines)` : shown;
}

export const editFileTool: ToolDefinition = {
  name: "edit_file",
  description:
    `edit_file(args: {path: string, old_text: string, new_text: string, replace_all?: boolean}) -> replaces an exact ` +
    `piece of text in a file, leaving everything else untouched. PREFER THIS OVER write_file for changing an ` +
    `existing file: you only send the part that changes, instead of regenerating the whole file (which is slow, ` +
    `and risks silently losing any part you don't reproduce exactly). old_text must match the file exactly, ` +
    `including indentation, and must be unique unless you set replace_all. Read the file first if unsure.`,
  async run(args) {
    const rel = String(args.path ?? "");
    const oldText = String(args.old_text ?? "");
    const newText = String(args.new_text ?? "");
    const replaceAll = Boolean(args.replace_all);

    if (!rel) return { ok: false, output: "Error: 'path' is required." };
    if (!oldText) {
      return {
        ok: false,
        output: "Error: 'old_text' is required (use write_file to create a new file).",
      };
    }
    if (oldText === newText) {
      return { ok: false, output: "Error: 'old_text' and 'new_text' are identical — nothing to do." };
    }

    const abs = path.resolve(process.cwd(), rel);
    if (!abs.startsWith(process.cwd())) {
      return { ok: false, output: "Error: path escapes the project root, refusing to edit it." };
    }

    let content: string;
    try {
      content = await readFile(abs, "utf8");
    } catch (err) {
      return { ok: false, output: `Error reading ${rel}: ${(err as Error).message}` };
    }

    const occurrences = content.split(oldText).length - 1;
    if (occurrences === 0) {
      return {
        ok: false,
        output:
          `Error: that exact text isn't in ${rel}. It must match character for character, including ` +
          `indentation and line breaks. Read the file and copy the target text verbatim.`,
      };
    }
    // Refusing an ambiguous match is the whole safety property here: picking
    // "the first one" would silently edit a line the model didn't mean.
    if (occurrences > 1 && !replaceAll) {
      return {
        ok: false,
        output:
          `Error: that text appears ${occurrences} times in ${rel}, so it's ambiguous. Include more ` +
          `surrounding context to make it unique, or set replace_all: true to change every occurrence.`,
      };
    }

    const detail =
      `${rel} — ${replaceAll ? `${occurrences} occurrence(s)` : "1 occurrence"}\n` +
      `  - ${preview(oldText).split("\n").join("\n  - ")}\n` +
      `  + ${preview(newText).split("\n").join("\n  + ")}`;
    if (!(await confirmAction("Edit file?", detail))) {
      return { ok: false, output: "User declined this edit." };
    }

    const updated = replaceAll
      ? content.split(oldText).join(newText)
      : content.replace(oldText, newText);

    try {
      await checkpoints.recordBeforeWrite(abs);
      await writeFile(abs, updated, "utf8");
    } catch (err) {
      return { ok: false, output: `Error writing ${rel}: ${(err as Error).message}` };
    }

    const delta = updated.split("\n").length - content.split("\n").length;
    return {
      ok: true,
      output:
        `Edited ${rel} (${replaceAll ? `${occurrences} replacements` : "1 replacement"}` +
        `${delta === 0 ? "" : `, ${delta > 0 ? "+" : ""}${delta} lines`}).`,
    };
  },
};
