const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const visible = (text: string) => text.replace(ANSI, "").length;
const pad = (text: string, width: number) => text + " ".repeat(Math.max(0, width - visible(text)));

/** Renders a boxed table; cells may contain ANSI colors, which don't count toward widths. */
export function renderTable(rows: string[][], headers?: string[]): string {
  const all = headers ? [headers, ...rows] : rows;
  if (all.length === 0) return "";
  const columnCount = Math.max(...all.map((row) => row.length));
  const widths = Array.from({ length: columnCount }, (_, index) =>
    Math.max(...all.map((row) => visible(row[index] ?? ""))),
  );
  const border = (left: string, middle: string, right: string) =>
    left + widths.map((width) => "─".repeat(width + 2)).join(middle) + right;
  const line = (row: string[]) =>
    "│ " + widths.map((width, index) => pad(row[index] ?? "", width)).join(" │ ") + " │";
  const output = [border("╭", "┬", "╮")];
  if (headers) output.push(line(headers), border("├", "┼", "┤"));
  output.push(...rows.map(line), border("╰", "┴", "╯"));
  return output.join("\n");
}
