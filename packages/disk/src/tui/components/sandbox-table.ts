import { stripTerminalSequences, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { SandboxModelSnapshot } from "../model.js";
import { bold, cyan, dim, statusColor } from "./theme.js";

export function safeCell(value: unknown): string {
  return stripTerminalSequences(String(value ?? "")).replace(/[\x00-\x1f\x7f]/g, " ");
}

function pad(value: string, width: number): string {
  const text = truncateToWidth(safeCell(value), width, "…");
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function age(date?: Date): string {
  if (!date) return "-";
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

export class SandboxTable implements Component {
  constructor(private readonly getSnapshot: () => SandboxModelSnapshot) {}

  render(width: number): string[] {
    if (width <= 0) return [];
    const snapshot = this.getSnapshot();
    if (snapshot.visibleSandboxes.length === 0) {
      return [dim(truncateToWidth(snapshot.filter ? `No sandboxes match '${safeCell(snapshot.filter)}'. Press / to change the filter.` : "No sandboxes found. Press r to refresh.", width))];
    }
    const wide = width >= 105;
    const normal = width >= 72;
    const flexibleWidth = width - 45;
    const nameWidth = Math.floor(flexibleWidth / 2);
    const fields: Array<[string, number]> = wide
      ? [["NAME", nameWidth], ["STATUS", 11], ["CPU", 4], ["MEM", 8], ["IMAGE", flexibleWidth - nameWidth], ["ACTIVE", 8], ["EXPIRES", 8]]
      : normal
        ? [["NAME", Math.max(16, width - 49)], ["STATUS", 11], ["CPU", 4], ["MEM", 8], ["ACTIVE", 8]]
        : [["NAME", Math.max(10, width - 17)], ["STATUS", 12]];
    const line = (values: string[], selected = false, status?: string) => truncateToWidth(values.map((value, index) => {
      const cell = pad(value, fields[index]![1]);
      if (index === 0 && selected) return bold(cyan(cell));
      if (index === 1 && status) return statusColor(status, cell);
      return cell;
    }).join(" "), width, "");
    const rows = [bold(dim(line(fields.map(([name]) => name)))), dim("─".repeat(width))];
    for (const sandbox of snapshot.visibleSandboxes) {
      const selected = sandbox.id === snapshot.selectedId;
      const marker = selected ? "▸" : " ";
      const busy = snapshot.busyIds.has(sandbox.id) ? " …" : "";
      const values = wide
        ? [`${marker} ${sandbox.name}`, `${sandbox.status}${busy}`, String(sandbox.vcpuCount), `${sandbox.memSizeMiB}MiB`, sandbox.baseImage, age(sandbox.lastActiveAt), sandbox.expiresAt ? age(sandbox.expiresAt) : "-"]
        : normal
          ? [`${marker} ${sandbox.name}`, `${sandbox.status}${busy}`, String(sandbox.vcpuCount), `${sandbox.memSizeMiB}MiB`, age(sandbox.lastActiveAt)]
          : [`${marker} ${sandbox.name}`, `${sandbox.status}${busy}`];
      rows.push(line(values, selected, sandbox.status));
    }
    return rows;
  }

  invalidate(): void {}
}
