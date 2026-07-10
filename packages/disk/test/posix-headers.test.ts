import { test } from "vitest";
import assert from "node:assert/strict";
import { posixCreateHeaders } from "../src/disk.js";

test("posixCreateHeaders omits unset fields", () => {
  assert.equal(posixCreateHeaders({}), undefined);
  assert.deepEqual(posixCreateHeaders({ mode: 0o644 }), { "x-archil-mode": "644" });
  assert.deepEqual(posixCreateHeaders({ uid: 1000, gid: 1000 }), {
    "x-archil-uid": "1000",
    "x-archil-gid": "1000",
  });
});

test("posixCreateHeaders encodes mode as octal without 0o prefix", () => {
  assert.deepEqual(posixCreateHeaders({ mode: 0o640, uid: 1000, gid: 1000 }), {
    "x-archil-mode": "640",
    "x-archil-uid": "1000",
    "x-archil-gid": "1000",
  });
  assert.deepEqual(posixCreateHeaders({ mode: 0o600 }), { "x-archil-mode": "600" });
});
