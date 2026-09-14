import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ToolDefinition } from "../types.js";

/**
 * Beyond this, reading a whole file is almost certainly a mistake: it eats
 * the composer budget and pushes the conversation towards the truncation
 * the web UI performs silently. The model gets the head of the file plus
 * instructions for asking for a specific range.
 */
const AUTO_HEAD_LINES = 400;

export const readFileTool: ToolDefinition = {
  name: "read_file",
  description:
    `read_file(args: {path: string, offset?: number, limit?: number}) -> file contents as text. 'offset' is the ` +
    `1-based first line and 'limit' how many lines to return — use them on large files instead of reading ` +
    `everything, and use search_code to find the interesting line first. Content is returned verbatim (no line ` +
    `numbers) so you can copy from it straight into edit_file. Path is relative to the project root.`,
  async run(args) {
    const rel = String(args.path ?? "");
    if (!rel) return { ok: false, output: "Error: 'path' is required." };

    const abs = path.resolve(process.cwd(), rel);
    if (!abs.startsWith(process.cwd())) {
      return { ok: false, output: "Error: path escapes the project root, refusing to read it." };
    }

    let content: string;
    try {
      content = await readFile(abs, "utf8");
    } catch (err) {
      return { ok: false, output: `Error reading ${rel}: ${(err as Error).message}` };
    }

    const lines = content.split("\n");
    const total = lines.length;

    const offsetArg = Number(args.offset);
    const limitArg = Number(args.limit);
    const hasRange = Number.isFinite(offsetArg) || Number.isFinite(limitArg);

    const start = Math.max(1, Number.isFinite(offsetArg) ? offsetArg : 1);
    const requested = Number.isFinite(limitArg) ? Math.max(1, limitArg) : undefined;

    // No range asked for on a big file: return the head rather than
    // flooding the thread, and say how to get the rest.
    const limit = requested ?? (hasRange ? total : Math.min(total, AUTO_HEAD_LINES));
    const slice = lines.slice(start - 1, start - 1 + limit);

    if (slice.length === 0) {
      return { ok: false, output: `Error: ${rel} has ${total} lines; offset ${start} is past the end.` };
    }

    const lastShown = start + slice.length - 1;
    const showingAll = start === 1 && lastShown === total;

    // Content is returned verbatim, deliberately WITHOUT line numbers: the
    // model copies from this straight into edit_file's old_text, and a
    // "  42  " prefix would make every one of those edits fail to match.
    // Line context goes in a header instead, and search_code gives
    // file:line when a location is what's actually needed.
    const header = showingAll ? "" : `[lines ${start}-${lastShown} of ${total}]\n\n`;
    const footer =
      lastShown < total
        ? `\n\n[${total - lastShown} more lines. Continue with offset: ${lastShown + 1}, or use search_code ` +
          `to jump straight to what you need.]`
        : "";

    return { ok: true, output: header + slice.join("\n") + footer };
  },
};
