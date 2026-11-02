import type { ToolDefinition } from "../types.js";
import { readFileTool } from "./readFile.js";
import { editFileTool, multiEditTool } from "./editFile.js";
import { searchCodeTool } from "./searchCode.js";
import { gitStatusTool, gitDiffTool, gitLogTool, gitShowTool, gitBlameTool } from "./git.js";
import { writeFileTool } from "./writeFile.js";
import { bashTool, checkOutputTool, killProcessTool, waitForOutputTool } from "./bash.js";
import { listFilesTool } from "./listFiles.js";
import { rememberTool } from "./remember.js";
import { fetchUrlTool } from "./fetchUrl.js";
import { webSearchTool } from "./webSearch.js";
import { copyFileTool, deleteFileTool, fileInfoTool, findFilesTool, moveFileTool, readFilesTool } from "./files.js";
import { notebookEditTool, notebookReadTool } from "./notebook.js";
import { codeOutlineTool, findSymbolTool } from "./code.js";
import { useSkillTool } from "./skills.js";
import { askUserTool } from "./askUser.js";
import { deferTool } from "./toolSearch.js";

export const tools: ToolDefinition[] = [
  // Described in the primer: what nearly every task needs, so the first task
  // doesn't spend a turn loading them. Each one here costs context in every
  // thread, so a tool needs a good reason to be on this list.
  readFileTool,
  writeFileTool,
  editFileTool,
  searchCodeTool,
  findFilesTool,
  listFilesTool,
  bashTool,
  checkOutputTool,
  gitStatusTool,
  gitDiffTool,
  // Not deferred: the context lists skills by description, so a skill that
  // fits should cost one call to use, not a tool_search first.
  useSkillTool,

  // Named in the primer and loaded through tool_search when wanted.
  ...[
    readFilesTool,
    multiEditTool,
    fileInfoTool,
    moveFileTool,
    copyFileTool,
    deleteFileTool,
    notebookReadTool,
    notebookEditTool,
    codeOutlineTool,
    findSymbolTool,
    gitLogTool,
    gitShowTool,
    gitBlameTool,
    waitForOutputTool,
    killProcessTool,
    fetchUrlTool,
    webSearchTool,
    rememberTool,
    askUserTool,
  ].map(deferTool),
];

export const toolsByName: Record<string, ToolDefinition> = Object.fromEntries(
  tools.map((t) => [t.name, t])
);
