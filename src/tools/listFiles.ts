import path from "node:path";
import type { ToolDefinition } from "../types.js";
import { buildProjectTree } from "../context/projectTree.js";

export const listFilesTool: ToolDefinition = {
  name: "list_files",
  description: `list_files(args: {path?: string}) -> an ASCII tree of the project (or of a subdirectory). Use this instead of running \`ls\` via run_bash. Noise dirs (node_modules, .git, dist, venv, …) are excluded automatically.`,
  async run(args) {
    const rel = String(args.path ?? ".");
    const abs = path.resolve(process.cwd(), rel);
    if (!abs.startsWith(process.cwd())) {
      return { ok: false, output: "Error: path escapes the project root, refusing to list it." };
    }
    try {
      const tree = await buildProjectTree({ root: abs });
      return { ok: true, output: tree };
    } catch (err) {
      return { ok: false, output: `Error listing ${rel}: ${(err as Error).message}` };
    }
  },
};
