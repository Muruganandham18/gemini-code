import type { ToolCall } from "../types.js";
import type { GeminiResponse } from "../driver/IGeminiDriver.js";

// Kept as a fallback in case a tool call ever survives as literal fenced
// text (e.g. a very short reply the UI doesn't wrap in a code-block
// component) — but the primary signal is response.codeBlocks, see below.
const FENCED_TOOL_RE = /```tool\s*\n([\s\S]*?)\n?```/;

export type ParseResult =
  | { kind: "tool_call"; call: ToolCall }
  | { kind: "final"; text: string }
  | { kind: "malformed"; raw: string; error: string };

/**
 * Every balanced {...} substring in a blob of text, parsed where possible.
 *
 * Quote-aware: a brace inside a JSON string ("{"command": "echo {}"}") must
 * not end the object. Used for the last-resort scan of prose, where Gemini
 * has written the call as a sentence instead of a code block.
 */
function extractJsonObjects(raw: string): unknown[] {
  const found: unknown[] = [];
  for (let start = 0; start < raw.length; start++) {
    if (raw[start] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < raw.length; i++) {
      const ch = raw[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\" && inString) {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = !inString;
      else if (!inString && ch === "{") depth++;
      else if (!inString && ch === "}") {
        depth--;
        if (depth === 0) {
          try {
            found.push(JSON.parse(raw.slice(start, i + 1)));
          } catch {
            // Not JSON after all — keep scanning from the next brace.
          }
          start = i;
          break;
        }
      }
    }
  }
  return found;
}

/** Finds the first balanced {...} substring and parses it, ignoring any surrounding text. */
function extractJsonObject(raw: string): unknown {
  const start = raw.indexOf("{");
  if (start === -1) throw new Error("no '{' found");
  let depth = 0;
  for (let i = start; i < raw.length; i++) {
    if (raw[i] === "{") depth++;
    else if (raw[i] === "}") {
      depth--;
      if (depth === 0) return JSON.parse(raw.slice(start, i + 1));
    }
  }
  throw new Error("unbalanced braces");
}

const ARG_KEYS = ["args", "arguments", "parameters", "params", "input"] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The canonical shape is {name, args}. Gemini also drifts into two others:
 * `arguments`/`parameters` instead of `args`, and args flattened next to
 * `name` ({"name": "search_code", "pattern": "x"}). A real run lost a whole
 * worker to the flat form — it was read as prose, so the worker's "final
 * answer" was a tool call it never got to make.
 *
 * The drifted shapes are only accepted for a name that IS a tool, because
 * {"name": ...} is also what package.json and plenty of other JSON look like.
 */
function asToolCall(parsed: unknown, knownTools?: ReadonlySet<string>): ToolCall | undefined {
  if (!isPlainObject(parsed) || typeof parsed.name !== "string") return undefined;
  const name = parsed.name;
  if (isPlainObject(parsed.args)) return { name, args: parsed.args };
  if (!knownTools?.has(name)) return undefined;

  for (const key of ARG_KEYS) {
    if (isPlainObject(parsed[key])) return { name, args: parsed[key] as Record<string, unknown> };
  }
  const { name: _name, ...rest } = parsed;
  return { name, args: rest };
}

/**
 * Looks for a tool call in a Gemini reply.
 *
 * Gemini's web UI renders markdown into HTML before we ever read it, so the
 * ```tool fence we ask for in the prompt does NOT survive as literal
 * backtick text — only the *content* of the resulting rendered code block
 * does (see GeminiResponse's doc comment). So the real signal is "is there
 * a code block whose content is JSON shaped like {name, args}", not the
 * fence markers themselves. `response.codeBlocks` carries exactly that.
 */
export function parseGeminiReply(response: GeminiResponse, knownTools?: ReadonlySet<string>): ParseResult {
  const candidates = [...response.codeBlocks];
  const fencedMatch = response.text.match(FENCED_TOOL_RE);
  if (fencedMatch) candidates.unshift(fencedMatch[1].trim());

  for (const candidate of candidates) {
    try {
      const call = asToolCall(extractJsonObject(candidate), knownTools);
      if (call) return { kind: "tool_call", call };
    } catch {
      // Not this candidate — try the next one, or fall through below.
    }
  }

  // Last resort: the call written as prose rather than as a code block
  // ("I'll call {"name": "read_file", "args": {"path": "x"}} now"). The UI
  // renders that as ordinary text, so codeBlocks is empty and the loop used
  // to accept the whole thing as a finished answer and stop. Only accepted
  // for a name that IS a tool, so prose that merely contains JSON stays prose.
  if (knownTools?.size) {
    for (const candidate of extractJsonObjects(response.text)) {
      const call = asToolCall(candidate, knownTools);
      if (call && knownTools.has(call.name)) return { kind: "tool_call", call };
    }
  }

  // No valid tool call found, but if something looks like an attempt at one
  // (has the shape of our tool-call JSON without being valid/complete),
  // treat it as malformed so the loop asks Gemini to retry, rather than
  // silently accepting broken JSON as a final answer.
  const namesKnownTool = (c: string) =>
    [...(knownTools ?? [])].some((t) => new RegExp(`"name"\\s*:\\s*"${t}"`).test(c));
  const attempted = candidates.find((c) => (/"name"\s*:/.test(c) && /"args"\s*:/.test(c)) || namesKnownTool(c));
  if (attempted) {
    return {
      kind: "malformed",
      raw: attempted,
      error: 'Found something shaped like a tool call, but it was not valid {"name": ..., "args": ...} JSON.',
    };
  }

  return { kind: "final", text: response.text.trim() };
}

/**
 * Detects a reply that MEANT to do work but didn't issue a tool call.
 *
 * In long threads Gemini drifts off the protocol — the primer is far back
 * in a context the web UI silently truncates — and starts answering like a
 * chatbot: "Sure, I'll create that file:" followed by the file contents in
 * a code block. The parser can't tell that from a genuine final answer, so
 * the loop ends and nothing happens, which looks exactly like the app
 * ignoring the reply.
 *
 * The tell is not the code block on its own (a real answer may quote code)
 * but code plus language announcing an action the agent was supposed to
 * perform with a tool.
 */
export function looksLikeAbandonedWork(response: GeminiResponse): boolean {
  const text = response.text;
  if (response.codeBlocks.length > 0) {
    return /\b(i'?ll |i will |let me |i'?m going to |here'?s the (code|file|script)|you can (run|save|copy)|create the file|save (this|it) (to|as)|add the following)/i.test(
      text
    );
  }

  // Prose with no code at all can abandon the work just as completely, in two
  // ways seen in real threads: asking permission to start ("Would you like me
  // to proceed?") and narrating an action as if it had happened ("I'll now
  // update the file"). Both end the task having changed nothing. Asking is
  // pointless here — approval is the user's y/N gate, not Gemini's to seek.
  return /\b(would you like me to|shall i|do you want me to|let me know (if|when|whether)|if you'?d like,? i can|i can (do|make|create|write|implement) (that|this|it)|say the word)\b/i.test(
    text
  ) || /\b(i'?ll |i will |let me |i'?m going to )(now )?(create|write|update|edit|modify|add|run|execute|fix|implement|start|begin)\b/i.test(
    text
  );
}

/**
 * Detects a PROGRESS REPORT masquerading as a final answer.
 *
 * Seen in a real migration: after a tool result, Gemini replied
 * "The migration of ClientApp to Vue 3 is underway. 1. Package
 * Architecture — Dependencies Updated…" with no code block and no tool
 * call. Nothing in the reply is wrong; it simply isn't finished. The
 * parser had no way to tell that from a completed answer, so the loop
 * ended mid-migration.
 *
 * Keyed on language that describes work still in flight. Deliberately does
 * NOT fire on completion words ("completed", "done", "finished"), so a
 * genuine summary of what was accomplished still ends the task.
 */
export function looksUnfinished(response: GeminiResponse): boolean {
  const text = response.text;
  if (!text.trim()) return false;

  // An explicit statement of completion wins — it's the model's clearest
  // signal that it considers the work done.
  if (/\b(is|are|has been|have been) (now )?(complete|completed|finished|done)\b|\ball (steps|tasks|files) (are )?(complete|done)\b|\bsuccessfully (completed|finished|implemented)\b/i.test(text)) {
    return false;
  }

  return /\b(is|are) (currently )?(underway|in progress|ongoing)\b|\bnext steps?\b|\bi('| a)?m going to (now )?\b|\bi will (now |next )?(continue|proceed|start|begin|update|create|modify)\b|\b(remaining|still (need|to do|pending))\b|\blet me (now )?(continue|proceed)\b|\bso far[,:]/i.test(
    text
  );
}
