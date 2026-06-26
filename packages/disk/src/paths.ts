/**
 * Normalize a filesystem path to its segments, resolving "." and ".." (so a
 * path means the same as in a shell, and ".." can't escape above the root) and
 * optionally stripping a shell-style mount prefix (e.g. "/mnt" or "/mnt/archil")
 * so a path copied from a `run_bash` command resolves the same way.
 *
 *   toSegments("/a/b/../c")            -> ["a", "c"]
 *   toSegments("/mnt/x", "/mnt")        -> ["x"]
 *   toSegments("/../../etc/x")          -> ["etc", "x"]
 */
export function toSegments(path: string, containerRoot?: string): string[] {
  let p = (path ?? "").trim();
  if (containerRoot) {
    const root = containerRoot.replace(/\/+$/, "");
    if (p === root) p = "/";
    else if (p.startsWith(root + "/")) p = p.slice(root.length);
  }
  const resolved: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") resolved.pop();
    else resolved.push(seg);
  }
  return resolved;
}
