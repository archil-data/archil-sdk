/**
 * Archil filesystem adapter for just-bash
 *
 * Implements the IFileSystem interface from just-bash using the ArchilClient
 * from @archildata/native for direct protocol access to Archil distributed filesystems.
 */

import createDebug from "debug";
import { MAXIMUM_READ_SIZE } from "@archildata/native";
import type { ArchilClient, DirectoryEntry, InodeAttributes, UnixUser } from "@archildata/native";

const debug = createDebug("archil:fs");

// Types from just-bash interface (we define them here to avoid hard dependency)
export type BufferEncoding =
  | "utf8"
  | "utf-8"
  | "ascii"
  | "binary"
  | "base64"
  | "hex"
  | "latin1";

export type FileContent = string | Uint8Array;

export interface FsStat {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  mode: number;
  size: number;
  mtime: Date;
}

export interface DirentEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

export interface IFileSystem {
  // Read operations
  readFile(path: string, encoding?: BufferEncoding): Promise<string>;
  readFileBuffer(path: string): Promise<Uint8Array>;
  readdir(path: string): Promise<string[]>;
  readdirWithFileTypes?(path: string): Promise<DirentEntry[]>;
  stat(path: string): Promise<FsStat>;
  lstat(path: string): Promise<FsStat>;
  exists(path: string): Promise<boolean>;
  readlink(path: string): Promise<string>;
  realpath(path: string): Promise<string>;

  // Write operations
  writeFile(path: string, content: FileContent): Promise<void>;
  appendFile(path: string, content: FileContent): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  cp(src: string, dest: string, options?: { recursive?: boolean }): Promise<void>;
  mv(src: string, dest: string): Promise<void>;
  symlink(target: string, path: string): Promise<void>;
  link(existingPath: string, newPath: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  utimes(path: string, atime: Date, mtime: Date): Promise<void>;

  // Utility
  resolvePath(base: string, ...paths: string[]): string;
  getAllPaths?(): string[];
}

/**
 * Path resolution result containing both the inode ID and attributes
 */
interface ResolvedPath {
  inodeId: number;
  attributes: InodeAttributes;
}

/**
 * ArchilFs implements the just-bash IFileSystem interface using Archil protocol.
 *
 * This adapter provides:
 * - Path-to-inode resolution
 * - Full filesystem operations via Archil protocol
 * - Optional user context for permission checks
 *
 * @example
 * ```typescript
 * import { ArchilClient } from '@archildata/native';
 * import { ArchilFs } from '@archildata/just-bash';
 *
 * const client = await ArchilClient.connect({
 *   region: 'aws-us-east-1',
 *   diskName: 'myaccount/mydisk',
 *   authToken: 'adt_xxx',
 * });
 *
 * const fs = await ArchilFs.create(client);
 *
 * // Use with just-bash
 * import { Bash } from 'just-bash';
 * const bash = new Bash({ fs });
 * await bash.run('ls -la /');
 * ```
 */
export class ArchilFs implements IFileSystem {
  private client: ArchilClient;
  private user?: UnixUser;
  private rootInodeId: number = 1;

  private constructor(
    client: ArchilClient,
    options?: {
      user?: UnixUser;
    }
  ) {
    this.client = client;
    this.user = options?.user;
  }

  /**
   * Create an ArchilFs adapter, optionally rooted at a subdirectory.
   *
   * The subdirectory path is resolved eagerly: if any component does not
   * exist or is not a directory, this method throws immediately.
   *
   * @param client - Connected ArchilClient instance
   * @param options - Optional configuration
   * @param options.user - Unix user context for permission checks
   * @param options.subdirectory - Subdirectory to treat as the root of the filesystem
   */
  static async create(
    client: ArchilClient,
    options?: {
      user?: UnixUser;
      subdirectory?: string;
    }
  ): Promise<ArchilFs> {
    const fs = new ArchilFs(client, { user: options?.user });

    if (options?.subdirectory) {
      const resolved = await fs.resolveFollow(options.subdirectory);
      if (resolved.attributes.inodeType !== "Directory") {
        throw new Error(`ENOTDIR: subdirectory '${options.subdirectory}' is not a directory`);
      }
      fs.rootInodeId = resolved.inodeId;
      debug("resolved subdirectory '%s' to inode %d", options.subdirectory, fs.rootInodeId);
    }

    return fs;
  }

