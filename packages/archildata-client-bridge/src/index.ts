// @archildata/client is deprecated. This shim re-exports the new packages so
// existing imports keep working for one release.
//
// Migrate to:
//   import { Archil, Disk, ... } from "disk";
//   import { ArchilClient, ... } from "@archildata/native";

import type * as Native from "@archildata/native";

export * from "disk";
export type * from "@archildata/native";

import { createRequire } from "node:module";

let native: Partial<typeof Native> = {};
try {
  const nativeRequire = createRequire(import.meta.url);
  native = nativeRequire("@archildata/native") as typeof Native;
} catch (e) {
  const msg = e instanceof Error ? e.message : "";
  // Swallow only "platform unsupported" errors; rethrow real install failures.
  if (
    !msg.includes("does not support") &&
    !msg.includes("only supports") &&
    !msg.includes("cannot be loaded through a bundler") &&
    !msg.includes("Cannot find module")
  ) {
    throw e;
  }
}

// On unsupported platforms (Windows, Alpine) or when @archildata/native isn't
// installed, the lazy require above leaves `native` empty. Returning undefined
// for the re-exported symbols means `new ArchilClient(...)` yields a cryptic
// "X is not a constructor". Substitute a proxy that throws a clear install
// hint on any access or call.
function throwingSentinel(symbolName: string): never {
  throw new Error(
    `${symbolName} requires the @archildata/native package, which isn't installed ` +
      `or isn't available on this platform (${process.platform}/${process.arch}). ` +
      `Run \`npm install @archildata/native\` — see that package's README for supported platforms.`,
  );
}

function unavailable<T>(symbolName: string): T {
  const raise = (): never => throwingSentinel(symbolName);
  return new Proxy(function () {} as unknown as T & object, {
    construct: raise,
    apply: raise,
    get: raise,
  }) as T;
}

export const ArchilClient =
  native.ArchilClient ?? unavailable<typeof Native.ArchilClient>("ArchilClient");
export const initLogging =
  native.initLogging ?? unavailable<typeof Native.initLogging>("initLogging");
// JsInodeType is a `const enum` in @archildata/native's types; `typeof` on a
// const enum is forbidden under isolatedModules, so type it as the matching
// string-keyed object at runtime. Consumers who want the enum type can still
// `import type { JsInodeType } from "@archildata/client"`.
export const JsInodeType =
  native.JsInodeType ?? unavailable<Record<string, string>>("JsInodeType");
export const MAXIMUM_READ_SIZE =
  native.MAXIMUM_READ_SIZE ?? unavailable<typeof Native.MAXIMUM_READ_SIZE>("MAXIMUM_READ_SIZE");
