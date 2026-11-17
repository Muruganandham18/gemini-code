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
    // Two picker variants are live at once. One lists "Flash" / "Pro"; the
    // other (seen on freshly opened tabs) lists "Standard thinking — Quick
    // everyday help" / "High thinking — Complex problem solving" with no
    // model family named at all. Match both, or tabs on the newer menu
    // silently stay on whatever model they started with.
    // A third variant has no Flash at all, only "Auto", so that's what the
    // default means there.
    matches: (t) => (/flash/i.test(t) && !/lite/i.test(t)) || /standard thinking|everyday help/i.test(t) || /^auto\b/i.test(t),
  },
  {
    name: "Pro",
    aliases: ["pro"],
    hint: "advanced reasoning, slower",
    matches: (t) => /\bpro\b/i.test(t) || /high thinking|complex problem/i.test(t),
  },
];

/** The separate on/off toggle that stacks on the base model. */
export const EXTENDED_THINKING = {
  name: "Extended thinking",
  // Not bare "thinking": the newer picker names whole models "Standard
  // thinking" and "High thinking", and matching those would click a model
  // while trying to flip this toggle.
  matches: (t: string) => /extended/i.test(t) || (/thinking/i.test(t) && !/standard|high/i.test(t)),
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

/** One row of the open picker, as read off the page. */
export interface MenuRow {
  text: string;
  testId: string;
  selected: boolean;
  /** Shows a padlock. */
  locked?: boolean;
}

export interface MenuEntry {
  /** First line of the row, e.g. "3.1 Pro". */
  name: string;
  /** Second line, e.g. "Advanced reasoning". */
  description: string;
  selected: boolean;
}

export interface LiveModel extends MenuEntry {
  /**
   * Above the account's plan. Selecting it opens an upgrade dialog rather than
   * switching, so nothing should click it. Google has marked these with
   * "upsell" in the row's id, and later with only a padlock icon.
   */
  locked: boolean;
}

/** What the account can pick right now: the source of truth, unlike MODELS. */
export interface ModelMenu {
  models: LiveModel[];
  thinking: MenuEntry[];
  /** The picker's own label, e.g. "Gemini Auto". */
  current: string;
}

function menuEntry(row: MenuRow): MenuEntry {
  const [name, ...rest] = row.text.split("\n").map((line) => line.trim()).filter(Boolean);
  return { name, description: rest.join(" "), selected: row.selected };
}

/** The models in a picker's rows, leaving out blanks and the thinking control. */
export function parseModelRows(rows: MenuRow[]): LiveModel[] {
  return rows
    .filter((row) => row.text && !EXTENDED_THINKING.matches(row.text))
    .map((row) => ({ ...menuEntry(row), locked: Boolean(row.locked) || /upsell/i.test(row.testId) }));
}

export function parseThinkingRows(rows: MenuRow[]): MenuEntry[] {
  return rows.filter((row) => row.text).map(menuEntry);
}

/**
 * Does a picker row answer to this name: either of its lines, or a friendly
 * alias? Either line, because rows have been "3.1 Pro / Advanced reasoning" and
 * then "Code & analysis / 4 Argon", with the model's name on whichever.
 */
export function menuRowMatches(wanted: string, rowText: string): boolean {
  const needle = wanted.trim().toLowerCase();
  const lines = rowText.split("\n").map((line) => line.trim().toLowerCase());
  return lines.includes(needle) || (resolveModel(wanted)?.matches(rowText) ?? false);
}
