// Unit tests for path routing (pure logic, no I/O). Path resolution has the
// most combinatorial surface and is where routing bugs have clustered, so it
// gets focused coverage here: `toSegments` (normalization) directly, and
// `Workspace` routing through its public FileSystem methods with fake disks.

import { test } from "vitest";
import assert from "node:assert/strict";
import { toSegments } from "../src/paths.js";
import { Workspace } from "../src/workspace.js";

type Calls = Record<string, string | undefined>;
type FakeDisk = {
  name: string;
  _calls: Calls;
  getObject: (key: string) => Promise<Uint8Array>;
  putObject: (key: string) => Promise<Record<string, never>>;
  deleteObject: (key: string) => Promise<void>;
  listObjects: (prefix?: string) => Promise<{
    objects: Array<{ key: string; size: number }>;
    commonPrefixes: string[];
    isTruncated: boolean;
    keyCount: number;
  }>;
  grep: (opts: { directory?: string }) => Promise<{
    matches: never[];
    stoppedReason: "completed";
    filesScanned: number;
  }>;
};

// A Disk stand-in that records the key/prefix/directory each method is asked
// for, so routing can be asserted without any real I/O.
function fakeDisk(name: string): FakeDisk {
  const calls: Calls = {};
  return {
    name,
    _calls: calls,
    getObject(key: string) {
      calls.get = key;
      return Promise.resolve(new Uint8Array());
    },
    putObject(key: string) {
      calls.put = key;
      return Promise.resolve({});
    },
    deleteObject(key: string) {
      calls.delete = key;
      return Promise.resolve();
    },
    listObjects(prefix?: string) {
      calls.listPrefix = prefix;
      return Promise.resolve({
        objects: [{ key: "logs/x.txt", size: 3 }],
        commonPrefixes: [],
        isTruncated: false,
        keyCount: 1,
      });
    },
    grep(opts: { directory?: string }) {
      calls.grepDir = opts.directory;
      return Promise.resolve({ matches: [], stoppedReason: "completed", filesScanned: 0 });
    },
  };
}

const ws = (mounts: Record<string, any>) =>
  new Workspace(
    {
      exec: async () => ({
        exitCode: 0,
        stdout: "",
        stderr: "",
        timing: { totalMs: 0, queueMs: 0, executeMs: 0 },
      }),
    },
    mounts,
  );

test("toSegments: leading slash optional, dot and dot-dot resolved", () => {
  assert.deepEqual(toSegments("/a/b.txt"), ["a", "b.txt"]);
  assert.deepEqual(toSegments("a/b.txt"), ["a", "b.txt"]);
  assert.deepEqual(toSegments("/"), []);
  assert.deepEqual(toSegments("/a/b/../c.txt"), ["a", "c.txt"]);
  assert.deepEqual(toSegments("/a/./b"), ["a", "b"]);
  assert.deepEqual(toSegments("/../../etc/x"), ["etc", "x"]); // can't escape root
});

test("toSegments: a shell-style container-root prefix is stripped", () => {
  assert.deepEqual(toSegments("/mnt/a/b.txt", "/mnt"), ["a", "b.txt"]);
  assert.deepEqual(toSegments("/mnt", "/mnt"), []);
  assert.deepEqual(toSegments("/mnt/archil/data/q.txt", "/mnt/archil"), ["data", "q.txt"]);
});

test("workspace: the first key segment names the disk", async () => {
  const data = fakeDisk("data");
  const cache = fakeDisk("cache");
  const w = ws({ data, cache });
  await w.getObject("data/x/y.txt");
  assert.equal(data._calls.get, "x/y.txt");
  await w.getObject("/cache/z.txt"); // leading slash tolerated
  assert.equal(cache._calls.get, "z.txt");
});

test("workspace: a mount subdirectory prefixes the key", async () => {
  const data = fakeDisk("data");
  const w = ws({ data: { disk: data, subdirectory: "sub" } });
  await w.getObject("data/a.txt");
  assert.equal(data._calls.get, "sub/a.txt");
});

test("workspace: dot-dot routes to the right disk (matches the shell)", async () => {
  const data = fakeDisk("data");
  const cache = fakeDisk("cache");
  const w = ws({ data, cache });
  await w.getObject("data/../cache/x.txt");
  assert.equal(cache._calls.get, "x.txt");
  assert.equal(data._calls.get, undefined); // never touched
});

test("workspace: exact disk-name match (overlapping names don't collide)", async () => {
  const data = fakeDisk("data");
  const archive = fakeDisk("data-archive");
  const w = ws({ data, "data-archive": archive });
  await w.getObject("data-archive/f.txt");
  assert.equal(archive._calls.get, "f.txt");
  assert.equal(data._calls.get, undefined);
});

