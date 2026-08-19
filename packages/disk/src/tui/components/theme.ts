export const bold = (text: string): string => `\x1b[1m${text}\x1b[22m`;
export const dim = (text: string): string => `\x1b[2m${text}\x1b[22m`;
export const cyan = (text: string): string => `\x1b[36m${text}\x1b[39m`;
export const green = (text: string): string => `\x1b[32m${text}\x1b[39m`;
export const yellow = (text: string): string => `\x1b[33m${text}\x1b[39m`;
export const red = (text: string): string => `\x1b[31m${text}\x1b[39m`;

export function statusColor(status: string, text: string): string {
  if (status === "running" || status === "completed") return green(text);
  if (status === "failed" || status === "exited") return red(text);
  if (status === "pending" || status === "pausing" || status === "stopping" || status === "deleting") return yellow(text);
  return dim(text);
}
