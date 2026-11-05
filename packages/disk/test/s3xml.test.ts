// The S3 gateway's XML responses are parsed by a small in-house reader, so its
// entity decoding and array shaping are pinned here.

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
