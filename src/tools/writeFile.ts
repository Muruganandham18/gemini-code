import { mkdir, writeFile as fsWriteFile } from "node:fs/promises";
import path from "node:path";
import type { ToolDefinition } from "../types.js";
import { confirmAction } from "./confirm.js";

export const writeFileTool: ToolDefinition = {
  name: "write_file",
  description: `write_file(args: {path: string, content: string}) -> writes/overwrites a file (creates parent dirs). Path is resolved relative to the project root. You will be asked to confirm before each write.`,
  async run(args) {
    const rel = String(args.path ?? "");
    const content = String(args.content ?? "");
    if (!rel) return { ok: false, output: "Error: 'path' is required." };
    const abs = path.resolve(process.cwd(), rel);
    if (!abs.startsWith(process.cwd())) {
      return { ok: false, output: "Error: path escapes the project root, refusing to write it." };
    }

    const approved = await confirmAction("Write file?", `${rel} (${content.length} bytes)`);
    if (!approved) {
      return { ok: false, output: "User declined to write this file." };
    }

    try {
      await mkdir(path.dirname(abs), { recursive: true });
      await fsWriteFile(abs, content, "utf8");
      return { ok: true, output: `Wrote ${content.length} bytes to ${rel}` };
    } catch (err) {
      return { ok: false, output: `Error writing ${rel}: ${(err as Error).message}` };
    }
  },
};