  // ========================================================================
  // Path Resolution
  // ========================================================================

  /**
   * Normalize a path (remove . and .., ensure leading /)
   */
  private normalizePath(path: string): string {
    // Handle empty path
    if (!path || path === "") {
      return "/";
    }

    // Ensure absolute path
    if (!path.startsWith("/")) {
      path = "/" + path;
    }

    // Split and process components
    const parts = path.split("/").filter((p) => p !== "" && p !== ".");
    const result: string[] = [];

    for (const part of parts) {
      if (part === "..") {
        result.pop();
      } else {
        result.push(part);
      }
    }

    return "/" + result.join("/");
  }

  private static readonly MAX_SYMLINKS = 40;

  /**
   * Resolve a path to its inode ID, walking the directory tree.
   * Follows symlinks on intermediate components but NOT on the final
   * component (matching lstat/readlink semantics).
   */
  private async resolve(path: string, symlinkDepth: number = 0): Promise<ResolvedPath> {
    const normalizedPath = this.normalizePath(path);

    const parts = normalizedPath.split("/").filter((p) => p !== "");
    let currentInodeId = this.rootInodeId;
    let resolvedPath = "/";

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const response = await this.client.lookupInode(currentInodeId, part, { user: this.user });

      if (response === null) {
        throw new Error(`ENOENT: no such file or directory, '${path}'`);
      }

      const isLast = i === parts.length - 1;

      // Follow symlinks on intermediate components
      if (!isLast && response.attributes.inodeType === "Symlink" && response.attributes.symlinkTarget) {
        if (symlinkDepth >= ArchilFs.MAX_SYMLINKS) {
          throw new Error(`ELOOP: too many levels of symbolic links, '${path}'`);
        }
        const targetPath = response.attributes.symlinkTarget.startsWith("/")
          ? response.attributes.symlinkTarget
          : this.resolvePath(resolvedPath, response.attributes.symlinkTarget);
        // Resolve the symlink target, then continue with remaining components
        const remaining = parts.slice(i + 1).join("/");
        const fullPath = remaining ? targetPath + "/" + remaining : targetPath;
        return this.resolve(fullPath, symlinkDepth + 1);
      }

      resolvedPath = resolvedPath === "/" ? "/" + part : resolvedPath + "/" + part;
      currentInodeId = response.inodeId;
    }

    const attributes = await this.client.getAttributes(currentInodeId, { user: this.user });
    return { inodeId: currentInodeId, attributes };
  }

  /**
   * Resolve a path, following symlinks on ALL components including the
   * final one (like stat(2)). Use resolve() when you need lstat semantics.
   */
  private async resolveFollow(path: string, symlinkDepth: number = 0): Promise<ResolvedPath> {
    if (symlinkDepth >= ArchilFs.MAX_SYMLINKS) {
      throw new Error(`ELOOP: too many levels of symbolic links, '${path}'`);
    }
    const resolved = await this.resolve(path, symlinkDepth);
    if (resolved.attributes.inodeType === "Symlink" && resolved.attributes.symlinkTarget) {
      const targetPath = resolved.attributes.symlinkTarget.startsWith("/")
        ? resolved.attributes.symlinkTarget
        : this.resolvePath(path, "..", resolved.attributes.symlinkTarget);
      return this.resolveFollow(targetPath, symlinkDepth + 1);
    }
    return resolved;
  }

