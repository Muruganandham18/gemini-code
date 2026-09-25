/**
 * Keeps one gemini-code process from being killed by another's actions.
 *
 * Every process attached to the shared Chrome over CDP is told about every
 * dialog on every tab. When a dialog appears, each of them tries to handle
 * it; the first one wins and the rest get "No dialog is showing" back from
 * Chrome. Playwright surfaces that as an unhandled rejection, which by
 * default terminates Node — so the agent closing one of its own tabs could
 * take down an API server running alongside it, and vice versa.
 *
 * That specific error is harmless (someone else already handled the dialog),
 * so it's ignored. Everything else still crashes the process as before.
 */
export function isDialogRace(reason: unknown): boolean {
  const message = reason instanceof Error ? reason.message : String(reason);
  return /handleJavaScriptDialog/.test(message) && /No dialog is showing/i.test(message);
}

let installed = false;

export function installDialogRaceGuard(): void {
  if (installed) return;
  installed = true;
  process.on("unhandledRejection", (reason) => {
    if (isDialogRace(reason)) return;
    // Preserve Node's default: an unhandled rejection is fatal.
    throw reason;
  });
}
