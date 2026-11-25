import assert from "node:assert/strict";
import { test } from "vitest";
import { LoginDeniedError, startLoginSession } from "../src/cli/login.js";

const CONSOLE = "https://console.example.com";

async function post(url: string, fields: Record<string, string>, origin = CONSOLE) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: origin },
    body: new URLSearchParams(fields),
  });
  return { status: response.status, body: await response.text() };
}

function callbackOf(sessionUrl: string): { callback: string; state: string } {
  const params = new URL(sessionUrl).searchParams;
  return { callback: `http://127.0.0.1:${params.get("port")}/callback`, state: params.get("state")! };
}

test("the sign-in link carries a loopback port, a random state, and the machine name", async () => {
  const session = await startLoginSession({ console: CONSOLE, machine: "box" });
  const url = new URL(session.url);
  assert.equal(url.origin + url.pathname, `${CONSOLE}/cli/login`);
  assert.match(url.searchParams.get("state")!, /^[0-9a-f]{64}$/);
  assert.equal(url.searchParams.get("hostname"), "box");
  session.close();
  await assert.rejects(session.grant, /cancelled/);
});

test("only a matching state from the console's origin completes the sign-in", async () => {
  const session = await startLoginSession({ console: CONSOLE });
  const { callback, state } = callbackOf(session.url);

  assert.equal((await post(callback, { state: "0".repeat(64), apiKey: "key-x", region: "r" })).status, 400);
  assert.equal((await post(callback, { state, apiKey: "key-x", region: "r" }, "https://evil.example")).status, 403);
  assert.equal((await fetch(callback.replace("/callback", "/"))).status, 404);

  const approved = await post(callback, {
    state,
    apiKey: "key-abc",
    region: "aws-us-east-1",
    keyId: "tok-1",
    account: "Acme",
    baseUrl: "https://control.example.com",
  });
  assert.equal(approved.status, 200);
  assert.match(approved.body, /You&#39;re signed in/);
  assert.deepEqual(await session.grant, {
    apiKey: "key-abc",
    region: "aws-us-east-1",
    keyId: "tok-1",
    account: "Acme",
    baseUrl: "https://control.example.com",
  });
});

test("a cancelled approval rejects without a key", async () => {
  const session = await startLoginSession({ console: CONSOLE });
  const { callback, state } = callbackOf(session.url);
  const denied = await post(callback, { state, error: "access_denied" });
  assert.equal(denied.status, 200);
  await assert.rejects(session.grant, LoginDeniedError);
});

test("the session times out", async () => {
  const session = await startLoginSession({ console: CONSOLE, timeoutMs: 20 });
  await assert.rejects(session.grant, /Timed out/);
});
