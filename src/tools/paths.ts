import path from "node:path";

/**
 * Resolves a tool's `path` argument and confirms it stays inside the project.
 *
 * The obvious check — `abs.startsWith(process.cwd())` — is a string prefix
 * test with no regard for path boundaries, so a SIBLING directory whose name
 * merely extends the root's slips straight through it: with the project at
 * `/home/me/app`, the path `../app-secrets/creds.txt` resolves to
 * `/home/me/app-secrets/creds.txt`, which starts with `/home/me/app` and was
 * therefore accepted. read_file and list_files have no confirmation gate, so
 * that read happened silently.
 *
 * `path.relative` compares path SEGMENTS, which is what "inside the root"
 * actually means: anything outside comes back as `..` or `../…` (or as an
 * absolute path, on Windows, when the two are on different drives).
 *
 * This resolves `..` lexically and does NOT follow symlinks, so a symlink
 * inside the project that points outside it still leads out. That's the same
 * trust boundary the shell tool already has, and closing it needs realpath on
 * a target that may not exist yet — deliberately out of scope here.
 */
export function resolveInRoot(rel: string): { ok: true; abs: string } | { ok: false; abs?: undefined } {
  const root = path.resolve(process.cwd());
  const abs = path.resolve(root, rel);
  const relToRoot = path.relative(root, abs);

  // "" means abs IS the root, which is inside it. Match the ".." segment
  // exactly rather than as a prefix, so a file honestly named "..rc" stays
  // readable.
  const escapes =
    relToRoot === ".." || relToRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relToRoot);
  if (relToRoot !== "" && escapes) {
    return { ok: false };
  }
  return { ok: true, abs };
}