  /**
   * Resolve parent directory and get child name
   */
  private async resolveParent(path: string): Promise<{ parentInodeId: number; name: string }> {
    debug("resolveParent raw path=%j (bytes: %o)", path, Buffer.from(path));
    const normalizedPath = this.normalizePath(path);
    const lastSlash = normalizedPath.lastIndexOf("/");
    const parentPath = lastSlash === 0 ? "/" : normalizedPath.substring(0, lastSlash);
    const name = normalizedPath.substring(lastSlash + 1);
    debug("resolveParent extracted name=%j (bytes: %o)", name, Buffer.from(name));

    const { inodeId: parentInodeId } = await this.resolve(parentPath);
    return { parentInodeId, name };
  }

  /**
   * Convert InodeAttributes to FsStat
   */
  private toStat(attrs: InodeAttributes): FsStat {
    return {
      isFile: attrs.inodeType === "File",
      isDirectory: attrs.inodeType === "Directory",
      isSymbolicLink: attrs.inodeType === "Symlink",
      mode: attrs.mode,
      size: Number(attrs.size),
      mtime: new Date(attrs.mtimeMs),
    };
  }

  private static readonly DIR_PAGE_SIZE = 1000;

  /**
   * Read all directory entries using the paginated API.
   */
  private async readAllDirectoryEntries(inodeId: number): Promise<DirectoryEntry[]> {
    const handle = await this.client.openDirectory(inodeId, { user: this.user });
    try {
      const allEntries: DirectoryEntry[] = [];
      let cursor: string | undefined;

      for (;;) {
        const page = await this.client.readDirectory(
          inodeId,
          handle,
          ArchilFs.DIR_PAGE_SIZE,
          cursor,
          { user: this.user }
        );
        allEntries.push(...page.entries);
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }

      return allEntries;
    } finally {
      this.client.closeDirectory(inodeId, handle);
    }
  }

  // ========================================================================
  // IFileSystem Implementation - Read Operations
  // ========================================================================

  resolvePath(base: string, ...paths: string[]): string {
    debug("resolvePath base=%s paths=%o", base, paths);
    let result = base;
    for (const p of paths) {
      if (p.startsWith("/")) {
        result = p;
      } else {
        result = result.endsWith("/") ? result + p : result + "/" + p;
      }
    }
    const normalized = this.normalizePath(result);
    debug("resolvePath result=%s", normalized);
    return normalized;
  }

  async readFile(path: string, encoding?: BufferEncoding): Promise<string> {
    debug("readFile path=%s encoding=%s", path, encoding);
    try {
      const buffer = await this.readFileBuffer(path);
      debug("readFile got buffer length=%d", buffer.length);
      // "base64", "hex", and "binary" are Node Buffer encodings not supported
      // by TextDecoder — use Buffer.toString() for those.
      const enc = encoding || "utf-8";
      let result: string;
      if (enc === "base64" || enc === "hex" || enc === "binary") {
        result = Buffer.from(buffer).toString(enc);
      } else {
        result = new TextDecoder(enc).decode(buffer);
      }
      debug("readFile decoded to string length=%d", result.length);
      return result;
    } catch (err) {
      debug("readFile FAILED: %O", err);
      throw err;
    }
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    debug("readFileBuffer path=%s", path);
    const { inodeId, attributes } = await this.resolveFollow(path);
    debug("readFileBuffer resolved inodeId=%d type=%s size=%d", inodeId, attributes.inodeType, attributes.size);

    if (attributes.inodeType !== "File") {
      throw new Error(`EISDIR: illegal operation on a directory, read '${path}'`);
    }

    const size = Number(attributes.size);
    if (size === 0) {
      debug("readFileBuffer file is empty, returning empty buffer");
      return new Uint8Array(0);
    }

    if (size <= MAXIMUM_READ_SIZE) {
      const buffer = await this.client.readInode(inodeId, 0, size, { user: this.user });
      return new Uint8Array(buffer);
    }

    // Read large files in chunks
    const result = new Uint8Array(size);
    let offset = 0;
    while (offset < size) {
      const chunkSize = Math.min(MAXIMUM_READ_SIZE, size - offset);
      const chunk = await this.client.readInode(inodeId, offset, chunkSize, { user: this.user });
      result.set(new Uint8Array(chunk), offset);
      offset += chunkSize;
    }
    return result;
  }

