/**
 * Command-line flag parsing, kept out of cli.ts so tests can import it.
 * cli.ts runs the agent as a side effect of being imported, so a test that
 * imported a helper from it started a whole session and hung.
 */

/** Reads a `--name value` / `--name=value` flag. */
function flagValue(argv: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const eq = argv.find((a) => a.startsWith(prefix));
  if (eq) return eq.slice(prefix.length).trim() || undefined;
  const i = argv.indexOf(`--${name}`);
  if (i !== -1) return argv[i + 1]?.trim() || undefined;
  return undefined;
}

/**
 * How a Gem is used.
 *
 * "reference" (the default) keeps the coding thread a plain Gemini chat and
 * lets the agent consult the Gem through the ask_gem tool — the Gem is
 * background knowledge, not the thing running the session. "inside" runs the
 * whole conversation in the Gem, which also subjects every turn to the Gem's
 * own instructions.
 */
export type GemMode = "reference" | "inside";

export function gemModeFlag(argv: string[], env = process.env.GEMINI_CODE_GEM_MODE): GemMode {
  const raw = (flagValue(argv, "gem-mode") ?? env ?? "reference").toLowerCase();
  return raw === "inside" ? "inside" : "reference";
}

/** Reads `--gem <name>` / `--gem=<name>`. */
export function gemFlag(argv: string[]): string | undefined {
  return flagValue(argv, "gem");
}
