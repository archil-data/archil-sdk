import type {
  Disk,
  ExecResult,
  GrepGroup,
  GrepMatch,
  GrepOptions,
  GrepResult,
  ListObjectsOptions,
  ListObjectsResult,
  PutObjectOptions,
  PutObjectResult,
  S3Object,
} from "./disk.js";
import type { ExecMount, ExecMountSpec, ExecOptions } from "./archil.js";
import type { FileSystem } from "./filesystem.js";
import { toSegments } from "./paths.js";

/** Anything that can run a multi-disk exec — i.e. an `Archil` client. A narrow
 * structural type so this module doesn't import the Archil class (avoiding a
 * value-import cycle with archil.ts). */
export interface WorkspaceExecCapable {
  exec(opts: ExecOptions): Promise<ExecResult>;
}

function isExecMountSpec(m: ExecMount): m is ExecMountSpec {
  return typeof m === "object" && m !== null && "disk" in m;
}

/** Keep groups up to the one holding the `maxResults`-th match, and end that
 * group after up to `after` more lines, which become context so the groups
 * hold exactly the kept matches. With multiline, a run of matching lines is
 * one match. Mirrors the controlplane's truncation of a single disk's groups. */
function truncateGroups(groups: GrepGroup[], maxResults: number, after: number, multiline: boolean): GrepGroup[] {
  let seen = 0;
  for (let i = 0; i < groups.length; i++) {
    const lines = groups[i].lines;
    for (let j = 0; j < lines.length; j++) {
      if (lines[j].match && !(multiline && j > 0 && lines[j - 1].match)) seen++;
      if (seen === maxResults && !(multiline && j + 1 < lines.length && lines[j + 1].match)) {
        const kept = lines.slice(0, Math.min(j + 1 + after, lines.length)).map((l, k) => (k > j ? { ...l, match: false } : l));
        return [...groups.slice(0, i), { ...groups[i], lines: kept }];
      }
    }
  }
  return groups;
}

/** Rebase grep globs written against the workspace root onto one mount. At the
 * root a path is `<mount>/<path>`, but the mount's disk matches globs against
 * `<path>` alone. Returns the globs that make the disk search exactly the files
 * `globs` select under `<mount>/`, or null when they select none there: the
 * last glob matching the mount's directory excludes it, or no include can match
 * under it. Mirrors the controlplane's ripgrep rules: `!` excludes, a trailing
 * `/` matches only directories, a leading `/` anchors, a glob without a `/`
 * matches a name at any depth, `*` and `?` stay within a path component while a
 * whole `**` component spans any number of them, and the last match wins. */
function globsForMount(globs: string[], mount: string): string[] | null {
  const out: string[] = [];
  let hasInclude = false;
  let includesUnder = false;
  let mountExcluded = false;
  for (const glob of globs) {
    const exclude = glob.startsWith("!");
    let body = exclude ? glob.slice(1) : glob;
    const dirOnly = body.endsWith("/");
    if (dirOnly) body = body.slice(0, -1);
    const anchored = body.startsWith("/");
    if (anchored) body = body.slice(1);
    hasInclude ||= !exclude;
    let rebased: string[] | undefined;
    if (body !== "") {
      if (!anchored && !body.includes("/")) body = `**/${body}`;
      rebased = globUnderMount(body, mount);
    }
    if (rebased === undefined) {
      // Send a glob this can't take apart as written, so the control plane
      // still matches or rejects it.
      out.push(glob);
      includesUnder ||= !exclude;
      continue;
    }
    if (globNamesMount(body, mount)) mountExcluded = exclude;
    for (const rest of rebased) out.push(diskGlob(exclude, rest, dirOnly));
    includesUnder ||= !exclude && !dirOnly && rebased.length > 0;
  }
  return mountExcluded || (hasInclude && !includesUnder) ? null : out;
}

/** The glob bodies that match `<path>` exactly when `body` matches
 * `<mount>/<path>`, or undefined when `body` can't be split into components. */
