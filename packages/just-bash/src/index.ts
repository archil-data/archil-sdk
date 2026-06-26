/**
 * @archildata/just-bash - Archil filesystem adapter for just-bash
 *
 * This package provides a filesystem adapter that allows just-bash to use
 * Archil distributed filesystems as a backend.
 *
 * @example
 * ```typescript
 * import { ArchilClient } from '@archildata/native';
 * import { ArchilFs } from '@archildata/just-bash';
 * import { Bash } from 'just-bash';
 *
 * // Connect to Archil
 * const client = await ArchilClient.connect({
 *   region: 'aws-us-east-1',
 *   diskName: 'myaccount/mydisk',
 *   authToken: 'adt_xxx',
 * });
 *
 * // Create filesystem adapter
 * const fs = await ArchilFs.create(client);
 *
 * // Use with just-bash
 * const bash = new Bash({ fs });
 * const result = await bash.run('ls -la /');
 * console.log(result.stdout);
 * ```
 *
 * @packageDocumentation
 */

import { ArchilFs } from "./ArchilFs.js";
export { ArchilFs };

export type {
  IFileSystem,
  FsStat,
  DirentEntry,
  BufferEncoding,
  FileContent,
} from "./ArchilFs.js";

export { createArchilCommand } from "./commands.js";

/**
 * Create an ArchilFs instance, optionally rooted at a subdirectory.
 *
 * @param client - Connected ArchilClient instance
 * @param options - Optional configuration
 * @returns Configured ArchilFs instance
 *
 * @example
 * ```typescript
 * import { ArchilClient } from '@archildata/native';
 * import { createArchilFs } from '@archildata/just-bash';
 *
 * const client = await ArchilClient.connectAuthenticated({...});
 * const fs = await createArchilFs(client, { user: { uid: 1000, gid: 1000 } });
 * ```
 */
export async function createArchilFs(
  client: import("@archildata/native").ArchilClient,
  options?: { user?: import("@archildata/native").UnixUser; subdirectory?: string }
): Promise<ArchilFs> {
  return ArchilFs.create(client, options);
}
