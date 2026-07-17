import type {
  Disk,
  ExecResult,
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
    const covered = this.covered(opts.directory ?? "");
    // Fan out resiliently: a disk that errors contributes a "list_failed" reason
    // (surfaced as a partial-results caveat) instead of failing the whole grep.
    const results = await Promise.allSettled(
      covered.map(({ entry, rel }) => entry.disk.grep({ ...opts, directory: rel })),
    );
    const matches: GrepMatch[] = [];
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
      for (const m of r.matches) matches.push({ file: this.abs(name, entry, m.file), line: m.line, text: m.text });
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
    return {
      matches: matches.slice(0, cap),
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
