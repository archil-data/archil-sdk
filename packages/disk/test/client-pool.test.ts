import { test } from "vitest";
import assert from "node:assert/strict";
import type { Dispatcher } from "undici";
import { Archil } from "../src/index.js";
import { bufferRequestBodies } from "../src/client.js";
import { json, startOrigin } from "./helpers/origin.js";

test("control-plane clients share one connection per origin and API key", async () => {
  const control = await startOrigin(() => json({ success: true, data: [] }));
  try {
    const first = new Archil({
      apiKey: "key-shared",
      region: "aws-us-east-1",
      baseUrl: `${control.url}/api`,
    });
    const second = new Archil({
      apiKey: "shared",
      region: "aws-us-east-1",
      baseUrl: `${control.url}/other-path`,
    });
    await first.tokens.list();
    await second.tokens.list();
    assert.equal(control.connections, 1, "same origin and API key should share a connection");
    assert.deepEqual(
      control.requests.map((request) => request.headers.get("authorization")),
      ["key-shared", "key-shared"],
    );

    const differentCredential = new Archil({
      apiKey: "key-other",
      region: "aws-us-east-1",
      baseUrl: control.url,
    });
    await differentCredential.tokens.list();
    assert.equal(control.connections, 2, "a different API key should use an isolated connection");
  } finally {
    await control.close();
  }
});

test("the transport buffers streaming bodies so Undici can replay a GOAWAY-refused request", async () => {
  let dispatchedOptions: Dispatcher.DispatchOptions | undefined;
  let resolveDispatched!: () => void;
  const dispatched = new Promise<void>((resolve) => {
    resolveDispatched = resolve;
  });
  const dispatch: Dispatcher.Dispatch = (options) => {
    dispatchedOptions = options;
    resolveDispatched();
    return true;
  };

  const accepted = bufferRequestBodies(dispatch)({
    origin: "https://control.example.test",
    path: "/api/disks/dsk-test/exec",
    method: "POST",
    body: (async function* () {
      yield Buffer.from("first");
      yield Buffer.from("-second");
    })() as unknown as Dispatcher.DispatchOptions["body"],
  }, {});

  assert.equal(accepted, true);
  await dispatched;
  assert.ok(Buffer.isBuffer(dispatchedOptions?.body));
  assert.equal((dispatchedOptions?.body as Buffer).toString(), "first-second");
  assert.equal(dispatchedOptions?.idempotent, undefined, "idempotency is left to the request method");
});

test("the transport passes non-streaming bodies through untouched", () => {
  let dispatchedOptions: Dispatcher.DispatchOptions | undefined;
  const dispatch: Dispatcher.Dispatch = (options) => {
    dispatchedOptions = options;
    return true;
  };
  const body = Buffer.from("payload");
  bufferRequestBodies(dispatch)({ origin: "https://control.example.test", path: "/api/exec", method: "POST", body }, {});
  assert.equal(dispatchedOptions?.body, body);
});
