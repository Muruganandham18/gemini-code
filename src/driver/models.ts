export interface ModelChoice {
  /** Canonical name shown in the CLI. */
  name: string;
  /** What the user can type after `/model`. */
  aliases: string[];
  /** One-liner for `/help`. */
  hint: string;
  /**
   * Matches the picker's menu-item text in the live UI. Deliberately keyed
   * on keywords rather than exact labels: the menu carries version numbers
   * ("3.5 Flash-Lite", "3.6 Flash", "3.1 Pro") that Google bumps regularly,
   * and an exact-match table would silently break on every release.
   */
  matches: (menuItemText: string) => boolean;
}

/**
 * Base models — mutually exclusive. Order matters: Flash-Lite must be
 * tested before the looser Flash rule.
 *
 * "Extended thinking" is deliberately NOT here: it's a separate toggle that
 * layers on top of whichever base model is selected (the picker reports
 * e.g. "Flash Extended"), so it gets its own control. Verified live.
 */
export const MODELS: ModelChoice[] = [
  {
    name: "Flash-Lite",
    aliases: ["fastest", "flash-lite", "lite"],
    hint: "fastest, lightest",
    matches: (t) => /flash[\s-]?lite/i.test(t),
  },
  {
    name: "Flash",
    aliases: ["fast", "flash"],
    hint: "all-around help (default)",
    matches: (t) => /flash/i.test(t) && !/lite/i.test(t),
  },
  {
    name: "Pro",
    aliases: ["pro"],
    hint: "advanced reasoning, slower",
    matches: (t) => /\bpro\b/i.test(t),
  },
];

/** The separate on/off toggle that stacks on the base model. */
export const EXTENDED_THINKING = {
  name: "Extended thinking",
  matches: (t: string) => /extended|thinking/i.test(t),
  /** The picker's label appends this word while the toggle is on. */
  labelMarker: /extended/i,
};

/** What a fresh session starts on. Override with GEMINI_CODE_MODEL. */
export const DEFAULT_MODEL_ALIAS = "fast";
/** Fast means fast: extended thinking defaults off. */
export const DEFAULT_EXTENDED_THINKING = false;

export function resolveModel(alias: string): ModelChoice | undefined {
  const needle = alias.trim().toLowerCase();
  return MODELS.find((m) => m.aliases.includes(needle) || m.name.toLowerCase() === needle);
}

export function modelHelp(): string {
  return MODELS.map((m) => `  ${m.aliases[0].padEnd(10)} ${m.name} — ${m.hint}`).join("\n");
}
