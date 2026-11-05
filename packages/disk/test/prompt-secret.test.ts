// The interactive API-key prompt reads a TTY in raw mode: it masks input,
// honors backspace, re-asks after an invalid key, and cancels on Ctrl-C.

import { EventEmitter } from "node:events";
import { test } from "vitest";
import assert from "node:assert/strict";
import { promptSecret } from "../src/cli/credentials.js";

function fakeTty(...keystrokes: string[]) {
  const input = Object.assign(new EventEmitter(), {
    isTTY: true,
    isRaw: false,
    rawModes: [] as boolean[],
    setRawMode(mode: boolean) {
      input.isRaw = mode;
      input.rawModes.push(mode);
    },
    resume() {
      queueMicrotask(() => {
        for (const keys of keystrokes) input.emit("data", Buffer.from(keys));
      });
    },
    pause() {},
    async *[Symbol.asyncIterator]() {},
  });
  let written = "";
  const output = { write: (value: string) => { written += value; } };
  return { input, output, written: () => written };
}

test("masks input, applies backspace, and restores the terminal mode", async () => {
  const tty = fakeTty("key-ab", "x\x7f", "c\r");
  assert.equal(await promptSecret("API key: ", tty.input, tty.output), "key-abc");
  assert.equal(tty.written().includes("key-abc"), false);
  assert.deepEqual(tty.input.rawModes, [true, false]);
});

test("re-asks after an invalid key", async () => {
  const tty = fakeTty("\r", "key-ok\r");
  assert.equal(await promptSecret("API key: ", tty.input, tty.output), "key-ok");
  assert.match(tty.written(), /API key is empty\nAPI key: /);
});

test("Ctrl-C cancels", async () => {
  const tty = fakeTty("key\x03");
  await assert.rejects(promptSecret("API key: ", tty.input, tty.output), /cancelled/);
  assert.deepEqual(tty.input.rawModes, [true, false]);
});
