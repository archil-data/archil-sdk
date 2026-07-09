// Unit tests for disk-list pagination. `list()` follows the envelope's
// `nextCursor` so the default path fetches bounded pages instead of one
// unbounded request; `listPage()` exposes a single page for manual walks.

import { test } from "vitest";
import assert from "node:assert/strict";
import { Disks } from "../src/disks.js";
import type { ApiClient } from "../src/client.js";

type Query = { limit?: number; cursor?: string; name?: string };

type Page = { data: unknown[] | null; nextCursor?: string };

function diskJson(i: number) {
  return {
    id: `dsk-${i}`,
    name: `d${i}`,
    organization: "org",
    status: "available",
    provider: "aws",
    region: "aws-us-east-1",
    createdAt: "2026-01-01T00:00:00Z",
  };
}

function fakeClient(pages: Map<string | undefined, Page>): {
  client: ApiClient;
  queries: Query[];
} {
  const queries: Query[] = [];
  const client = {
    GET: async (_path: string, opts: { params: { query: Query } }) => {
      const query = opts.params.query;
      queries.push(query);
      const page = pages.get(query.cursor);
      assert.ok(page, `no fake page for cursor ${query.cursor}`);
      return {
        data: { success: true, data: page.data, nextCursor: page.nextCursor },
        response: new Response(null, { status: 200 }),
      };
    },
  } as unknown as ApiClient;
  return { client, queries };
}

function disks(pages: Map<string | undefined, Page>) {
  const { client, queries } = fakeClient(pages);
  return { disks: new Disks(client, "aws-us-east-1"), queries };
}

test("list() follows nextCursor until exhausted", async () => {
  const { disks: d, queries } = disks(
    new Map([
      [undefined, { data: [diskJson(1), diskJson(2)], nextCursor: "c1" }],
      ["c1", { data: [diskJson(3)] }],
    ]),
  );
  const result = await d.list();
  assert.deepEqual(result.map((x) => x.id), ["dsk-1", "dsk-2", "dsk-3"]);
  assert.deepEqual(queries, [
    { limit: 100, cursor: undefined, name: undefined },
    { limit: 100, cursor: "c1", name: undefined },
  ]);
});

test("list() limit spans pages and requests only what remains", async () => {
  const { disks: d, queries } = disks(
    new Map([
      [undefined, { data: [diskJson(1), diskJson(2)], nextCursor: "c1" }],
      ["c1", { data: [diskJson(3), diskJson(4)], nextCursor: "c2" }],
    ]),
  );
  const result = await d.list({ limit: 3 });
  assert.deepEqual(result.map((x) => x.id), ["dsk-1", "dsk-2", "dsk-3"]);
  assert.equal(queries.length, 2);
  assert.equal(queries[0].limit, 3);
  assert.equal(queries[1].limit, 1);
});

test("list() caps the total when the server ignores limit", async () => {
  const { disks: d } = disks(
    new Map([[undefined, { data: [diskJson(1), diskJson(2), diskJson(3)] }]]),
  );
  const result = await d.list({ limit: 2 });
  assert.deepEqual(result.map((x) => x.id), ["dsk-1", "dsk-2"]);
});

test("list() terminates on a repeated cursor", async () => {
  const { disks: d, queries } = disks(
    new Map([
      [undefined, { data: [diskJson(1)], nextCursor: "same" }],
      ["same", { data: [diskJson(2)], nextCursor: "same" }],
    ]),
  );
  await d.list();
  assert.equal(queries.length, 2);
});

test("list({name}) is a single request even when nextCursor is present", async () => {
  const { disks: d, queries } = disks(
    new Map([[undefined, { data: [diskJson(1)], nextCursor: "c1" }]]),
  );
  const result = await d.list({ name: "d1" });
  assert.deepEqual(result.map((x) => x.id), ["dsk-1"]);
  assert.equal(queries.length, 1);
  assert.equal(queries[0].name, "d1");
});

test("listPage() returns the page and its nextCursor", async () => {
  const { disks: d } = disks(
    new Map([
      [undefined, { data: [diskJson(1), diskJson(2)], nextCursor: "c1" }],
      ["c1", { data: [diskJson(3)] }],
    ]),
  );
  const first = await d.listPage({ limit: 2 });
  assert.deepEqual(first.disks.map((x) => x.id), ["dsk-1", "dsk-2"]);
  assert.equal(first.nextCursor, "c1");
  const last = await d.listPage({ limit: 2, cursor: first.nextCursor });
  assert.deepEqual(last.disks.map((x) => x.id), ["dsk-3"]);
  assert.equal(last.nextCursor, undefined);
});

test("listPage() treats JSON null data as an empty account", async () => {
  const { disks: d } = disks(new Map([[undefined, { data: null }]]));
  const page = await d.listPage();
  assert.deepEqual(page.disks, []);
  assert.equal(page.nextCursor, undefined);
});
