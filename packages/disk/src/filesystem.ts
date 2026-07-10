import type {
  ExecResult,
  GrepOptions,
  GrepResult,
  ListObjectsOptions,
  ListObjectsResult,
  PutObjectOptions,
  PutObjectResult,
} from "./disk.js";

/**
 * A key-addressable filesystem over one or more Archil disks — the existing
 * object API a {@link Disk} already exposes ({@link Disk.getObject},
 * `putObject`, `deleteObject`, `listObjects`, `grep`, `exec`), captured as a
 * contract so a multi-disk {@link Workspace} can be used anywhere a single disk
 * is.
 *
 * A single {@link Disk} is the one-disk case: keys are relative to the disk
 * root. A {@link Workspace} spans several disks, each mounted under a name, so
 * its keys carry that name as the first segment (e.g. `data/reports/q1.csv`)
 * and `listObjects`/`grep` fan out across every disk when the key/prefix
 * doesn't name one.
 *
 * Both `Disk` and `Workspace` implement this interface, which is what keeps the
 * two from drifting — adding a method here is a compile error until both do.
 */
export interface FileSystem {
  /** Read an object's full contents. Throws `ArchilS3Error` (404) if absent. */
  getObject(key: string): Promise<Uint8Array>;
  /** Create or overwrite an object. Optional `mode`/`uid`/`gid` set POSIX attrs. */
  putObject(
    key: string,
    body: string | Uint8Array | ArrayBuffer,
    options?: string | PutObjectOptions,
  ): Promise<PutObjectResult>;
  /** Delete an object (idempotent). */
  deleteObject(key: string): Promise<void>;
  /** List objects and common (directory) prefixes under a key prefix. */
  listObjects(prefix?: string, opts?: ListObjectsOptions): Promise<ListObjectsResult>;
  /** Constant-time parallel grep. */
  grep(opts: GrepOptions): Promise<GrepResult>;
  /** Run a command in a sandbox with the filesystem mounted. */
  exec(command: string): Promise<ExecResult>;
}
