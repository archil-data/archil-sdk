import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { ExecSnapshot } from "../exec-model.js";
import { safeCell } from "./sandbox-table.js";

function pad(value: unknown, width: number): string {
  const text = truncateToWidth(safeCell(value), width, "…");
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

export function execDuration(startedAt: Date, finishedAt?: Date): string {
  if (!finishedAt) return "running";
  const milliseconds = Math.max(0, finishedAt.getTime() - startedAt.getTime());
  return milliseconds < 1000 ? `${milliseconds}ms` : `${(milliseconds / 1000).toFixed(1)}s`;
}

export class ExecTable implements Component {
  constructor(private readonly snapshot: () => ExecSnapshot) {}
  render(width: number): string[] {
    const state = this.snapshot();
    if (!state.execs.length) return [truncateToWidth(state.error ?? (state.loading ? "Loading exec history…" : "No durable exec history."), width)];
    const commandWidth = Math.max(12, width - 48);
    const row = (values: unknown[]) => truncateToWidth([
      pad(values[0], commandWidth), pad(values[1], 11), pad(values[2], 6), pad(values[3], 10), pad(values[4], 8),
    ].join(" "), width, "");
    return [row(["COMMAND", "STATUS", "EXIT", "STARTED", "DURATION"]), ...state.execs.map((execution) => row([
      `${execution.id === state.selected?.id ? ">" : " "}${execution.command}`,
      execution.status,
      execution.exitCode ?? "-",
      execution.startedAt.toLocaleTimeString(),
      execDuration(execution.startedAt, execution.finishedAt),
    ]))];
  }
  invalidate(): void {}
}
