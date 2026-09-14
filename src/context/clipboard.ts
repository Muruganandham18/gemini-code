import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";

const run = promisify(execFile);

const TMP_DIR = ".gemini-code-tmp";

/**
 * Pulls an image off the macOS clipboard and writes it to a PNG.
 *
 * A terminal can't receive pasted image *data* — Cmd+V in a terminal only
 * ever delivers text — so "pasting a screenshot" has to mean reading the
 * system clipboard ourselves. AppleScript is the only reliable way to get
 * at the pasteboard's image flavour on macOS.
 *
 * Returns the file path, or undefined when the clipboard holds no image.
 */
export async function readClipboardImage(cwd = process.cwd()): Promise<string | undefined> {
  return (await readClipboardImageDetailed(cwd)).path;
}

/** Same, but says why it failed — so the CLI can give a useful message. */
export async function readClipboardImageDetailed(
  cwd = process.cwd()
): Promise<{ path?: string; reason?: string }> {
  if (process.platform !== "darwin") {
    return { reason: "clipboard images are only supported on macOS" };
  }

  const dir = path.resolve(cwd, TMP_DIR);
  await mkdir(dir, { recursive: true });
  // Short, stable name — the attachment chip ellipsizes long filenames.
  const outPath = path.join(dir, "pasted.png");

  const script = `
    set outFile to POSIX file ${JSON.stringify(outPath)}
    try
      set imgData to (the clipboard as «class PNGf»)
    on error
      return "NO_IMAGE"
    end try
    try
      set fh to open for access outFile with write permission
      set eof fh to 0
      write imgData to fh
      close access fh
    on error errMsg
      try
        close access outFile
      end try
      return "ERROR: " & errMsg
    end try
    return "OK"
  `;

  try {
    const { stdout } = await run("osascript", ["-e", script], { timeout: 15_000 });
    if (stdout.includes("NO_IMAGE")) {
      return { reason: "the clipboard has no image on it (copy a screenshot first)" };
    }
    if (!stdout.includes("OK")) {
      return { reason: `could not read the clipboard: ${stdout.trim() || "unknown error"}` };
    }
    const info = await stat(outPath);
    return info.size > 0 ? { path: outPath } : { reason: "the clipboard image was empty" };
  } catch (err) {
    return { reason: `clipboard read failed: ${(err as Error).message.split("\n")[0]}` };
  }
}

/** True if the path looks like an image we can hand to Gemini. */
export function isImagePath(p: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp|heic)$/i.test(p.trim());
}

/**
 * Terminals quote dragged-in paths and escape spaces; strip that so a
 * drag-and-dropped file just works.
 */
export function normalizeDroppedPath(raw: string): string {
  let p = raw.trim();
  if ((p.startsWith("'") && p.endsWith("'")) || (p.startsWith('"') && p.endsWith('"'))) {
    p = p.slice(1, -1);
  }
  p = p.replace(/\\ /g, " ");
  if (p.startsWith("~/")) p = path.join(process.env.HOME ?? "", p.slice(2));
  return p;
}
