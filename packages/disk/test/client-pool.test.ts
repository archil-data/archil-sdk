import { test } from "vitest";
import assert from "node:assert/strict";
import { Archil } from "../src/index.js";

type RequestInitWithDispatcher = RequestInit & { dispatcher?: unknown };

test("control-plane clients share an HTTP dispatcher by origin and API key", async () => {
  const originalFetch = globalThis.fetch;
  const dispatchers: unknown[] = [];

  globalThis.fetch = async (_input, init) => {
    dispatchers.push((init as RequestInitWithDispatcher | undefined)?.dispatcher);
    return new Response(JSON.stringify({ success: true, data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const first = new Archil({
      apiKey: "key-shared",
      region: "aws-us-east-1",
      baseUrl: "https://control.example.test/api",
    });
    const second = new Archil({
      apiKey: "shared",
      region: "aws-us-east-1",
      baseUrl: "https://control.example.test/other-path",
    });

    await Promise.all([first.tokens.list(), second.tokens.list()]);

    assert.ok(dispatchers[0], "expected the Node fetch path to receive a dispatcher");
    assert.equal(dispatchers[0], dispatchers[1], "same origin and API key should share a dispatcher");

    const differentCredential = new Archil({
      apiKey: "key-other",
      region: "aws-us-east-1",
      baseUrl: "https://control.example.test",
    });
    await differentCredential.tokens.list();
    assert.notEqual(dispatchers[0], dispatchers[2], "different API keys should use isolated dispatchers");

    const differentOrigin = new Archil({
      apiKey: "key-shared",
      region: "aws-us-east-1",
      baseUrl: "https://other-control.example.test",
    });
    await differentOrigin.tokens.list();
    assert.notEqual(dispatchers[0], dispatchers[3], "different origins should use isolated dispatchers");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
