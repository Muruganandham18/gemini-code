import type { ToolDefinition } from "../types.js";
import { appendMemory, MEMORY_FILENAME } from "../context/memory.js";

export const rememberTool: ToolDefinition = {
  name: "remember",
  description: `remember(args: {note: string}) -> appends a short note to ${MEMORY_FILENAME}, which is replayed into your context at the start of every future session. Use it for durable facts worth keeping (project conventions, architecture decisions, gotchas) — NOT for step-by-step progress within the current task.`,
  async run(args) {
    const note = String(args.note ?? "").trim();
    if (!note) return { ok: false, output: "Error: 'note' is required." };
    if (note.length > 2000) {
      return { ok: false, output: "Error: note too long (max 2000 chars) — keep memory notes short." };
    }
    try {
      await appendMemory(note);
      return { ok: true, output: `Saved to ${MEMORY_FILENAME}.` };
    } catch (err) {
      return { ok: false, output: `Error writing ${MEMORY_FILENAME}: ${(err as Error).message}` };
    }
  },
};
