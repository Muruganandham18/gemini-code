import { mkdir, writeFile as fsWriteFile } from "node:fs/promises";
import path from "node:path";
import type { ToolDefinition } from "../types.js";
import { resolveInRoot } from "./paths.js";
import { confirmAction } from "./confirm.js";
import { checkpoints } from "../context/checkpoint.js";

export const writeFileTool: ToolDefinition = {
  name: "write_file",
  description:
    `write_file(args: {path: string, content: string}) -> writes a file in full, creating parent dirs. Use this for ` +
    `NEW files. To change an existing file use edit_file instead — rewriting a whole file to alter part of it is ` +
    `slow and silently loses anything you don't reproduce exactly. Path is relative to the project root. ` +
    `You will be asked to confirm before each write.`,
  async run(args) {
    const rel = String(args.path ?? "");
    const content = String(args.content ?? "");
    if (!rel) return { ok: false, output: "Error: 'path' is required." };
    const resolved = resolveInRoot(rel);
    if (!resolved.ok) {
      return { ok: false, output: "Error: path escapes the project root, refusing to write it." };
    }
    const abs = resolved.abs;

    const approved = await confirmAction("Write file?", `${rel} (${content.length} bytes)`);
    if (!approved) {
      return { ok: false, output: "User declined to write this file." };
    }

    try {
      // Snapshot before clobbering, so /undo can put it back.
      await checkpoints.recordBeforeWrite(abs);
      await mkdir(path.dirname(abs), { recursive: true });
      await fsWriteFile(abs, content, "utf8");
      return { ok: true, output: `Wrote ${content.length} bytes to ${rel}` };
    } catch (err) {
      return { ok: false, output: `Error writing ${rel}: ${(err as Error).message}` };
    }
  },
};