test("workspace: an unknown disk or the bare root is rejected", async () => {
  const w = ws({ data: fakeDisk("data") });
  await assert.rejects(() => w.getObject("other/x"), /No disk named 'other'/);
  await assert.rejects(() => w.getObject("/"), /workspace root/);
});

test("workspace: a mount name with a slash is rejected", () => {
  assert.throws(() => ws({ "a/b": fakeDisk("x") }), /must not contain '\/'/);
});

test("workspace: reserved '.' / '..' mount names are rejected", () => {
  assert.throws(() => ws({ ".": fakeDisk("x") }), /reserved/);
  assert.throws(() => ws({ "..": fakeDisk("x") }), /reserved/);
});

test("workspace root listObjects returns the disks themselves (non-recursive)", async () => {
  const data = fakeDisk("data");
  const cache = fakeDisk("cache");
  const w = ws({ data, cache });
  const result = await w.listObjects();
  // The disks are the top-level directories; their contents aren't fanned into.
  assert.deepEqual(result.commonPrefixes, ["cache/", "data/"]);
  assert.deepEqual(result.objects, []);
  assert.equal(data._calls.listPrefix, undefined); // disks not even queried
});

test("workspace recursive root listObjects fans out with disk-prefixed keys", async () => {
  const data = fakeDisk("data");
  const cache = fakeDisk("cache");
  const w = ws({ data, cache });
  const result = await w.listObjects(undefined, { recursive: true });
  assert.deepEqual(
    result.objects.map((o) => o.key).sort(),
    ["cache/logs/x.txt", "data/logs/x.txt"],
  );
});

test("workspace: a directory prefix lists only its disk", async () => {
  const data = fakeDisk("data");
  const cache = fakeDisk("cache");
  const w = ws({ data, cache });
  await w.listObjects("data/logs/");
  assert.equal(data._calls.listPrefix, "logs/");
  assert.equal(cache._calls.listPrefix, undefined); // not touched
});

test("workspace: a failing disk doesn't sink the whole fan-out", async () => {
  const ok = fakeDisk("ok");
  const bad = {
    name: "bad",
    _calls: {},
    listObjects: () => Promise.reject(new Error("boom")),
    grep: () => Promise.reject(new Error("boom")),
  };
  const w = ws({ ok, bad });
  // grep: the bad disk surfaces as a partial-results reason, ok's run is kept.
  const g = await w.grep({ pattern: "x", directory: "" });
  assert.equal(g.stoppedReason, "list_failed");
  // listObjects (recursive, so it fans out): ok's keys are returned and the
  // result is flagged incomplete.
  const l = await w.listObjects(undefined, { recursive: true });
  assert.deepEqual(l.objects.map((o) => o.key), ["ok/logs/x.txt"]);
  assert.equal(l.isTruncated, true);
});

test("workspace: grep flags max_results when merged matches exceed the cap", async () => {
  const mk = (name: string) => ({
    name,
    grep: async () => ({
      matches: [
        { file: "a.txt", line: 1, text: "x" },
        { file: "b.txt", line: 2, text: "x" },
      ],
      stoppedReason: "completed",
      filesScanned: 1,
      containersDispatched: 0,
      computeSecondsUsed: 0,
      durationMs: 0,
      listingMs: 0,
      grepMs: 0,
    }),
  });
  const w = ws({ data: mk("data"), cache: mk("cache") });
  // 2 + 2 = 4 merged matches, cap 3 → must be flagged truncated, not silent.
  const r = await w.grep({ pattern: "x", directory: "", maxResults: 3 });
  assert.equal(r.matches.length, 3);
  assert.equal(r.stoppedReason, "max_results");
});

test("workspace: read-only mounts refuse writes and deletes", async () => {
  const data = fakeDisk("data");
  const w = ws({ data: { disk: data, readOnly: true } });
  await assert.rejects(() => w.putObject("data/a.txt", "x"), /read-only/);
  await assert.rejects(() => w.deleteObject("data/a.txt"), /read-only/);
  assert.equal(data._calls.put, undefined);
  assert.equal(data._calls.delete, undefined);
});

test("workspace: disks can be added and removed at runtime", async () => {
  const data = fakeDisk("data");
  const w = ws({ data });
  assert.deepEqual(w.diskNames(), ["data"]);

  const extra = fakeDisk("extra");
  w.addDisk("extra", extra as any);
  assert.deepEqual(w.diskNames().sort(), ["data", "extra"]);
  await w.getObject("extra/f.txt");
  assert.equal(extra._calls.get, "f.txt");

  assert.equal(w.removeDisk("extra"), true);
  assert.deepEqual(w.diskNames(), ["data"]);
  await assert.rejects(() => w.getObject("extra/f.txt"), /No disk named 'extra'/);

  assert.throws(() => w.removeDisk("data"), /last disk/);
  assert.deepEqual(w.diskNames(), ["data"]);
});
