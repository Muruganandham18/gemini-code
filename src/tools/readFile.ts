import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ToolDefinition } from "../types.js";

export const readFileTool: ToolDefinition = {
  name: "read_file",
  description: `read_file(args: {path: string}) -> file contents as text. Path is resolved relative to the project root.`,
  async run(args) {
    const rel = String(args.path ?? "");
    if (!rel) return { ok: false, output: "Error: 'path' is required." };
    const abs = path.resolve(process.cwd(), rel);
    if (!abs.startsWith(process.cwd())) {
      return { ok: false, output: "Error: path escapes the project root, refusing to read it." };
    }
    try {
      const content = await readFile(abs, "utf8");
      return { ok: true, output: content };
    } catch (err) {
      return { ok: false, output: `Error reading ${rel}: ${(err as Error).message}` };
    }
  },
};
