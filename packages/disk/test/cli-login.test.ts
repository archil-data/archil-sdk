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
  const defaultKey = { apiKey: "key-abc", region: "aws-us-east-1", keyId: "tok-1", baseUrl: "https://control.example.com" };
  assert.deepEqual(await session.grant, { ...defaultKey, account: "Acme", accountId: undefined, keys: [defaultKey] });
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

test("an HTTPS console's callback arrives with Origin: null and is accepted", async () => {
  // Browsers send `Origin: null` for a form POST from an HTTPS page to http://127.0.0.1.
  const session = await startLoginSession({ console: "https://console.example.com" });
  const { callback, state } = callbackOf(session.url);
  const approved = await post(callback, { state, apiKey: "key-abc", region: "aws-us-east-1" }, "null");
  assert.equal(approved.status, 200);
  assert.equal((await session.grant).apiKey, "key-abc");
});

test("a foreign origin is still turned away even with Origin: null allowed", async () => {
  const session = await startLoginSession({ console: CONSOLE });
  const { callback, state } = callbackOf(session.url);
  assert.equal((await post(callback, { state, apiKey: "key-x", region: "r" }, "https://evil.example")).status, 403);
  session.close();
  await assert.rejects(session.grant, /cancelled/);
});

test("the listener drops a browser's keep-alive connection so the CLI can exit", async () => {
  const { request } = await import("node:http");
  const session = await startLoginSession({ console: CONSOLE });
  const { callback, state } = callbackOf(session.url);
  const agent = new (await import("node:http")).Agent({ keepAlive: true });
  const closed = new Promise<void>((resolve) => {
    const req = request(callback, { method: "POST", agent, headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: CONSOLE } }, (res) => {
      assert.equal(res.headers.connection, "close");
      res.resume();
      res.socket.once("close", () => resolve());
    });
    req.end(new URLSearchParams({ state, apiKey: "key-abc", region: "r" }).toString());
  });
  await session.grant;
  await closed;
  agent.destroy();
});
