import { chmod } from "node:fs/promises";

/**
 * Marks the CLI entrypoint executable so the shebang works when it's invoked
 * directly on Unix.
 *
 * Done in Node rather than with `chmod` because the build runs on Windows too
 * — the installer's build-from-source path calls it — and `chmod` isn't a
 * command there, which failed the whole build.
 */
try {
  await chmod(new URL("../dist/cli.js", import.meta.url), 0o755);
} catch (err) {
  // Windows has no POSIX permission bits; nothing to do and nothing wrong.
  if (process.platform !== "win32") {
    console.error("postbuild: could not set +x on dist/cli.js:", err.message);
  }
}
