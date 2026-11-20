type OutputEvent = "drain" | "close" | "error";

/** Where the CLI copies process output; Node's stdout and stderr fit. */
export interface OutputStream {
  write(data: string | Uint8Array): unknown;
  on?(event: OutputEvent, listener: (error?: unknown) => void): unknown;
  off?(event: OutputEvent, listener: (error?: unknown) => void): unknown;
}

/**
 * Writes `data`, then waits while the stream is full. A stream that closes or
 * fails never emits `drain`, so either ends the wait with an error instead.
 */
export async function writeOutput(stream: OutputStream, data: Uint8Array): Promise<void> {
  if (stream.write(data) !== false || !stream.on || !stream.off) return;
  const { on, off } = { on: stream.on.bind(stream), off: stream.off.bind(stream) };
  await new Promise<void>((resolve, reject) => {
    const drained = () => { remove(); resolve(); };
    const closed = () => { remove(); reject(new Error("Output stream closed")); };
    const failed = (error?: unknown) => {
      remove();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const remove = () => { off("drain", drained); off("close", closed); off("error", failed); };
    on("drain", drained);
    on("close", closed);
    on("error", failed);
  });
}
