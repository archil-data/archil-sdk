interface SpinnerOutput {
  write(data: string): unknown;
}

const FRAMES = ["◒", "◐", "◓", "◑"];
const CLEAR_LINE = "\r\x1b[2K";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

/** A single-line progress spinner for a TTY stream. */
export function spinner(output: SpinnerOutput) {
  let timer: ReturnType<typeof setInterval> | undefined;

  const finish = (line: string) => {
    if (timer === undefined) return;
    clearInterval(timer);
    timer = undefined;
    output.write(`${CLEAR_LINE}${line}${SHOW_CURSOR}`);
  };

  return {
    start(label: string): void {
      let frame = 0;
      const draw = () => output.write(`${CLEAR_LINE}${FRAMES[frame++ % FRAMES.length]} ${label}`);
      output.write(HIDE_CURSOR);
      draw();
      timer = setInterval(draw, 80);
    },
    stop(message: string): void {
      finish(`◇ ${message}\n`);
    },
    error(message: string): void {
      finish(`■ ${message}\n`);
    },
    clear(): void {
      finish("");
    },
  };
}