  async readdir(path: string): Promise<string[]> {
    debug("readdir path=%s", path);
    const { inodeId, attributes } = await this.resolveFollow(path);

    if (attributes.inodeType !== "Directory") {
      throw new Error(`ENOTDIR: not a directory, scandir '${path}'`);
    }

    const entries = await this.readAllDirectoryEntries(inodeId);
    for (const e of entries) {
      debug("readdir entry name=%j (bytes: %o)", e.name, Buffer.from(e.name));
    }
    return entries
      .map((e) => e.name)
      .filter((name) => name !== "." && name !== "..");
  }

  async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    const { inodeId, attributes } = await this.resolveFollow(path);

    if (attributes.inodeType !== "Directory") {
      throw new Error(`ENOTDIR: not a directory, scandir '${path}'`);
    }

    const entries = await this.readAllDirectoryEntries(inodeId);

    return entries
      .filter((e) => e.name !== "." && e.name !== "..")
      .map((e) => ({
        name: e.name,
        isFile: e.inodeType === "File",
        isDirectory: e.inodeType === "Directory",
        isSymbolicLink: e.inodeType === "Symlink",
      }));
  }

  async stat(path: string): Promise<FsStat> {
    debug("stat path=%s", path);
    const { attributes } = await this.resolveFollow(path);
    return this.toStat(attributes);
  }

  async lstat(path: string): Promise<FsStat> {
    debug("lstat path=%s", path);
    const { attributes } = await this.resolve(path);
    return this.toStat(attributes);
  }

  async exists(path: string): Promise<boolean> {
    debug("exists path=%s", path);
    try {
      await this.resolve(path);
      debug("exists path=%s -> true", path);
      return true;
    } catch {
      debug("exists path=%s -> false", path);
      return false;
    }
  }

  async readlink(path: string): Promise<string> {
    const { attributes } = await this.resolve(path);

    if (attributes.inodeType !== "Symlink") {
      throw new Error(`EINVAL: invalid argument, readlink '${path}'`);
    }

    return attributes.symlinkTarget || "";
  }

  async realpath(path: string, symlinkDepth: number = 0): Promise<string> {
    const normalizedPath = this.normalizePath(path);

    const parts = normalizedPath.split("/").filter((p) => p !== "");
    let resolvedPath = "/";
    let currentInodeId = this.rootInodeId;

    for (const part of parts) {
      const response = await this.client.lookupInode(currentInodeId, part, { user: this.user });

      if (response === null) {
        throw new Error(`ENOENT: no such file or directory, realpath '${path}'`);
      }

      const attrs = response.attributes;

      if (attrs.inodeType === "Symlink" && attrs.symlinkTarget) {
        if (symlinkDepth >= ArchilFs.MAX_SYMLINKS) {
          throw new Error(`ELOOP: too many levels of symbolic links, '${path}'`);
        }
        const targetPath = attrs.symlinkTarget.startsWith("/")
          ? attrs.symlinkTarget
          : this.resolvePath(resolvedPath, attrs.symlinkTarget);
        const resolved = await this.realpath(targetPath, symlinkDepth + 1);
        resolvedPath = resolved;
        const { inodeId } = await this.resolve(resolved);
        currentInodeId = inodeId;
      } else {
        resolvedPath = resolvedPath === "/" ? "/" + part : resolvedPath + "/" + part;
        currentInodeId = response.inodeId;
      }
    }

    return resolvedPath;
  }

  // ========================================================================
  // IFileSystem Implementation - Write Operations
  // ========================================================================

  async writeFile(path: string, content: FileContent): Promise<void> {
    debug("writeFile path=%s contentLength=%d", path, content.length);
    const data = typeof content === "string" ? new TextEncoder().encode(content) : content;

    // Try to resolve existing file — only this call can produce a
    // legitimate ENOENT (file doesn't exist yet). Everything after it
    // must propagate errors, not fall through to the create path.
    let resolved: ResolvedPath | null;
    try {
      resolved = await this.resolveFollow(path);
    } catch (err) {
      if (err instanceof Error && err.message.includes("ENOENT")) {
        resolved = null;
      } else {
        throw err;
      }
    }

    if (resolved !== null) {
      debug("writeFile resolved existing file path=%s inodeId=%d", path, resolved.inodeId);

      if (resolved.attributes.inodeType !== "File") {
        throw new Error(`EISDIR: illegal operation on a directory, write '${path}'`);
      }

      // Atomic overwrite: write to a temp file, then rename over the original.
      // This ensures readers never see partial content or stale trailing bytes.
      // Use realpath so we target the actual file, not a symlink entry.
      const realPath = await this.realpath(path);
      const { parentInodeId, name } = await this.resolveParent(realPath);
      const tmpName = `.~tmp-${Math.random().toString(36).slice(2)}`;
      debug("writeFile atomic overwrite via temp=%s", tmpName);

      const tmpResult = await this.client.create(
        parentInodeId,
        tmpName,
        {
          inodeType: "File",
          uid: resolved.attributes.uid,
          gid: resolved.attributes.gid,
          mode: resolved.attributes.mode,
        },
        { user: this.user }
      );

      try {
        await this.client.writeData(tmpResult.inodeId, 0, Buffer.from(data), { user: this.user });
        await this.client.rename(parentInodeId, tmpName, parentInodeId, name, { user: this.user });
        debug("writeFile atomic overwrite succeeded");
      } catch (writeErr) {
        // Best-effort cleanup of temp file
        try { await this.client.unlink(parentInodeId, tmpName, { user: this.user }); } catch { /* ignore */ }
        throw writeErr;
      }

      return;
    }

    debug("writeFile file doesn't exist, creating: %s", path);
    const { parentInodeId, name } = await this.resolveParent(path);
    debug("writeFile resolved parent parentInodeId=%d name=%s", parentInodeId, name);

    const result = await this.client.create(
      parentInodeId,
      name,
      {
        inodeType: "File",
        uid: this.user?.uid ?? 0,
        gid: this.user?.gid ?? 0,
        mode: 0o644,
      },
      { user: this.user }
    );
    debug("writeFile create succeeded inodeId=%d", result.inodeId);

    await this.client.writeData(result.inodeId, 0, Buffer.from(data), { user: this.user });
    debug("writeFile write succeeded");
  }

  async appendFile(path: string, content: FileContent): Promise<void> {
    const data = typeof content === "string" ? new TextEncoder().encode(content) : content;

    let inodeId: number;
    let size: number;
    try {
      const resolved = await this.resolveFollow(path);
      if (resolved.attributes.inodeType !== "File") {
        throw new Error(`EISDIR: illegal operation on a directory, write '${path}'`);
      }
      inodeId = resolved.inodeId;
      size = Number(resolved.attributes.size);
    } catch (err) {
      if (err instanceof Error && err.message.includes("ENOENT")) {
        // File doesn't exist — create and write from offset 0
        await this.writeFile(path, data);
        return;
      }
      throw err;
    }

    await this.client.writeData(inodeId, size, Buffer.from(data), { user: this.user });
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    const normalizedPath = this.normalizePath(path);

    if (options?.recursive) {
      // Create all directories in the path
      const parts = normalizedPath.split("/").filter((p) => p !== "");
      let currentPath = "";

      for (const part of parts) {
        currentPath += "/" + part;

        // Check if exists
        const exists = await this.exists(currentPath);
        if (exists) {
          continue;
        }

        // Create this directory
        await this.mkdirSingle(currentPath);
      }
    } else {
      await this.mkdirSingle(normalizedPath);
    }
  }

  private async mkdirSingle(path: string): Promise<void> {
    const { parentInodeId, name } = await this.resolveParent(path);

    await this.client.create(
      parentInodeId,
      name,
      {
        inodeType: "Directory",
        uid: this.user?.uid ?? 0,
        gid: this.user?.gid ?? 0,
        mode: 0o755,
      },
      { user: this.user }
    );
  }

  async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    let resolved: ResolvedPath;
    try {
      resolved = await this.resolve(path);
    } catch (err) {
      if (err instanceof Error && err.message.includes("ENOENT")) {
        if (options?.force) {
          return;
        }
        throw err;
      }
      throw err;
    }

    if (resolved.attributes.inodeType === "Directory") {
      if (!options?.recursive) {
        throw new Error(`EISDIR: illegal operation on a directory, rm '${path}'`);
      }

      // Recursively delete contents first
      const entries = await this.readdir(path);
      for (const entry of entries) {
        await this.rm(this.resolvePath(path, entry), options);
      }
    }

    // Unlink the file/directory from its parent
    const { parentInodeId, name } = await this.resolveParent(path);
    await this.client.unlink(parentInodeId, name, { user: this.user });
  }

  async cp(src: string, dest: string, options?: { recursive?: boolean }): Promise<void> {
    const srcResolved = await this.resolveFollow(src);

    if (srcResolved.attributes.inodeType === "Directory") {
      if (!options?.recursive) {
        throw new Error(`EISDIR: illegal operation on a directory, cp '${src}'`);
      }

      // Create destination directory
      await this.mkdir(dest, { recursive: true });

      // Copy contents
      const entries = await this.readdir(src);
      for (const entry of entries) {
        await this.cp(
          this.resolvePath(src, entry),
          this.resolvePath(dest, entry),
          options
        );
      }
    } else {
      // Copy file
      const content = await this.readFileBuffer(src);
      await this.writeFile(dest, content);
    }
  }

  async mv(src: string, dest: string): Promise<void> {
    // Use atomic rename operation
    const { parentInodeId: srcParentInodeId, name: srcName } = await this.resolveParent(src);
    const { parentInodeId: destParentInodeId, name: destName } = await this.resolveParent(dest);

    await this.client.rename(
      srcParentInodeId,
      srcName,
      destParentInodeId,
      destName,
      { user: this.user }
    );
  }

  async symlink(target: string, path: string): Promise<void> {
    const { parentInodeId, name } = await this.resolveParent(path);

    await this.client.create(
      parentInodeId,
      name,
      {
        inodeType: "Symlink",
        uid: this.user?.uid ?? 0,
        gid: this.user?.gid ?? 0,
        mode: 0o777,
        symlinkTarget: target,
      },
      { user: this.user }
    );
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    // Hard links require special handling
    // TODO: Implement when archil-node exposes link operation
    throw new Error(
      "Hard link operations not yet implemented. " +
        "The archil-node bindings need to expose link for hard links."
    );
  }

  async chmod(path: string, mode: number): Promise<void> {
    const { inodeId } = await this.resolveFollow(path);
    await this.client.setattr(inodeId, { mode }, { user: this.user ?? { uid: 0, gid: 0 } });
  }

  async utimes(path: string, atime: Date, mtime: Date): Promise<void> {
    debug("utimes path=%s atime=%s mtime=%s", path, atime.toISOString(), mtime.toISOString());

    const { inodeId } = await this.resolveFollow(path);
    debug("utimes resolved path=%s inodeId=%d", path, inodeId);

    const atimeMs = atime.getTime();
    const mtimeMs = mtime.getTime();

    debug("utimes calling setattr inodeId=%d atimeMs=%d mtimeMs=%d", inodeId, atimeMs, mtimeMs);
    await this.client.setattr(
      inodeId,
      { atimeMs, mtimeMs },
      { user: this.user ?? { uid: 0, gid: 0 } }
    );
    debug("utimes setattr succeeded inodeId=%d", inodeId);
  }

  // ========================================================================
  // Utility Methods
  // ========================================================================

  getAllPaths(): string[] {
    return [];
  }

  /**
   * Resolve a path to its inode ID (public wrapper for delegation operations)
   */
  async resolveInodeId(path: string): Promise<number> {
    const { inodeId } = await this.resolve(path);
    return inodeId;
  }
}
