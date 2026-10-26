// Unit tests for path routing (pure logic, no I/O). Path resolution has the
// most combinatorial surface and is where routing bugs have clustered, so it
// gets focused coverage here: `toSegments` (normalization) directly, and
// `Workspace` routing through its public FileSystem methods with fake disks.

import { test } from "vitest";
import assert from "node:assert/strict";
import { ArchilApiError } from "../src/errors.js";
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

test("workspace: grep reports a bad request instead of a partial result", async () => {
  const rejecting = (name: string, status: number, message: string) => ({
    name,
    grep: () => Promise.reject(new ArchilApiError(message, status, status === 400 ? "bad_request" : undefined)),
  });
  // The control plane rejects a bad request on every disk alike.
  const unknownType = 'unknown file type "pyy"';
  const bad = ws({ data: rejecting("data", 400, unknownType), cache: rejecting("cache", 400, unknownType) });
  await assert.rejects(bad.grep({ pattern: "x", directory: "", types: ["pyy"] }), {
    name: "ArchilApiError",
    status: 400,
    message: unknownType,
  });
  // Any other failure is one disk's, so the rest still come back.
  const down = ws({ ok: fakeDisk("ok"), bad: rejecting("bad", 503, "No runtime capacity available, please retry shortly") });
  assert.equal((await down.grep({ pattern: "x", directory: "" })).stoppedReason, "list_failed");
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

test("workspace: grep forwards options and merges context groups within the cap", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const mk = (name: string, matches: object[], groups: object[]) => ({
    name,
    grep: async (opts: Record<string, unknown>) => {
      seen.push(opts);
      return {
        matches,
        groups,
        stoppedReason: "completed",
        filesScanned: 1,
        containersDispatched: 0,
        computeSecondsUsed: 0,
        durationMs: 0,
        listingMs: 0,
        grepMs: 0,
      };
    },
  });
  const data = mk(
    "data",
    [
      { file: "a.txt", line: 1, text: "x" },
      { file: "a.txt", line: 3, endLine: 4, text: "x\ny" },
    ],
    [
      {
        file: "a.txt",
        lines: [
          { line: 1, text: "x", match: true },
          { line: 2, text: "-", match: false },
          { line: 3, text: "x", match: true },
          { line: 4, text: "y", match: true },
        ],
      },
    ],
  );
  const cache = mk(
    "cache",
    [
      { file: "b.txt", line: 5, text: "x" },
      { file: "b.txt", line: 7, text: "x" },
    ],
    [
      {
        file: "b.txt",
        lines: [
          { line: 5, text: "x", match: true },
          { line: 6, text: "-", match: false },
          { line: 7, text: "x", match: true },
          { line: 8, text: "-", match: false },
        ],
      },
    ],
  );
  const w = ws({ data, cache });
  const r = await w.grep({
    pattern: "x",
    directory: "",
    maxResults: 3,
    multiline: true,
    ignoreCase: true,
    globs: ["*.txt"],
    contextAfter: 2,
  });
  assert.deepEqual(
    seen.map((o) => [o.multiline, o.ignoreCase, o.globs, o.contextAfter]),
    [
      [true, true, ["*.txt"], 2],
      [true, true, ["*.txt"], 2],
    ],
  );
  assert.deepEqual(r.matches[1], { file: "data/a.txt", line: 3, endLine: 4, text: "x\ny" });
  // The multiline run on lines 3-4 counts once, so the cap lands on b.txt:5.
  // b.txt:7 falls in its after-context and comes back as context.
  assert.deepEqual(r.groups, [
    {
      file: "data/a.txt",
      lines: [
        { line: 1, text: "x", match: true },
        { line: 2, text: "-", match: false },
        { line: 3, text: "x", match: true },
        { line: 4, text: "y", match: true },
      ],
    },
    {
      file: "cache/b.txt",
      lines: [
        { line: 5, text: "x", match: true },
        { line: 6, text: "-", match: false },
        { line: 7, text: "x", match: false },
      ],
    },
  ]);
});

test("workspace: grep trims merged context groups at the cap", async () => {
  const hit = (line: number) => ({ line, text: "x", match: true });
  const ctx = (line: number) => ({ line, text: "-", match: false });
  const mk = (name: string, matches: object[], groups: object[]) => ({
    name,
    grep: async () => ({
      matches,
      groups,
      stoppedReason: "completed",
      filesScanned: 1,
      containersDispatched: 0,
      computeSecondsUsed: 0,
      durationMs: 0,
      listingMs: 0,
      grepMs: 0,
    }),
  });
  const a = [ctx(1), hit(2), ctx(3), hit(4), ctx(5)];
  const w = ws({
    data: mk("data", [{ file: "a.txt", line: 2, text: "x" }, { file: "a.txt", line: 4, text: "x" }], [
      { file: "a.txt", lines: a },
    ]),
    cache: mk(
      "cache",
      [
        { file: "b.txt", line: 2, text: "x" },
        { file: "b.txt", line: 3, text: "x" },
        { file: "b.txt", line: 9, text: "x" },
      ],
      [
        { file: "b.txt", lines: [ctx(1), hit(2), hit(3), ctx(4), ctx(5)] },
        { file: "b.txt", lines: [ctx(8), hit(9), ctx(10)] },
      ],
    ),
  });
  const trimmed = async (contextBefore: number, contextAfter: number) =>
    (await w.grep({ pattern: "x", directory: "", maxResults: 3, contextBefore, contextAfter })).groups;
  const demoted = { ...hit(3), match: false };

  // Without multiline, b.txt:3 is a match of its own, so the cap lands on
  // b.txt:2. b.txt:3 falls in its after-context and comes back as context, the
  // group ends after contextAfter lines, and b.txt's later group is dropped.
  assert.deepEqual(await trimmed(1, 2), [
    { file: "data/a.txt", lines: a },
    { file: "cache/b.txt", lines: [ctx(1), hit(2), demoted, ctx(4)] },
  ]);
  // Without after-context, the group ends at the cap's match.
  assert.deepEqual(await trimmed(1, 0), [
    { file: "data/a.txt", lines: a },
    { file: "cache/b.txt", lines: [ctx(1), hit(2)] },
  ]);
  // After-context longer than the group keeps the rest of it, and no more.
  assert.deepEqual(await trimmed(1, 10), [
    { file: "data/a.txt", lines: a },
    { file: "cache/b.txt", lines: [ctx(1), hit(2), demoted, ctx(4), ctx(5)] },
  ]);

  // With multiline, a cap landing on a run that ends its group keeps the whole
  // run, even without after-context.
  const run = ws({
    data: mk("data", [{ file: "a.txt", line: 1, endLine: 2, text: "x\nx" }, { file: "a.txt", line: 5, text: "x" }], [
      { file: "a.txt", lines: [hit(1), hit(2)] },
      { file: "a.txt", lines: [ctx(4), hit(5)] },
    ]),
  });
  const r = await run.grep({ pattern: "x", directory: "", maxResults: 1, multiline: true, contextBefore: 1 });
  assert.deepEqual(r.groups, [{ file: "data/a.txt", lines: [hit(1), hit(2)] }]);
});

test("workspace: grep omits groups without context", async () => {
  const w = ws({ data: fakeDisk("data") });
  const r = await w.grep({ pattern: "x", directory: "" });
  assert.equal(r.groups, undefined);
});

test("workspace: grep rebases root globs onto each mount", async () => {
  const sent = new Map<string, string[] | undefined>();
  const mk = (name: string) => ({
    name,
    grep: async (opts: { globs?: string[] }) => {
      sent.set(name, opts.globs);
      return { matches: [], stoppedReason: "completed", filesScanned: 0 };
    },
  });
  const w = ws({ data: mk("data"), cache: mk("cache"), logs: mk("logs") });
  const globsSent = async (directory: string, globs: string[]) => {
    sent.clear();
    await w.grep({ pattern: "x", directory, globs });
    return Object.fromEntries(sent);
  };

  // A path glob reaches only its mount, as a path under it, while a basename
  // glob reaches every mount as written.
  assert.deepEqual(await globsSent("", ["data/src/**", "*.ts", "!cache/tmp/**"]), {
    data: ["src/**", "*.ts"],
    cache: ["*.ts", "!tmp/**"],
    logs: ["*.ts"],
  });
  // Left without a `/`, these would match at any depth, so they're anchored.
  assert.deepEqual(await globsSent("", ["/data/*.csv", "data/*.json"]), { data: ["/*.csv", "/*.json"] });
  // The first component may itself be a glob.
  assert.deepEqual(await globsSent("", ["*/src/**"]), { data: ["src/**"], cache: ["src/**"], logs: ["src/**"] });
  assert.deepEqual(await globsSent("", ["{data,logs}/src/**"]), { data: ["src/**"], logs: ["src/**"] });
  assert.deepEqual(await globsSent("", ["[cd]a*/src/**"]), { data: ["src/**"], cache: ["src/**"] });
  // A leading ** can also start at the mount's own name.
  assert.deepEqual(await globsSent("", ["**/logs/*.txt"]), {
    data: ["**/logs/*.txt"],
    cache: ["**/logs/*.txt"],
    logs: ["**/logs/*.txt", "/*.txt"],
  });
  // A mount no include glob can match under isn't searched, nor is one whose
  // directory an exclude glob matches last.
  assert.deepEqual(await globsSent("", ["data/**"]), { data: ["/**"] });
  for (const glob of ["!logs", "!logs/", "!/logs"]) {
    assert.equal("logs" in (await globsSent("", [glob])), false, glob);
  }
  assert.deepEqual(await globsSent("", ["!**"]), {});
  assert.deepEqual(await globsSent("", ["!l*", "logs"]), {
    data: ["!l*", "logs"],
    cache: ["!l*", "logs"],
    logs: ["!l*", "logs"],
  });
  // Globs it can't take apart go to every mount as written.
  const unsplittable = ["{data/src,cache}/**", "[", ""];
  assert.deepEqual(await globsSent("", unsplittable), { data: unsplittable, cache: unsplittable, logs: unsplittable });
  // Below the root, globs are already relative to the disk's directory.
  assert.deepEqual(await globsSent("data/src", ["lib/**"]), { data: ["lib/**"] });
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
