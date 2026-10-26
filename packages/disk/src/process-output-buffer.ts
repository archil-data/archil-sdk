import type { SandboxProcessOutput } from "./sandbox-process.js";

/**
 * Output each process has received but its iterator has not taken yet.
 * Flow control bounds it to one channel window per process, so it never
 * needs to refuse output. Output a handle never reads goes with the handle.
 */
export class ProcessOutputBuffer {
  private readonly queues = new WeakMap<object, SandboxProcessOutput[]>();

  has(subscription: object): boolean { return !!this.queues.get(subscription)?.length; }
  push(subscription: object, output: SandboxProcessOutput): void {
    const queue = this.queues.get(subscription) ?? [];
    queue.push(output);
    this.queues.set(subscription, queue);
  }
  take(subscription: object): SandboxProcessOutput | undefined {
    const queue = this.queues.get(subscription);
    const output = queue?.shift();
    if (queue && !queue.length) this.queues.delete(subscription);
    return output;
  }
  discard(subscription: object): void { this.queues.delete(subscription); }
}
