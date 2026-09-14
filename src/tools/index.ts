import type { ToolDefinition } from "../types.js";
import { readFileTool } from "./readFile.js";
import { writeFileTool } from "./writeFile.js";
import { bashTool, checkOutputTool, killProcessTool } from "./bash.js";
import { listFilesTool } from "./listFiles.js";
import { rememberTool } from "./remember.js";
import { fetchUrlTool } from "./fetchUrl.js";

export const tools: ToolDefinition[] = [
  readFileTool,
  writeFileTool,
  bashTool,
  checkOutputTool,
  killProcessTool,
  listFilesTool,
  rememberTool,
  fetchUrlTool,
];

export const toolsByName: Record<string, ToolDefinition> = Object.fromEntries(
  tools.map((t) => [t.name, t])
);
