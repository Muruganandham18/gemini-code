import type { ToolDefinition } from "../types.js";
import { MEMORY_FILENAME } from "../context/memory.js";
import type { ProjectDoc } from "../context/projectDocs.js";

export interface PrimerContext {
  /** ASCII project tree, so the model starts out knowing the layout. */
  tree?: string;
  /** Contents of GEMINI.md, replayed so knowledge survives across sessions. */
  memory?: string;
  /** The project's own markdown docs (README etc.) as initial knowledge. */
  docs?: ProjectDoc[];
  /** An unfinished plan from a previous run, for resuming interrupted work. */
  resumePlan?: string;
}

/**
 * The RULES half of the primer: tool list + the tool-call protocol.
 *
 * Deliberately kept compact and always sent INLINE, never as an attachment —
 * if Gemini doesn't read the rules it can't emit a parseable tool call at
 * all, so these must not depend on it opening a file first. The bulky
 * knowledge (tree, memory, docs) goes through buildContextDocument() and is
 * attached instead, keeping the composer's text budget for the task itself.
 */
export type AgentRole = "orchestrator" | "worker" | "solo";

/**
 * Role-specific instructions.
 *
 * The orchestrator/worker split exists to protect the MAIN thread's context.
 * Gemini's web UI gives no context-window control and silently truncates long
 * threads, so if the main tab does the coding itself its thread fills with
 * file contents and diffs and it loses the plot on the actual product. Moving
 * implementation into worker tabs means bulk context lands in *their*
 * throwaway threads, and only short reports come back.
 */
function roleInstructions(role: AgentRole): string {
  if (role === "orchestrator") {
    return `
YOUR ROLE: ORCHESTRATOR (main thread).

You are the architect and reviewer, not the typist. Your context must stay small
and focused on the product, so:
- DO NOT write application code yourself. Delegate all implementation to workers
  with \`delegate_tasks\` — each worker runs in its own tab with its own context,
  so the bulk (file contents, diffs, boilerplate) never enters your thread.
- Split work into INDEPENDENT pieces and delegate them in one call so they run in
  parallel. Give each worker a complete, self-contained brief: what to build, which
  files, which conventions, what "done" looks like.
- Workers report back a SHORT summary, not code. That is deliberate — do not ask
  them to paste full files.
- THEN VALIDATE. After workers report, verify the work actually holds together:
  read a key file or two, run the build/tests with \`run_bash\`, check the pieces
  fit. Do not take a worker's word for it.
- If validation finds problems, delegate a CORRECTION round the same way — a
  worker per problem, with the specific fix required. Repeat until it's right.
- Use \`update_plan\` to track phases (plan → implement → validate → fix → done).
- Small lookups (list_files, reading one short file, running a test) you can do
  yourself; anything that would fill your context goes to a worker.`;
  }

  if (role === "worker") {
    return `
YOUR ROLE: WORKER.

You have been given one self-contained piece of a larger job by an orchestrator.
- Do the whole piece yourself with the tools. Be thorough.
- Your final answer must be a SHORT REPORT, not code: which files you created or
  changed, the key decisions you made, anything that didn't work or that the
  orchestrator must know. Never paste full file contents into your final answer —
  the orchestrator's context is deliberately kept small.
- If you cannot complete it, say so plainly and explain what blocked you.`;
  }

  return "";
}

export function buildSystemPrimer(toolList: ToolDefinition[], role: AgentRole = "solo"): string {
  const toolDocs = toolList.map((t) => `- ${t.description}`).join("\n");

  return `You are an autonomous coding agent working in a local project directory.
You do not have direct filesystem, shell, or network access — instead you have these tools,
which a local program will execute on your behalf:

${toolDocs}

RULES FOR USING TOOLS:
- To use a tool, reply with ONLY a single code block (a \`\`\`json fenced block is fine), containing exactly this JSON and nothing else:
\`\`\`json
{"name": "<tool_name>", "args": { ... }}
\`\`\`
- Do not add commentary before or after the code block when calling a tool. Issue exactly one tool call per turn — never more than one code block, and never a tool call mixed with prose.
- After you send a tool call, wait — the next message you receive will be that tool's result, delimited like this:
TOOL_RESULT >>>
<output>
<<< END_TOOL_RESULT
- If a tool's output is too long to paste, it will arrive as an ATTACHED FILE instead, with a short note saying so. Read the attachment as if it were the tool result.
- Use the result to decide your next step: another tool call, or your final answer.
- When you are done and have no more tools to call, reply normally in plain text/markdown with your final answer, with no JSON code block in it — that's what ends the conversation for this task.
- If a tool result is an error, either fix your approach and retry, or explain the problem in your final answer.
${roleInstructions(role)}`;
}

/**
 * The KNOWLEDGE half: project layout, durable memory, and the project's own
 * markdown docs. Returned as a standalone markdown document so it can be
 * uploaded as a file when it's too big to paste (which it usually is).
 * Returns undefined when there's nothing worth sending.
 */
export function buildContextDocument(context: PrimerContext): string | undefined {
  const sections: string[] = [];

  if (context.tree) {
    sections.push(`## Project structure\n\n\`\`\`\n${context.tree}\n\`\`\``);
  }

  if (context.memory) {
    sections.push(
      `## Durable project memory (${MEMORY_FILENAME})\n\n` +
        `Notes carried over from previous sessions. Use the \`remember\` tool to add to this ` +
        `when you learn something worth keeping for next time.\n\n${context.memory}`
    );
  }

  if (context.docs?.length) {
    const docSections = context.docs
      .map((d) => `### ${d.path}\n\n${d.content}`)
      .join("\n\n---\n\n");
    sections.push(
      `## Project documentation\n\n` +
        `The project's own markdown files, as initial knowledge about intent and conventions.\n\n` +
        docSections
    );
  }

  if (context.resumePlan) {
    sections.push(
      `## UNFINISHED WORK FROM A PREVIOUS SESSION

` +
        `The last run was interrupted before it finished. Below is its plan and the progress it had ` +
        `made. Do NOT start over: check what was already done (files may already exist — read them if ` +
        `unsure), then continue from the first incomplete step. Keep using \`update_plan\` as you go.

` +
        context.resumePlan
    );
  }

  if (sections.length === 0) return undefined;
  return `# Project context\n\n${sections.join("\n\n")}\n`;
}

/**
 * Wraps a tool result for sending back to Gemini.
 *
 * Deliberately uses plain-text delimiters rather than a ``` fence: typing a
 * message that STARTS with a fence flips Gemini's composer into code-block
 * mode, where Enter inserts a newline instead of submitting — and the send
 * button can't rescue it either, so the message silently never sends.
 * Verified against the live UI: single-line and multi-line plain text both
 * send fine; text starting with a fence never does.
 */
export function formatToolResult(output: string): string {
  return `TOOL_RESULT >>>\n${output}\n<<< END_TOOL_RESULT`;
}
