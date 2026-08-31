import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { retryApiRequest } from "../src/retry.js";

function result(status: number) {
  return { response: new Response(null, { status }) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

test("transient retries transport errors and retryable responses", async () => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  let attempts = 0;

  const response = await retryApiRequest(async () => {
    attempts++;
    if (attempts === 1) throw new TypeError("fetch failed");
    return result(attempts === 2 ? 503 : 200);
  }, "transient");

  assert.equal(response.response.status, 200);
  assert.equal(attempts, 3);
});

test("transient does not retry caller errors", async () => {
  let attempts = 0;

  const response = await retryApiRequest(async () => {
    attempts++;
    return result(409);
  }, "transient");

  assert.equal(response.response.status, 409);
  assert.equal(attempts, 1);
});

test("connect retries only connection-establishment failures", async () => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  let attempts = 0;
  const connectionError = new TypeError("fetch failed", {
    cause: Object.assign(new Error("connection timed out"), {
      code: "UND_ERR_CONNECT_TIMEOUT",
    }),
  });

  const response = await retryApiRequest(async () => {
    attempts++;
    if (attempts === 1) throw connectionError;
    return result(200);
  }, "connect");

  assert.equal(response.response.status, 200);
  assert.equal(attempts, 2);

  attempts = 0;
  await assert.rejects(
    retryApiRequest(async () => {
      attempts++;
      throw new TypeError("ambiguous transport failure");
    }, "connect"),
    /ambiguous transport failure/,
  );
  assert.equal(attempts, 1);

  attempts = 0;
  const unavailable = await retryApiRequest(async () => {
    attempts++;
    return result(503);
  }, "connect");
  assert.equal(unavailable.response.status, 503);
  assert.equal(attempts, 1);
});

test("transient stops after the shared retry budget", async () => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  let attempts = 0;

  const response = await retryApiRequest(async () => {
    attempts++;
    return result(503);
  }, "transient");

  assert.equal(response.response.status, 503);
  assert.equal(attempts, 4);
});
