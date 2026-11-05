// The S3 gateway's XML responses are parsed by a small in-house reader, so its
// entity decoding, array shaping, and handling of hostile input are pinned here.

import { test } from "vitest";
import assert from "node:assert/strict";
import { parseXml } from "../src/s3xml.js";

test("decodes named and numeric entities and CDATA in text", () => {
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    "<R><Key>a &amp; b &lt;c&gt; &quot;q&quot; &apos;s&apos; &#233; &#x1F600;</Key>" +
    "<Raw><![CDATA[x < y & z]]></Raw></R>";
  assert.deepEqual(parseXml(xml), {
    R: { Key: `a & b <c> "q" 's' é 😀`, Raw: "x < y & z" },
  });
});

test("listing entries are arrays even when there is only one", () => {
  const xml =
    '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
    "<Contents><Key>only</Key><Size>1</Size></Contents>" +
    "<CommonPrefixes><Prefix>dir/</Prefix></CommonPrefixes>" +
    "<Prefix/></ListBucketResult>";
  assert.deepEqual(parseXml(xml), {
    ListBucketResult: {
      Contents: [{ Key: "only", Size: "1" }],
      CommonPrefixes: [{ Prefix: "dir/" }],
      Prefix: "",
    },
  });
});

test("repeated tags collect into an array; single ones stay scalar", () => {
  const xml = "<DeleteResult><Deleted><Key>a</Key></Deleted><Deleted><Key>b</Key></Deleted>" +
    "<Error><Key>c</Key><Code>AccessDenied</Code></Error></DeleteResult>";
  assert.deepEqual(parseXml(xml), {
    DeleteResult: {
      Deleted: [{ Key: "a" }, { Key: "b" }],
      Error: { Key: "c", Code: "AccessDenied" },
    },
  });
});

test("blank input parses to an empty object and mismatched tags throw", () => {
  assert.deepEqual(parseXml("  "), {});
  assert.throws(() => parseXml("<a></b>"), /Malformed XML/);
  assert.throws(() => parseXml("<html><body>oops"), /Malformed XML/);
});

test("keeps leading and trailing spaces in values", () => {
  const xml = "<ListBucketResult><Contents><Key>  spaced name  </Key></Contents></ListBucketResult>";
  assert.deepEqual(parseXml(xml), { ListBucketResult: { Contents: [{ Key: "  spaced name  " }] } });
});

test("rejects DOCTYPE so no custom entities can be declared", () => {
  assert.throws(
    () => parseXml('<!DOCTYPE x [<!ENTITY a "aaaa">]><R><K>&a;</K></R>'),
    /DOCTYPE/,
  );
  assert.deepEqual(parseXml("<R><K>&a;</K></R>"), { R: { K: "&a;" } });
});

test("a __proto__ tag is an ordinary own property", () => {
  const parsed = parseXml("<R><__proto__><Contents>x</Contents></__proto__></R>") as {
    R: Record<string, unknown>;
  };
  assert.equal(Object.getPrototypeOf(parsed.R), Object.prototype);
  assert.deepEqual(Object.keys(parsed.R), ["__proto__"]);
  assert.equal(parsed.R.Contents, undefined);
});

test("unterminated markup fails fast instead of backtracking", () => {
  const start = performance.now();
  for (const hostile of ["<".repeat(200_000), "<a".repeat(200_000), "<!--".repeat(200_000), "&a".repeat(200_000)]) {
    try {
      parseXml(hostile);
    } catch {
      // Malformed input may throw; it just must not hang.
    }
  }
  assert.ok(performance.now() - start < 1000, "parsing hostile input took over a second");
});