function globUnderMount(body: string, mount: string): string[] | undefined {
  if (body === "**") return ["**"];
  const split = splitFirstComponent(body);
  if (split === undefined) return undefined;
  const [first, rest] = split;
  if (rest === undefined) return [];
  if (rest === "") return undefined;
  if (first === "**") {
    const deeper = globUnderMount(rest, mount);
    return deeper && [body, ...deeper];
  }
  const component = componentRegExp(first);
  if (component === undefined) return undefined;
  return component.test(mount) ? [rest] : [];
}

/** Whether glob `body` matches the mount's own directory, `<mount>`. */
function globNamesMount(body: string, mount: string): boolean {
  if (body === "**") return true;
  const split = splitFirstComponent(body);
  if (split === undefined) return false;
  const [first, rest] = split;
  if (rest === undefined) return componentRegExp(first)?.test(mount) ?? false;
  return first === "**" && globNamesMount(rest, mount);
}

/** Write a rebased glob body as the glob the control plane reads back as it. */
function diskGlob(exclude: boolean, body: string, dirOnly: boolean): string {
  // The control plane reads a glob without a `/` as `**/` and the glob, and
  // any other glob as matching the whole path, so only a body without a `/`
  // needs anchoring. A basename glob comes back as the caller wrote it.
  let glob = body;
  if (body.startsWith("**/") && !body.slice(3).includes("/")) glob = body.slice(3);
  else if (!body.includes("/")) glob = `/${body}`;
  return `${exclude ? "!" : ""}${glob}${dirOnly ? "/" : ""}`;
}

/** Split off a glob's first path component, with `rest` undefined when there
 * is no `/`. Undefined when a `/` falls inside braces or a character class, or
 * either is unclosed. */
function splitFirstComponent(body: string): [string, string | undefined] | undefined {
  let inBraces = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "\\") {
      // An escaped `/` still matches the separator.
      if (body[i + 1] === "/") return inBraces ? undefined : [body.slice(0, i), body.slice(i + 2)];
      i++;
    } else if (c === "[") {
      const end = globClassEnd(body, i);
      if (end < 0 || body.slice(i, end).includes("/")) return undefined;
      i = end;
    } else if (c === "{") {
      inBraces = true;
    } else if (c === "}") {
      inBraces = false;
    } else if (c === "/") {
      return inBraces ? undefined : [body.slice(0, i), body.slice(i + 1)];
    }
  }
  return inBraces ? undefined : [body, undefined];
}

/** Index of the `]` closing the glob class at `start`, or -1. A `]` first in the class is literal. */
function globClassEnd(glob: string, start: number): number {
  let i = start + 1;
  if (glob[i] === "!" || glob[i] === "^") i++;
  for (let first = true; i < glob.length; i++, first = false) {
    if (glob[i] === "]" && !first) return i;
  }
  return -1;
}

