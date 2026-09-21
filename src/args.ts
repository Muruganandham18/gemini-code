/**
 * Command-line flag parsing, kept out of cli.ts so tests can import it.
 * cli.ts runs the agent as a side effect of being imported, so a test that
 * imported a helper from it started a whole session and hung.
 */

/** Reads `--gem <name>` / `--gem=<name>`. */
export function gemFlag(argv: string[]): string | undefined {
  const eq = argv.find((a) => a.startsWith("--gem="));
  if (eq) return eq.slice("--gem=".length).trim() || undefined;
  const i = argv.indexOf("--gem");
  if (i !== -1) return argv[i + 1]?.trim() || undefined;
  return undefined;
}
