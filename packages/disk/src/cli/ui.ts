// Terminal presentation for the CLIs: progress steps with spinners, colors,
// and aligned summaries. Everything here writes to stderr-like streams and
// degrades to nothing (steps) or plain text (messages) when the stream isn't
// a terminal, so piped stdout stays clean and scripts see no escape codes.

export interface UiStream {
  write(data: string): unknown;
  isTTY?: boolean;
  columns?: number;
}

const ESC = "\x1b[";
const CLEAR_LINE = "\r\x1b[2K";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SHOW_ELAPSED_AFTER_MS = 1000;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

export function visibleLength(text: string): number {
  return text.replace(ANSI, "").length;
}

export function colorEnabled(stream: UiStream, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NO_COLOR) return false;
  if (env.FORCE_COLOR && env.FORCE_COLOR !== "0") return true;
  return Boolean(stream.isTTY) && env.TERM !== "dumb";
}

export function styles(enabled: boolean) {
  const wrap = (open: number, close: number) => (text: string) => enabled ? `${ESC}${open}m${text}${ESC}${close}m` : text;
  return {
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    underline: wrap(4, 24),
    red: wrap(31, 39),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    cyan: wrap(36, 39),
    magenta: wrap(35, 39),
  };
}

export type Styles = ReturnType<typeof styles>;

export function formatDuration(milliseconds: number): string {
  if (milliseconds < 1000) return `${Math.max(0, Math.round(milliseconds))}ms`;
  const seconds = milliseconds / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.floor(seconds % 60)}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export interface StepControls {
  /** Replace the running label, e.g. with a sub-status. */
  update(label: string): void;
}

export interface LiveLine {
  update(text: string): void;
  /** Clear the line, optionally leaving `final` in its place. */
  stop(final?: string): void;
}

export interface Ui {
  readonly interactive: boolean;
  readonly style: Styles;
  /**
   * Run `operation` behind a spinner labelled `label`; on success the line
   * becomes `✓ done` (the label unless given) with its duration. Without a
   * terminal the operation just runs.
   */
  step<T>(label: string, operation: (controls: StepControls) => Promise<T>, done?: string | ((result: T) => string)): Promise<T>;
  success(message: string): void;
  warn(message: string): void;
  info(message: string): void;
  /** Print `rows` as an indented, aligned `label  value` list. */
  details(rows: Array<[string, string]>): void;
  blank(): void;
  /** A status line redrawn in place until stopped (no-op without a terminal). */
  live(text: string): LiveLine;
}

export function createUi(stream: UiStream, options: { env?: NodeJS.ProcessEnv; now?: () => number } = {}): Ui {
  const interactive = Boolean(stream.isTTY);
  const style = styles(colorEnabled(stream, options.env));
  const now = options.now ?? Date.now;
  const symbol = {
    ok: style.green("✓"),
    fail: style.red("✗"),
    warn: style.yellow("!"),
    info: style.cyan("›"),
  };

  const fit = (text: string) => {
    const width = stream.columns ?? 0;
    if (width <= 0 || visibleLength(text) < width) return text;
    return `${text.replace(ANSI, "").slice(0, width - 2)}…`;
  };

  return {
    interactive,
    style,
    async step(label, operation, done) {
      if (!interactive) return operation({ update: () => {} });
      const started = now();
      let current = label;
      let frame = 0;
      const draw = () => {
        const elapsed = now() - started;
        const timer = elapsed >= SHOW_ELAPSED_AFTER_MS ? ` ${style.dim(formatDuration(elapsed))}` : "";
        stream.write(`${CLEAR_LINE}${fit(`${style.cyan(FRAMES[frame++ % FRAMES.length]!)} ${current}${timer}`)}`);
      };
      stream.write(HIDE_CURSOR);
      draw();
      const timer = setInterval(draw, 80);
      try {
        const result = await operation({ update: (next) => { current = next; draw(); } });
        const message = typeof done === "function" ? done(result) : done ?? current;
        stream.write(`${CLEAR_LINE}${symbol.ok} ${message} ${style.dim(formatDuration(now() - started))}\n`);
        return result;
      } catch (error) {
        stream.write(`${CLEAR_LINE}${symbol.fail} ${current}\n`);
        throw error;
      } finally {
        clearInterval(timer);
        stream.write(SHOW_CURSOR);
      }
    },
    success: (message) => { stream.write(`${symbol.ok} ${message}\n`); },
    warn: (message) => { stream.write(`${symbol.warn} ${message}\n`); },
    info: (message) => { stream.write(`${symbol.info} ${message}\n`); },
    details(rows) {
      const width = Math.max(...rows.map(([label]) => label.length));
      for (const [label, value] of rows) stream.write(`  ${style.dim(label.padEnd(width))}  ${value}\n`);
    },
    blank: () => { stream.write("\n"); },
    live(text) {
      if (!interactive) return { update: () => {}, stop: () => {} };
      let stopped = false;
      stream.write(HIDE_CURSOR);
      stream.write(`${CLEAR_LINE}${fit(text)}`);
      return {
        update(next) {
          if (!stopped) stream.write(`${CLEAR_LINE}${fit(next)}`);
        },
        stop(final) {
          if (stopped) return;
          stopped = true;
          stream.write(`${CLEAR_LINE}${final ? `${final}\n` : ""}${SHOW_CURSOR}`);
        },
      };
    },
  };
}

/** Colors for sandbox statuses in tables and summaries. */
export function statusStyle(style: Styles, status: string): string {
  switch (status) {
    case "running": return style.green(status);
    case "paused": return style.yellow(status);
    case "failed": return style.red(status);
    case "stopped":
    case "exited":
    case "deleted": return style.dim(status);
    default: return style.cyan(status);
  }
}

/** Prints an error as `✗ message`, with a hint for the common fixable cases. */
export function printError(error: unknown, stream: UiStream = process.stderr, commandName = "archil"): void {
  const style = styles(colorEnabled(stream));
  const status = typeof error === "object" && error !== null && "status" in error ? (error as { status?: number }).status : undefined;
  const message = error instanceof Error ? error.message : String(error);
  stream.write(`${style.red("✗")} ${message}${status ? style.dim(` (HTTP ${status})`) : ""}\n`);
  if (status === 401 || status === 403 || /Missing API key|Missing region/.test(message)) {
    stream.write(`  ${style.dim(`Sign in with ${style.bold("archil login")}, or set ARCHIL_API_KEY and ARCHIL_REGION.`)}\n`);
  } else if (/^error: (unknown|missing|too many|option)/.test(message)) {
    stream.write(`  ${style.dim(`See ${style.bold(`${commandName} --help`)}.`)}\n`);
  }
}
