import type { SandboxProcessOutput } from "./sandbox-process.js";

const HIGH_WATER_BYTES = 4 * 1024 * 1024;
const LOW_WATER_BYTES = 2 * 1024 * 1024;
const MAX_BUFFERED_CHUNKS = 1024;

interface Subscription {
  _pauseOutput(): void;
  _resumeOutput(): void;
}

/** One shared budget for all process iterators belonging to a Sandbox. */
export class ProcessOutputBuffer {
  private readonly subscriptions = new Set<Subscription>();
  private readonly queues = new Map<Subscription, SandboxProcessOutput[]>();
  private bytes = 0;
  private chunks = 0;
  paused = false;

  add(subscription: Subscription): void {
    this.subscriptions.add(subscription);
    if (this.paused) subscription._pauseOutput();
  }
  remove(subscription: Subscription): void { this.subscriptions.delete(subscription); }
  has(subscription: Subscription): boolean { return !!this.queues.get(subscription)?.length; }
  /**
   * Credited output is already bounded by its channel's flow-control window,
   * so it is always accepted; it still counts toward pausing legacy sockets.
   */
  push(subscription: Subscription, output: SandboxProcessOutput, credited = false): boolean {
    if (!credited) {
      if (this.paused) return false;
      if (this.bytes + output.data.length > HIGH_WATER_BYTES || this.chunks >= MAX_BUFFERED_CHUNKS) {
        this.pause();
        return false;
      }
    }
    const queue = this.queues.get(subscription) ?? [];
    queue.push(output);
    this.queues.set(subscription, queue);
    this.bytes += output.data.length;
    this.chunks++;
    if (this.bytes >= HIGH_WATER_BYTES || this.chunks >= MAX_BUFFERED_CHUNKS) this.pause();
    return true;
  }
  take(subscription: Subscription): SandboxProcessOutput | undefined {
    const queue = this.queues.get(subscription);
    const output = queue?.shift();
    if (!output) return;
    if (!queue!.length) this.queues.delete(subscription);
    this.bytes -= output.data.length;
    this.chunks--;
    this.resume();
    return output;
  }
  discard(subscription: Subscription): void {
    const queue = this.queues.get(subscription);
    if (queue) {
      for (const output of queue) this.bytes -= output.data.length;
      this.chunks -= queue.length;
      this.queues.delete(subscription);
      this.resume();
    }
  }
  private pause(): void {
    this.paused = true;
    for (const subscription of this.subscriptions) subscription._pauseOutput();
  }
  private resume(): void {
    if (this.paused && this.bytes <= LOW_WATER_BYTES && this.chunks <= MAX_BUFFERED_CHUNKS / 2) {
      this.paused = false;
      for (const subscription of this.subscriptions) subscription._resumeOutput();
    }
  }
}
