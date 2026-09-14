import { test } from "vitest";
import assert from "node:assert/strict";
import type { Dispatcher } from "undici";
import { Archil } from "../src/index.js";
import { multiplexHttp2Requests } from "../src/client.js";

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

    const optionsSymbol = Object.getOwnPropertySymbols(dispatchers[0] as object)
      .find((symbol) => symbol.description === "options");
    assert.ok(optionsSymbol, "expected the Undici dispatcher to expose its configured options");
    const options = (dispatchers[0] as Record<symbol, {
      allowH2?: boolean;
      connections?: number;
      pipelining?: number;
    }>)[optionsSymbol];
    assert.equal(options.allowH2, true, "control-plane dispatcher should negotiate HTTP/2");
    assert.equal(options.connections, 1, "control-plane dispatcher should use one session per origin");
    assert.equal(options.pipelining, 100, "control-plane sessions should multiplex concurrent requests");

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

test("HTTP/2 transport buffers fetch bodies for multiplexing and prevents replay", async () => {
  let dispatchedOptions: Dispatcher.DispatchOptions | undefined;
  let forwardedStarts = 0;
  const aborts: Error[] = [];

  let resolveDispatched!: () => void;
  const dispatched = new Promise<void>((resolve) => {
    resolveDispatched = resolve;
  });
  const dispatch: Dispatcher.Dispatch = (options, handler) => {
    dispatchedOptions = options;
    const controller = {
      aborted: false,
      paused: false,
      reason: null,
      abort(error: Error) {
        aborts.push(error);
      },
      pause() {},
      resume() {},
    };
    handler.onRequestStart?.(controller, undefined);
    handler.onRequestStart?.(controller, undefined);
    resolveDispatched();
    return true;
  };

  const multiplex = multiplexHttp2Requests(dispatch);
  const accepted = multiplex({
    origin: "https://control.example.test",
    path: "/api/disks/dsk-test/exec",
    method: "POST",
    body: (async function* () {
      yield Buffer.from("first");
      yield Buffer.from("-second");
    })() as unknown as Dispatcher.DispatchOptions["body"],
  }, {
    onRequestStart() {
      forwardedStarts += 1;
    },
  });

  assert.equal(accepted, true);
  await dispatched;
  assert.equal(dispatchedOptions?.idempotent, true);
  assert.ok(Buffer.isBuffer(dispatchedOptions?.body));
  assert.equal((dispatchedOptions?.body as Buffer).toString(), "first-second");
  assert.equal(forwardedStarts, 1, "the first socket dispatch should reach the request handler");
  assert.equal(aborts.length, 1, "a second socket dispatch should be rejected as a replay");
  assert.match(aborts[0].message, /not replayed/);
});
