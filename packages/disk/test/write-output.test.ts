import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "vitest";
import { writeOutput } from "../src/cli/write-output.js";

class FullOutput extends EventEmitter {
  write() { return false; }
}

test("a full output resumes on drain", async () => {
  const output = new FullOutput();
  const written = writeOutput(output, new Uint8Array([1]));
  output.emit("drain");
  await written;
  assert.equal(output.listenerCount("close"), 0);
});

test("a full output that closes instead of draining fails the write", async () => {
  const output = new FullOutput();
  const written = writeOutput(output, new Uint8Array([1]));
  output.emit("close");
  await assert.rejects(written, /Output stream closed/);
  assert.equal(output.listenerCount("drain"), 0);
});

test("a full output that errors fails the write with its error", async () => {
  const output = new FullOutput();
  const written = writeOutput(output, new Uint8Array([1]));
  output.emit("error", new Error("EPIPE"));
  await assert.rejects(written, /EPIPE/);
});
