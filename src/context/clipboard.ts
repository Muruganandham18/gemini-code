import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, stat, writeFile } from "node:fs/promises";
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
  const dir = path.resolve(cwd, TMP_DIR);
  await mkdir(dir, { recursive: true });
  // Short, stable name — the attachment chip ellipsizes long filenames.
  const outPath = path.join(dir, "pasted.png");

  if (process.platform === "win32") return readOnWindows(outPath);
  if (process.platform === "linux") return readOnLinux(outPath);

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

/**
 * Windows: the clipboard's image flavour is reachable through
 * System.Windows.Forms, which PowerShell can load.
 */
async function readOnWindows(outPath: string): Promise<{ path?: string; reason?: string }> {
  const ps = `
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $img = [System.Windows.Forms.Clipboard]::GetImage()
    if ($img -eq $null) { Write-Output "NO_IMAGE" } else {
      $img.Save(${JSON.stringify(outPath)}, [System.Drawing.Imaging.ImageFormat]::Png)
      Write-Output "OK"
    }`;
  try {
    const { stdout } = await run("powershell", ["-NoProfile", "-STA", "-Command", ps], {
      timeout: 20_000,
      windowsHide: true, // otherwise a console window flashes up on every paste
    });
    if (stdout.includes("NO_IMAGE")) {
      return { reason: "the clipboard has no image on it (copy a screenshot first)" };
    }
    if (!stdout.includes("OK")) return { reason: `could not read the clipboard: ${stdout.trim()}` };
    const info = await stat(outPath);
    return info.size > 0 ? { path: outPath } : { reason: "the clipboard image was empty" };
  } catch (err) {
    return { reason: `clipboard read failed: ${(err as Error).message.split("\n")[0]}` };
  }
}

/**
 * Linux: wl-paste on Wayland, xclip on X11. Neither ships by default, so a
 * missing tool is reported as something the user can act on.
 */
async function readOnLinux(outPath: string): Promise<{ path?: string; reason?: string }> {
  const attempts: [string, string[]][] = [
    ["wl-paste", ["--type", "image/png"]],
    ["xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]],
  ];
  for (const [cmd, args] of attempts) {
    try {
      const { stdout } = await run(cmd, args, {
        timeout: 15_000,
        encoding: "buffer",
        maxBuffer: 50 * 1024 * 1024,
      } as never);
      const buf = stdout as unknown as Buffer;
      if (buf?.length) {
        await writeFile(outPath, buf);
        return { path: outPath };
      }
    } catch {
      // Not installed, or no image on the clipboard — try the next one.
    }
  }
  return {
    reason: "no image on the clipboard (Linux needs wl-paste or xclip installed to read one)",
  };
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
