export function renderTable(rows: string[][], headers?: string[]): string {
  const all = headers ? [headers, ...rows] : rows;
  if (all.length === 0) return "";
  const columnCount = Math.max(...all.map((row) => row.length));
  const widths = Array.from({ length: columnCount }, (_, index) =>
    Math.max(...all.map((row) => (row[index] ?? "").length)),
  );
  const border = (left: string, middle: string, right: string) =>
    left + widths.map((width) => "─".repeat(width + 2)).join(middle) + right;
  const line = (row: string[]) =>
    "│ " + widths.map((width, index) => (row[index] ?? "").padEnd(width)).join(" │ ") + " │";
  const output = [border("╭", "┬", "╮")];
  if (headers) output.push(line(headers), border("├", "┼", "┤"));
  output.push(...rows.map(line), border("╰", "┴", "╯"));
  return output.join("\n");
}
