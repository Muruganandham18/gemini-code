/**
 * Finding the text an edit means, when the model's copy of it is close but
 * not identical.
 *
 * edit_file used to demand a character-for-character match. In practice that
 * fails constantly for reasons that have nothing to do with intent:
 *
 *  - Line endings. A Windows checkout is CRLF; a model reproduces it as LF.
 *    Exact matching then fails on EVERY edit, forever — the real failure
 *    behind a run that burned all 25 turns retrying the same edit.
 *  - Trailing whitespace, which models drop and editors strip.
 *  - Indentation, which shifts when text is quoted through a chat UI.
 *
 * So: try progressively more forgiving comparisons, and stop at the first one
 * that finds something. Each tier keeps the safety property that matters — an
 * ambiguous match is refused rather than guessed at — and the tiers only ever
 * relax WHITESPACE. Any difference in the actual characters still fails.
 */

export type MatchHow = "exact" | "line endings" | "trailing whitespace" | "indentation";

export interface Span {
  start: number;
  end: number;
  /** Indentation of the matched block's first line, for re-indenting the replacement. */
  indent: string;
}

export interface MatchOutcome {
  how: MatchHow;
  spans: Span[];
}

/** The file's dominant line ending, so an edit doesn't rewrite the whole file's style. */
export function detectEol(content: string): "\r\n" | "\n" {
  const crlf = (content.match(/\r\n/g) ?? []).length;
  const lf = (content.match(/\n/g) ?? []).length - crlf;
  return crlf > lf ? "\r\n" : "\n";
}

export function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

interface Line {
  text: string;
  start: number;
  end: number;
}

function splitLines(content: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (let i = 0; i <= content.length; i++) {
    if (i === content.length || content[i] === "\n") {
      lines.push({ text: content.slice(start, i), start, end: i });
      start = i + 1;
    }
  }
  return lines;
}

function leadingWhitespace(text: string): string {
  return text.slice(0, text.length - text.trimStart().length);
}

/**
 * Matches the needle against whole lines, comparing each line through `shape`
 * (trimEnd for trailing whitespace, trim for indentation).
 */
function findLineMatches(content: string, needle: string, shape: (s: string) => string): Span[] {
  const lines = splitLines(content);
  const needleLines = needle.split("\n").map(shape);
  if (needleLines.length === 0) return [];

  const spans: Span[] = [];
  for (let i = 0; i + needleLines.length <= lines.length; i++) {
    let hit = true;
    for (let j = 0; j < needleLines.length; j++) {
      if (shape(lines[i + j].text) !== needleLines[j]) {
        hit = false;
        break;
      }
    }
    if (hit) {
      spans.push({
        start: lines[i].start,
        end: lines[i + needleLines.length - 1].end,
        indent: leadingWhitespace(lines[i].text),
      });
      i += needleLines.length - 1;
    }
  }
  return spans;
}

function findExact(content: string, needle: string): Span[] {
  const spans: Span[] = [];
  let from = 0;
  for (;;) {
    const at = content.indexOf(needle, from);
    if (at === -1) return spans;
    const lineStart = content.lastIndexOf("\n", at - 1) + 1;
    spans.push({ start: at, end: at + needle.length, indent: leadingWhitespace(content.slice(lineStart, at)) });
    from = at + needle.length;
  }
}

/**
 * Locates `needle` in `content` (both with \n line endings already).
 *
 * Returns the most exact tier that matched, so the caller can say how it was
 * found — a silent fuzzy match would be worse than the original error.
 */
export function findSpans(content: string, needle: string): MatchOutcome | undefined {
  const exact = findExact(content, needle);
  if (exact.length) return { how: "exact", spans: exact };

  // Only whole-line tiers from here: a partial-line snippet that didn't match
  // exactly is not something to guess at.
  const trailing = findLineMatches(content, needle, (s) => s.trimEnd());
  if (trailing.length) return { how: "trailing whitespace", spans: trailing };

  const indented = findLineMatches(content, needle, (s) => s.trim());
  if (indented.length) return { how: "indentation", spans: indented };

  return undefined;
}

/**
 * Re-indents a replacement to sit where the matched text sat.
 *
 * When the match only differed by indentation, the model's new_text carries
 * the model's indentation too. Shifting it by the same amount keeps the file
 * consistent instead of pasting a differently-indented block into it.
 */
export function reindent(newText: string, toIndent: string): string {
  const lines = newText.split("\n");
  const firstContent = lines.find((l) => l.trim() !== "");
  if (firstContent === undefined) return newText;

  // The replacement's own base indent is whatever its first real line has;
  // every line keeps its indentation RELATIVE to that, so nested blocks stay
  // nested. Then the whole thing sits at the indentation the file used.
  const base = leadingWhitespace(firstContent);
  if (base === toIndent) return newText;
  return lines
    .map((line) => {
      if (line.trim() === "") return line;
      const stripped = line.startsWith(base) ? line.slice(base.length) : line.trimStart();
      return toIndent + stripped;
    })
    .join("\n");
}

/**
 * The part of the file that looks most like what the model was aiming at.
 *
 * "That text isn't in the file" leaves nothing to act on, and the model's next
 * guess is usually just as wrong. Showing the nearest real lines, numbered,
 * turns a dead end into a correctable mistake.
 */
export function nearestContext(content: string, needle: string, radius = 3): string | undefined {
  const anchor = needle
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 8);
  if (!anchor) return undefined;

  const lines = splitLines(content).map((l) => l.text);
  let bestLine = -1;
  let bestScore = 0;
  for (let i = 0; i < lines.length; i++) {
    const score = similarity(lines[i].trim(), anchor);
    if (score > bestScore) {
      bestScore = score;
      bestLine = i;
    }
  }
  // Below this the "closest" line is noise and would only mislead.
  if (bestLine === -1 || bestScore < 0.5) return undefined;

  const from = Math.max(0, bestLine - radius);
  const to = Math.min(lines.length - 1, bestLine + radius);
  const numbered = [];
  for (let i = from; i <= to; i++) {
    numbered.push(`${String(i + 1).padStart(5)}${i === bestLine ? " >" : "  "} ${lines[i]}`);
  }
  return numbered.join("\n");
}

/** Cheap token-overlap similarity — enough to pick the nearest line. */
function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const tokens = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9_$]+/g) ?? []);
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / Math.max(ta.size, tb.size);
}
