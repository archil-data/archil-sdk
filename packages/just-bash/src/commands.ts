import { defineCommand } from "just-bash";
import type { ExecResult } from "just-bash";
import type { ArchilClient } from "@archildata/native";
import type { ArchilFs } from "./ArchilFs.js";

/**
 * Create the `archil` custom command for use with just-bash.
 *
 * Provides checkout/checkin delegation management, delegation listing, and
 * cache control (invalidate-cache, set-cache-expiry) as a shell command that
 * works in scripts, pipes, and interactive use.
 *
 * @example
 * ```typescript
 * import { Bash } from 'just-bash';
 * import { ArchilFs, createArchilCommand } from '@archildata/just-bash';
 *
 * const fs = await ArchilFs.create(client);
 * const bash = new Bash({
 *   fs,
 *   customCommands: [createArchilCommand(client, fs)],
 * });
 *
 * await bash.exec('archil checkout /mydir');
 * await bash.exec('echo "hello" > /mydir/file.txt');
 * await bash.exec('archil checkin /mydir');
 * ```
 */
export function createArchilCommand(client: ArchilClient, fs: ArchilFs) {
  return defineCommand("archil", async (args, ctx) => {
    const ok = (stdout: string): ExecResult => ({ stdout, stderr: "", exitCode: 0 });
    const fail = (stderr: string): ExecResult => ({ stdout: "", stderr, exitCode: 1 });

    const subcommand = args[0];

    if (subcommand === "checkout") {
      const rest = args.slice(1);
      const force = rest.includes("--force") || rest.includes("-f");
      const pathArg = rest.find((a) => !a.startsWith("-"));
      if (!pathArg) {
        return fail("Usage: archil checkout [--force|-f] <path>\n");
      }
      const fullPath = fs.resolvePath(ctx.cwd, pathArg);
      try {
        const inodeId = await fs.resolveInodeId(fullPath);
        await client.checkout(inodeId, { force });
        return ok(`Checked out: ${fullPath} (inode ${inodeId})${force ? " (forced)" : ""}\n`);
      } catch (err) {
        return fail(`Failed to checkout ${fullPath}: ${err instanceof Error ? err.message : err}\n`);
      }
    }

    if (subcommand === "checkin") {
      const pathArg = args[1];
      if (!pathArg) {
        return fail("Usage: archil checkin <path>\n");
      }
      const fullPath = fs.resolvePath(ctx.cwd, pathArg);
      try {
        const inodeId = await fs.resolveInodeId(fullPath);
        await client.checkin(inodeId);
        return ok(`Checked in: ${fullPath} (inode ${inodeId})\n`);
      } catch (err) {
        return fail(`Failed to checkin ${fullPath}: ${err instanceof Error ? err.message : err}\n`);
      }
    }

    if (subcommand === "list-delegations" || subcommand === "delegations") {
      try {
        const delegations = client.listDelegations();
        if (delegations.length === 0) {
          return ok("No delegations held\n");
        }
        const lines = delegations.map((d) => `  inode ${d.inodeId}: ${d.state}`);
        return ok("Delegations:\n" + lines.join("\n") + "\n");
      } catch (err) {
        return fail(`Failed to list delegations: ${err instanceof Error ? err.message : err}\n`);
      }
    }

    if (subcommand === "invalidate-cache") {
      // Path is accepted for parity with the FUSE CLI (`archil invalidate-cache <path>`),
      // but the Node binding's invalidateCache() is mount-wide — there is exactly
      // one client per shell session, so any path on this filesystem is equivalent
      // to "invalidate everything". We resolve it only to validate it exists and to
      // include it in the success message for operator clarity.
      const pathArg = args.slice(1).find((a) => !a.startsWith("-"));
      let scopeLabel = "(mount-wide)";
      if (pathArg) {
        const fullPath = fs.resolvePath(ctx.cwd, pathArg);
        try {
          await fs.resolveInodeId(fullPath);
          scopeLabel = `(via ${fullPath})`;
        } catch (err) {
          return fail(`Failed to resolve ${fullPath}: ${err instanceof Error ? err.message : err}\n`);
        }
      }
      try {
        const stats = client.invalidateCache();
        return ok(
          `Invalidated cache ${scopeLabel}: ${stats.totalEvictedInodes} inodes evicted ` +
          `(attr=${stats.attribute}, xattr=${stats.extendedAttribute}, ` +
          `dirent=${stats.dirent}, file=${stats.fileData})\n`
        );
      } catch (err) {
        return fail(`Failed to invalidate cache: ${err instanceof Error ? err.message : err}\n`);
      }
    }

    if (subcommand === "set-cache-expiry") {
      const rest = args.slice(1);
      const flagIdx = rest.indexOf("--readdir-expiry");
      if (flagIdx === -1 || flagIdx === rest.length - 1) {
        return fail("Usage: archil set-cache-expiry <path> --readdir-expiry <seconds>\n");
      }
      const flagValueIdx = flagIdx + 1;
      const expirySeconds = Number(rest[flagValueIdx]);
      if (!Number.isInteger(expirySeconds) || expirySeconds < 0) {
        return fail("--readdir-expiry must be a non-negative integer (seconds)\n");
      }
      const pathArg = rest.find((a, i) => i !== flagIdx && i !== flagValueIdx && !a.startsWith("-"));
      if (!pathArg) {
        return fail("Usage: archil set-cache-expiry <path> --readdir-expiry <seconds>\n");
      }
      const fullPath = fs.resolvePath(ctx.cwd, pathArg);
      try {
        const inodeId = await fs.resolveInodeId(fullPath);
        client.setCacheExpiry(inodeId, expirySeconds);
        return ok(`Set readdir cache expiry for ${fullPath} (inode ${inodeId}) to ${expirySeconds}s\n`);
      } catch (err) {
        return fail(`Failed to set cache expiry for ${fullPath}: ${err instanceof Error ? err.message : err}\n`);
      }
    }

    if (subcommand === "help" || !subcommand) {
      return ok(
        "Archil commands:\n" +
        "  archil checkout [--force|-f] <path>             - Acquire write delegation\n" +
        "  archil checkin <path>                           - Release write delegation\n" +
        "  archil list-delegations                         - Show held delegations\n" +
        "  archil invalidate-cache [<path>]                - Drop every evictable cache entry\n" +
        "  archil set-cache-expiry <path> --readdir-expiry <secs>\n" +
        "                                                  - Set readdir cache TTL on a directory\n" +
        "  archil help                                     - Show this help message\n" +
        "\n" +
        "The --force flag revokes any existing delegation from other clients.\n"
      );
    }

    return fail(`Unknown archil command: ${subcommand}\nRun 'archil help' for available commands\n`);
  });
}