/** One path component's glob as an anchored regexp, or undefined if malformed. */
function componentRegExp(glob: string): RegExp | undefined {
  let source = "";
  let inBraces = false;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      // Within a component, `**` is no different from `*`.
      if (glob[i + 1] === "*") i++;
      source += "[^/]*";
    } else if (c === "?") {
      source += "[^/]";
    } else if (c === "[") {
      const end = globClassEnd(glob, i);
      if (end < 0) return undefined;
      let members = glob.slice(i + 1, end);
      const negated = members[0] === "!" || members[0] === "^";
      if (negated) members = members.slice(1);
      source += `[${negated ? "^" : ""}${members.replace(/[\\\]\[^]/g, "\\$&")}]`;
      i = end;
    } else if (c === "{") {
      if (inBraces) return undefined;
      inBraces = true;
      source += "(?:";
    } else if (c === "}" && inBraces) {
      inBraces = false;
      source += ")";
    } else if (c === "," && inBraces) {
      source += "|";
    } else if (c === "\\") {
      if (i + 1 === glob.length) return undefined;
      source += escapeRegExp(glob[++i]);
    } else {
      source += escapeRegExp(c);
    }
  }
  return inBraces ? undefined : new RegExp(`^${source}$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

interface MountEntry {
  disk: Disk;
  readOnly: boolean;
  subdirectory?: string;
  conditional: boolean;
  queueMs?: number;
  checkoutPaths?: string[];
}

/**
 * A key-routed filesystem spanning several Archil disks. Each disk is mounted
 * under a name and addressed as the first segment of a key (`<name>/...`);
 * `getObject`, `putObject`, `deleteObject`, `listObjects`, and `grep` route to
 * the right disk by that segment (and `listObjects` / `grep` fan out across all
 * of them when the key/prefix doesn't name one). Implements the same
 * {@link FileSystem} surface as a single {@link Disk}, so it works anywhere a
 * disk does. Mounts can be changed at runtime with {@link addDisk} /
 * {@link removeDisk}.
 */
export class Workspace implements FileSystem {
  private readonly mounts = new Map<string, MountEntry>();

  /** @internal Use `archil.workspace({ ... })`. */
  constructor(
    private readonly client: WorkspaceExecCapable,
    mounts: Record<string, ExecMount>,
  ) {
    for (const [name, value] of Object.entries(mounts)) this.addDisk(name, value);
    if (this.mounts.size === 0) throw new Error("workspace() needs at least one disk");
  }

  // --- mount management --------------------------------------------------

  /** Mount (or replace) a disk at `name`; its objects are addressed as
   * `<name>/...`. Accepts a `Disk` or a mount spec (read-only / subdirectory /
   * conditional / delegation checkouts); a bare disk-id string is rejected —
   * fetch the disk first. */
  addDisk(name: string, disk: ExecMount): this {
    const rel = name.replace(/^\/+|\/+$/g, "");
    if (!rel) throw new Error("workspace mount name must be non-empty");
    // Routing is by the first key segment, so a mount name can't contain "/".
    if (rel.includes("/")) {
      throw new Error(`workspace mount name '${name}' must not contain '/'`);
    }
    // "." and ".." are path navigation to the router, not addressable labels.
    if (rel === "." || rel === "..") {
      throw new Error(`workspace mount name '${name}' is reserved ('.' and '..' are path navigation, not disk names)`);
    }
    let d: Disk | string;
    let readOnly = false;
    let subdirectory: string | undefined;
    let conditional = false;
    let queueMs: number | undefined;
    let checkoutPaths: string[] | undefined;
    if (isExecMountSpec(disk)) {
      d = disk.disk;
      readOnly = disk.readOnly ?? false;
      subdirectory = disk.subdirectory;
      conditional = disk.conditional ?? false;
      queueMs = disk.queueMs;
      checkoutPaths = disk.checkoutPaths;
    } else {
      d = disk;
    }
    if (typeof d === "string") {
      throw new Error(
        "workspace needs Disk objects, not disk-id strings; fetch with archil.getDisk(id) first",
      );
    }
    this.mounts.set(rel, {
      disk: d,
      readOnly,
      subdirectory,
      conditional,
      queueMs,
      checkoutPaths,
    });
    return this;
  }

  /** Unmount the disk at `name`. Returns whether a disk was removed. Refuses to
   * remove the last disk — a workspace must always have at least one (the same
   * invariant the constructor enforces), else fan-out/exec would have nothing to
   * route to. */
  removeDisk(name: string): boolean {
    const rel = name.replace(/^\/+|\/+$/g, "");
    if (this.mounts.has(rel) && this.mounts.size === 1) {
      throw new Error("cannot remove the last disk from a workspace; a workspace must keep at least one");
    }
    return this.mounts.delete(rel);
  }

  /** The names of the currently-mounted disks. */
  diskNames(): string[] {
    return [...this.mounts.keys()];
  }

  // --- routing -----------------------------------------------------------

  private unknownDisk(name: string): Error {
    return new Error(
      `No disk named '${name}'. Address objects by disk: ${this.diskNames().map((n) => `${n}/…`).join(", ")}`,
    );
  }

  /** Resolve a workspace key (`<name>/...`) to the disk and the disk-relative key. */
  private route(key: string): { entry: MountEntry; diskKey: string } {
    const segs = toSegments(key);
    if (segs.length === 0) {
      throw new Error("that key is the workspace root, not an object; name a disk, e.g. data/file.txt");
    }
    const entry = this.mounts.get(segs[0]);
    if (!entry) throw this.unknownDisk(segs[0]);
    return { entry, diskKey: this.diskKey(entry, segs.slice(1).join("/")) };
  }

  /** Mounts touched by a key prefix; an empty prefix fans out to all of them. */
  private covered(prefix: string): Array<{ name: string; entry: MountEntry; rel: string }> {
    const segs = toSegments(prefix);
    if (segs.length === 0) {
      return [...this.mounts.entries()].map(([name, entry]) => ({ name, entry, rel: this.diskKey(entry, "") }));
    }
    const entry = this.mounts.get(segs[0]);
    if (!entry) throw this.unknownDisk(segs[0]);
    return [{ name: segs[0], entry, rel: this.diskKey(entry, segs.slice(1).join("/")) }];
  }

  /** Map a workspace-relative key to the disk's key, applying the mount's subdirectory. */
  private diskKey(entry: MountEntry, rel: string): string {
    const trimmed = rel.replace(/^\/+/, "");
    const sub = (entry.subdirectory ?? "").replace(/^\/+|\/+$/g, "");
    if (!sub) return trimmed;
    return trimmed ? `${sub}/${trimmed}` : sub;
  }

  /** Map a disk key back to its workspace key (`<name>/...`), stripping the mount subdirectory. */
  private abs(name: string, entry: MountEntry, diskKey: string): string {
    const sub = (entry.subdirectory ?? "").replace(/^\/+|\/+$/g, "");
    let rel = diskKey;
    if (sub && diskKey.startsWith(sub + "/")) rel = diskKey.slice(sub.length + 1);
    else if (sub && diskKey === sub) rel = "";
    rel = rel.replace(/^\/+|\/+$/g, "");
    return rel ? `${name}/${rel}` : name;
  }

  // --- FileSystem --------------------------------------------------------

  async getObject(key: string): Promise<Uint8Array> {
    const { entry, diskKey } = this.route(key);
    return entry.disk.getObject(diskKey);
  }

  async putObject(
    key: string,
    body: string | Uint8Array | ArrayBuffer,
    options?: string | PutObjectOptions,
  ): Promise<PutObjectResult> {
    const { entry, diskKey } = this.route(key);
    if (entry.readOnly) throw new Error(`${key} is on a read-only disk and cannot be written.`);
    return entry.disk.putObject(diskKey, body, options);
  }

  async deleteObject(key: string): Promise<void> {
    const { entry, diskKey } = this.route(key);
    if (entry.readOnly) throw new Error(`${key} is on a read-only disk and cannot be deleted.`);
    await entry.disk.deleteObject(diskKey);
  }

  async listObjects(prefix?: string, opts: ListObjectsOptions = {}): Promise<ListObjectsResult> {
    // At the workspace root, the disks themselves are the top-level directories.
    // A non-recursive listing returns just those (like a delimited S3 listing),
    // rather than fanning out into each disk's contents — that only happens when
    // recursive is set or a prefix names a disk.
    if (toSegments(prefix ?? "").length === 0 && !opts.recursive) {
      return {
        objects: [],
        commonPrefixes: this.diskNames().map((n) => `${n}/`).sort(),
        isTruncated: false,
        keyCount: 0,
      };
    }
    const covered = this.covered(prefix ?? "");
    // Fan out resiliently: a disk that errors shouldn't sink the whole listing —
    // skip it and flag the result incomplete (isTruncated) rather than throwing.
    const listings = await Promise.allSettled(
      covered.map(({ entry, rel }) => {
        const p = rel ? (rel.endsWith("/") ? rel : `${rel}/`) : undefined;
        return entry.disk.listObjects(p, { recursive: opts.recursive });
      }),
    );
    const objects: S3Object[] = [];
    const commonPrefixes: string[] = [];
    let isTruncated = false;
    let keyCount = 0;
    covered.forEach(({ name, entry }, i) => {
      const settled = listings[i];
      if (settled.status === "rejected") {
        isTruncated = true; // a disk failed → the merged listing may be incomplete
        return;
      }
      const listing = settled.value;
      for (const cp of listing.commonPrefixes) {
        commonPrefixes.push(`${this.abs(name, entry, cp.replace(/\/+$/, ""))}/`);
      }
      for (const obj of listing.objects) {
        objects.push({ ...obj, key: this.abs(name, entry, obj.key) });
      }
      isTruncated = isTruncated || listing.isTruncated;
      keyCount += listing.keyCount;
    });
    objects.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    commonPrefixes.sort();
    return { objects, commonPrefixes, isTruncated, keyCount };
  }

  async grep(opts: GrepOptions): Promise<GrepResult> {
    const directory = opts.directory ?? "";
    const atRoot = toSegments(directory).length === 0;
    // At the root, glob paths start with a mount's name, which its disk's paths
    // lack, so rebase the globs per mount and skip the mounts they rule out.
    const covered = this.covered(directory).flatMap((c) => {
      if (!atRoot || !opts.globs?.length) return [{ ...c, globs: opts.globs }];
      const globs = globsForMount(opts.globs, c.name);
      return globs === null ? [] : [{ ...c, globs }];
    });
    // Fan out resiliently: a disk that errors contributes a "list_failed" reason
    // (surfaced as a partial-results caveat) instead of failing the whole grep.
    const results = await Promise.allSettled(
      covered.map(({ entry, rel, globs }) => entry.disk.grep({ ...opts, directory: rel, globs })),
    );
    const matches: GrepMatch[] = [];
    const groups: GrepGroup[] = [];
    let filesScanned = 0;
    let containersDispatched = 0;
    let computeSecondsUsed = 0;
    let durationMs = 0;
    let listingMs = 0;
    let grepMs = 0;
    const reasons = new Set<string>();
    covered.forEach(({ name, entry }, i) => {
      const settled = results[i];
      if (settled.status === "rejected") {
        reasons.add("list_failed");
        return;
      }
      const r = settled.value;
      filesScanned += r.filesScanned;
      containersDispatched += r.containersDispatched ?? 0;
      computeSecondsUsed += r.computeSecondsUsed ?? 0;
      durationMs = Math.max(durationMs, r.durationMs ?? 0);
      listingMs = Math.max(listingMs, r.listingMs ?? 0);
      grepMs = Math.max(grepMs, r.grepMs ?? 0);
      reasons.add(r.stoppedReason);
      for (const m of r.matches) matches.push({ ...m, file: this.abs(name, entry, m.file) });
      for (const g of r.groups ?? []) groups.push({ ...g, file: this.abs(name, entry, g.file) });
    });
    // Merging across disks can exceed the cap even when every disk completed, so
    // flag the truncation ourselves before slicing — otherwise the extra matches
    // are dropped with no signal.
    const cap = opts.maxResults ?? 1000;
    if (matches.length > cap) reasons.add("max_results");
    // Report the most serious reason so a listing/scan failure on one disk isn't
    // masked by a truncation reason on another.
    const priority = ["list_failed", "incomplete", "deadline", "max_results"];
    const stoppedReason = [...reasons].every((x) => x === "completed")
      ? "completed"
      : (priority.find((x) => reasons.has(x)) ?? "completed");
    const withGroups = (opts.contextBefore ?? 0) > 0 || (opts.contextAfter ?? 0) > 0;
    return {
      matches: matches.slice(0, cap),
      ...(withGroups && {
        groups:
          matches.length > cap
            ? truncateGroups(groups, cap, opts.contextAfter ?? 0, opts.multiline ?? false)
            : groups,
      }),
      stoppedReason,
      filesScanned,
      containersDispatched,
      computeSecondsUsed,
      durationMs,
      listingMs,
      grepMs,
    } as GrepResult;
  }

  exec(command: string): Promise<ExecResult> {
    const disks: Record<string, ExecMount> = {};
    for (const [name, entry] of this.mounts) {
      const hasMountOptions =
        entry.readOnly ||
        entry.subdirectory ||
        entry.conditional ||
        entry.queueMs !== undefined ||
        entry.checkoutPaths !== undefined;
      disks[name] = hasMountOptions
        ? {
            disk: entry.disk,
            subdirectory: entry.subdirectory,
            readOnly: entry.readOnly,
            conditional: entry.conditional,
            queueMs: entry.queueMs,
            checkoutPaths: entry.checkoutPaths,
          }
        : entry.disk;
    }
    return this.client.exec({ disks, command });
  }
}
