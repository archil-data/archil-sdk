import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { Sandbox, SandboxExec } from "../sandbox.js";

export const MAX_EXEC_OUTPUT_CHARS = 256 * 1024;

export function sanitizeRemoteOutput(value: string, cap = MAX_EXEC_OUTPUT_CHARS): { text: string; truncated: boolean } {
  const safe = stripTerminalSequences(value)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "�");
  if (safe.length <= cap) return { text: safe, truncated: false };
  return { text: `${safe.slice(0, cap)}\n… output truncated at ${cap} characters …`, truncated: true };
}

export interface ExecSnapshot {
  execs: readonly SandboxExec[];
  selected?: SandboxExec;
  loading: boolean;
  error?: string;
}

export class ExecModel {
  private execs: SandboxExec[] = [];
  private selectedId?: string;
  private loading = false;
  private error?: string;
  private loadPromise?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly sandbox: Sandbox, private readonly pollIntervalMs = 1_000) {}

  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  snapshot(): ExecSnapshot {
    return { execs: this.execs, selected: this.execs.find(({ id }) => id === this.selectedId), loading: this.loading, error: this.error };
  }

  async load(): Promise<void> {
    if (this.loadPromise) return this.loadPromise;
    this.loading = true;
    this.emit();
    this.loadPromise = (async () => {
      try {
        this.execs = (await this.sandbox.listExecs()).sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime() || a.id.localeCompare(b.id));
        if (!this.execs.some(({ id }) => id === this.selectedId)) this.selectedId = this.execs[0]?.id;
        this.error = undefined;
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
      } finally {
        this.loading = false;
        this.loadPromise = undefined;
        this.emit();
      }
    })();
    return this.loadPromise;
  }

  startPolling(): void {
    this.stopped = false;
    void this.load().then(() => this.schedule());
  }

  stopPolling(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  selectOffset(offset: number): void {
    if (!this.execs.length) return;
    const index = Math.max(0, this.execs.findIndex(({ id }) => id === this.selectedId));
    this.selectedId = this.execs[Math.max(0, Math.min(this.execs.length - 1, index + offset))]?.id;
    this.emit();
  }

  async submit(command: string): Promise<boolean> {
    if (this.sandbox.status !== "running") return false;
    try {
      const execution = await this.sandbox.exec(command, { wait: false });
      this.selectedId = execution.id;
      await this.load();
      return true;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      this.emit();
      return false;
    }
  }

  async detail(): Promise<SandboxExec | undefined> {
    const selected = this.snapshot().selected;
    if (!selected) return undefined;
    try {
      return await this.sandbox.getExec(selected.id);
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      this.emit();
      return undefined;
    }
  }

  async cancel(): Promise<boolean> {
    const selected = this.snapshot().selected;
    if (!selected || selected.status !== "running") return false;
    try {
      await selected.cancel();
      await this.load();
      return true;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      this.emit();
      return false;
    }
  }

  private schedule(): void {
    if (this.stopped || !this.execs.some(({ status }) => status === "running")) return;
    this.timer = setTimeout(async () => { await this.load(); this.schedule(); }, this.pollIntervalMs);
  }

  private emit(): void { for (const listener of this.listeners) listener(); }
}
