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

function asToolCall(parsed: unknown): ToolCall | undefined {
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    typeof (parsed as Record<string, unknown>).name === "string" &&
    typeof (parsed as Record<string, unknown>).args === "object" &&
    (parsed as Record<string, unknown>).args !== null
  ) {
    const obj = parsed as { name: string; args: Record<string, unknown> };
    return { name: obj.name, args: obj.args };
  }
  return undefined;
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
export function parseGeminiReply(response: GeminiResponse): ParseResult {
  const candidates = [...response.codeBlocks];
  const fencedMatch = response.text.match(FENCED_TOOL_RE);
  if (fencedMatch) candidates.unshift(fencedMatch[1].trim());

  for (const candidate of candidates) {
    try {
      const call = asToolCall(extractJsonObject(candidate));
      if (call) return { kind: "tool_call", call };
    } catch {
      // Not this candidate — try the next one, or fall through below.
    }
  }

  // No valid tool call found, but if something looks like an attempt at one
  // (has the shape of our tool-call JSON without being valid/complete),
  // treat it as malformed so the loop asks Gemini to retry, rather than
  // silently accepting broken JSON as a final answer.
  const attempted = candidates.find((c) => /"name"\s*:/.test(c) && /"args"\s*:/.test(c));
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
  if (response.codeBlocks.length === 0) return false;
  return /\b(i'?ll |i will |let me |i'?m going to |here'?s the (code|file|script)|you can (run|save|copy)|create the file|save (this|it) (to|as)|add the following)/i.test(
    response.text
  );
}
