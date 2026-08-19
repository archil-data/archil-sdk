import {
  HStack,
  Input,
  Key,
  ScrollView,
  VStack,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
  wrapTextWithAnsi,
  type TUI,
} from "@earendil-works/pi-tui";
import { ACTIONS_BY_STATUS, parseCreateSandboxForm, type CreateSandboxForm, type SandboxAction } from "./actions.js";
import { ExecModel, sanitizeRemoteOutput } from "./exec-model.js";
import { SandboxModel, type SandboxSort } from "./model.js";
import { runShellHandoff } from "./shell.js";
import { ExecTable } from "./components/exec-table.js";
import { SandboxDetails } from "./components/sandbox-details.js";
import { SandboxTable, safeCell } from "./components/sandbox-table.js";
import { bold, cyan, dim, green, red, yellow } from "./components/theme.js";

class Line implements Component {
  constructor(private readonly value: () => string) {}
  render(width: number): string[] { return [truncateToWidth(this.value(), width, "…")]; }
  invalidate(): void {}
}

class Rule implements Component {
  render(width: number): string[] { return [dim("─".repeat(Math.max(0, width)))]; }
  invalidate(): void {}
}

class BottomBar implements Component {
  constructor(
    private readonly getFilterInput: () => Input | undefined,
    private readonly getHints: () => string,
  ) {}

  render(width: number): string[] {
    const input = this.getFilterInput();
    if (!input) return [truncateToWidth(dim(this.getHints()), width, "…")];
    const prefix = bold(cyan(" FILTER "));
    const suffix = dim("  Enter/Esc done");
    const editorWidth = Math.max(1, width - visibleWidth(prefix) - visibleWidth(suffix));
    const editor = input.render(editorWidth)[0] ?? "";
    const content = truncateToWidth(`${prefix}${editor}${suffix}`, width, "");
    const padding = " ".repeat(Math.max(0, width - visibleWidth(content)));
    return [`\x1b[48;5;236m${content}\x1b[48;5;236m${padding}\x1b[49m`];
  }

  invalidate(): void {}
}

class TextDialog implements Component {
  constructor(private readonly lines: string[], private readonly close: () => void) {}
  render(width: number): string[] {
    return this.lines.map((line) => truncateToWidth(safeCell(line), width, "…"));
  }
  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, "q") || matchesKey(data, Key.enter)) this.close();
  }
  invalidate(): void {}
}

class ConfirmDialog implements Component {
  constructor(private readonly question: string, private readonly confirm: () => void, private readonly close: () => void) {}
  render(width: number): string[] { return [truncateToWidth(this.question, width, "…"), "y confirm · any other key cancels"].map((line) => truncateToWidth(line, width)); }
  handleInput(data: string): void { if (matchesKey(data, "y")) this.confirm(); else this.close(); }
  invalidate(): void {}
}

class InputDialog implements Component, Focusable {
  private readonly input = new Input();
  private _focused = false;
  get focused(): boolean { return this._focused; }
  set focused(value: boolean) { this._focused = value; this.input.focused = value; }

  constructor(
    private readonly title: string,
    initial: string,
    submit: (value: string) => void,
    close: () => void,
  ) {
    this.input.setValue(initial);
    this.input.onSubmit = submit;
    this.input.onEscape = close;
  }
  render(width: number): string[] {
    return [truncateToWidth(this.title, width), ...this.input.render(width), truncateToWidth("Enter apply · Esc cancel", width)];
  }
  handleInput(data: string): void { this.input.handleInput(data); }
  invalidate(): void { this.input.invalidate(); }
}

class CreateDialog implements Component, Focusable {
  private readonly input = new Input();
  private index = 0;
  private _focused = false;
  private readonly values: CreateSandboxForm = {
    name: "", vcpuCount: "1", memSizeMiB: "2048", baseImage: "ubuntu:26.04",
    maxTtlSeconds: "", maxConcurrentExecs: "", portMappings: "", env: "",
  };
  private readonly fields: Array<[keyof CreateSandboxForm, string]> = [
    ["name", "Name (optional)"], ["vcpuCount", "CPU count (1–32)"], ["memSizeMiB", "Memory MiB (256–65536)"],
    ["baseImage", "Base image"], ["maxTtlSeconds", "Max TTL seconds (optional)"],
    ["maxConcurrentExecs", "Max concurrent execs (optional)"], ["portMappings", "Ports, comma-separated (e.g. 80/tcp,53/udp)"],
    ["env", "Environment, comma-separated (e.g. A=one,B=two)"],
  ];
  get focused(): boolean { return this._focused; }
  set focused(value: boolean) { this._focused = value; this.input.focused = value; }
  constructor(private readonly submit: (form: CreateSandboxForm) => void, private readonly close: () => void) {
    this.input.setValue(this.values[this.fields[0]![0]]);
    this.input.onEscape = close;
    this.input.onSubmit = (value) => {
      this.values[this.fields[this.index]![0]] = value;
      if (this.index === this.fields.length - 1) submit(this.values);
      else {
        this.index++;
        this.input.setValue(this.values[this.fields[this.index]![0]]);
      }
    };
  }
  render(width: number): string[] {
    return [truncateToWidth(`Create sandbox · ${this.index + 1}/${this.fields.length} · ${this.fields[this.index]![1]}`, width, "…"), ...this.input.render(width), truncateToWidth("Enter next · Esc cancel", width)];
  }
  handleInput(data: string): void { this.input.handleInput(data); }
  invalidate(): void { this.input.invalidate(); }
}

class OutputContent implements Component {
  constructor(private readonly stdout: string, private readonly stderr: string) {}
  render(width: number): string[] {
    const renderStream = (label: string, value: string) => {
      const safe = sanitizeRemoteOutput(value);
      const body = safe.text ? wrapTextWithAnsi(safe.text, Math.max(1, width)) : ["(empty)"];
      return [label, ...body, ...(safe.truncated ? ["(display cap reached; SDK result is unchanged)"] : [])].map((line) => truncateToWidth(line, width, ""));
    };
    return [...renderStream("STDOUT", this.stdout), "", ...renderStream("STDERR", this.stderr)];
  }
  invalidate(): void {}
}

class ClosableScrollView extends ScrollView {
  constructor(component: Component, private readonly close: () => void) {
    super(component, { scrollbar: "always", overscroll: "contain" });
  }
  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, "q")) this.close();
    else if (matchesKey(data, Key.up) || matchesKey(data, "k")) this.scrollBy(-1);
    else if (matchesKey(data, Key.down) || matchesKey(data, "j")) this.scrollBy(1);
    else if (matchesKey(data, Key.pageUp)) this.scrollBy(-10);
    else if (matchesKey(data, Key.pageDown)) this.scrollBy(10);
  }
}

class OutputDialog extends ClosableScrollView {
  constructor(stdout: string, stderr: string, close: () => void) {
    super(new OutputContent(stdout, stderr), close);
  }
}

class ExecHistoryDialog implements Component {
  private readonly table: ExecTable;
  private readonly unsubscribe: () => void;
  constructor(
    private readonly tui: TUI,
    private readonly model: ExecModel,
    private readonly close: () => void,
    private readonly output: (stdout: string, stderr: string) => void,
  ) {
    this.table = new ExecTable(() => model.snapshot());
    this.unsubscribe = model.subscribe(() => tui.requestRender());
    model.startPolling();
  }
  render(width: number): string[] {
    return ["EXEC HISTORY", ...this.table.render(width), truncateToWidth(this.model.snapshot().error ?? "↑/↓ select · Enter output · Ctrl+C cancel running exec · Esc close", width, "…")];
  }
  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, "q")) this.close();
    else if (matchesKey(data, Key.up) || matchesKey(data, "k")) this.model.selectOffset(-1);
    else if (matchesKey(data, Key.down) || matchesKey(data, "j")) this.model.selectOffset(1);
    else if (matchesKey(data, Key.ctrl("c"))) void this.model.cancel();
    else if (matchesKey(data, Key.enter)) void this.model.detail().then((execution) => {
      if (execution) this.output(execution.stdout ?? "", execution.stderr ?? "");
    });
    this.tui.requestRender();
  }
  dispose(): void { this.unsubscribe(); this.model.stopPolling(); }
  invalidate(): void { this.table.invalidate(); }
}

export interface SandboxAppOptions {
  profile?: string;
  region: string;
  onQuit: () => void;
}

export class SandboxApp extends VStack {
  private readonly unsubscribe: () => void;
  private notification = "";
  private overlayClose?: () => void;
  private filterInput?: Input;
  private shellActive = false;

  constructor(
    private readonly tui: TUI,
    readonly model: SandboxModel,
    private readonly options: SandboxAppOptions,
  ) {
    const table = new SandboxTable(() => model.snapshot());
    const details = new SandboxDetails(() => model.snapshot());
    const header = new Line(() => {
      const snapshot = model.snapshot();
      const refreshed = snapshot.lastRefresh?.toLocaleTimeString() ?? "never";
      const title = bold(cyan("ARCHIL SANDBOXES"));
      const context = dim(`profile ${options.profile ?? "environment"}  ·  region ${options.region}  ·  refreshed ${refreshed}`);
      return `${title}  ${context}${snapshot.loading ? `  ${yellow("refreshing…")}` : ""}`;
    });
    const wide = new HStack([
      { component: new ScrollView(table, { scrollbar: "auto" }), basis: 0, grow: 3, minSize: 45 },
      { component: new ScrollView(details, { scrollbar: "auto" }), basis: 0, grow: 2, minSize: 32 },
    ], { gap: 2 });
    const narrow = new VStack([
      { component: table, basis: 0, grow: 3, minSize: 5 },
      { component: details, basis: 0, grow: 2, minSize: 5 },
    ], { gap: 1 });
    const notification = new Line(() => {
      const error = model.snapshot().error;
      if (error) return red(`Error: ${error}`);
      if (this.notification) return green(this.notification);
      return dim("Ready");
    });
    const footer = new BottomBar(() => this.filterInput, () => {
      const filtered = model.snapshot().filter;
      const selected = model.snapshot().selected;
      const actions = selected ? ACTIONS_BY_STATUS[selected.status] : [];
      const hints = [actions.includes("start") && "S start", actions.includes("pause") && "P pause", actions.includes("resume") && "R resume", actions.includes("stop") && "X stop", actions.includes("fork") && "f fork", actions.includes("delete") && "Ctrl+D delete"].filter(Boolean).join(" · ");
      const execHints = selected ? ` · l execs${selected.status === "running" ? " · e run · t shell" : ""}` : "";
      return `↑/↓ j/k select · g/G ends · / filter${filtered ? ` (${safeCell(filtered)})` : ""} · r refresh · o sort · c create${hints ? ` · ${hints}` : ""}${execHints} · ? help · q quit`;
    });
    super([
      { component: header, basis: 1 },
      { component: new Rule(), basis: 1 },
      { component: wide, basis: 0, grow: 1, visible: ({ width }) => width >= 96 },
      { component: narrow, basis: 0, grow: 1, visible: ({ width }) => width < 96 },
      { component: notification, basis: 1 },
      { component: new Rule(), basis: 1 },
      { component: footer, basis: 1 },
    ], { gap: 0 });
    this.unsubscribe = model.subscribe(() => tui.requestRender());
  }

  handleInput(data: string): void {
    if (this.filterInput) {
      const input = this.filterInput;
      input.handleInput(data);
      if (this.filterInput === input) this.model.setFilter(input.getValue());
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.up) || matchesKey(data, "k")) this.model.selectOffset(-1);
    else if (matchesKey(data, Key.down) || matchesKey(data, "j")) this.model.selectOffset(1);
    else if (matchesKey(data, "g")) this.model.selectFirst();
    else if (matchesKey(data, "shift+g") || data === "G") this.model.selectLast();
    else if (matchesKey(data, "/")) this.showFilter();
    else if (matchesKey(data, "r")) void this.model.refresh();
    else if (matchesKey(data, "c")) this.showCreate();
    else if (matchesKey(data, "e")) this.showExecCommand();
    else if (matchesKey(data, "l")) this.showExecHistory();
    else if (matchesKey(data, "t")) void this.openShell();
    else if (matchesKey(data, "shift+s") || data === "S") this.requestAction("start");
    else if (matchesKey(data, "shift+p") || data === "P") this.requestAction("pause");
    else if (matchesKey(data, "shift+r") || data === "R") this.requestAction("resume");
    else if (matchesKey(data, "shift+x") || data === "X") this.requestAction("stop");
    else if (matchesKey(data, "f")) this.showFork();
    else if (matchesKey(data, Key.ctrl("d"))) this.requestAction("delete");
    else if (matchesKey(data, "o")) {
      const sorts: SandboxSort[] = ["lastActive", "name", "status"];
      const current = this.model.snapshot().sort;
      const next = sorts[(sorts.indexOf(current) + 1) % sorts.length]!;
      this.model.setSort(next);
      this.notification = `Sorted by ${next}`;
    } else if (matchesKey(data, "?")) this.showHelp();
    else if (matchesKey(data, "q") || matchesKey(data, Key.ctrl("c"))) this.options.onQuit();
    this.tui.requestRender();
  }

  dispose(): void {
    this.overlayClose?.();
    this.unsubscribe();
    this.model.stopPolling();
  }

  private async openShell(): Promise<void> {
    const sandbox = this.model.snapshot().selected;
    if (!sandbox || sandbox.status !== "running" || this.shellActive) return;
    this.shellActive = true;
    try {
      const { processId, result } = await runShellHandoff({ tui: this.tui, model: this.model, sandbox });
      this.notification = `Shell ${processId ?? "unknown"} returned (${result?.status ?? "no result"})`;
    } catch (error) {
      this.notification = `Shell returned: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.shellActive = false;
      this.tui.requestRender(true);
    }
  }

  private showExecCommand(): void {
    const sandbox = this.model.snapshot().selected;
    if (!sandbox || sandbox.status !== "running") return;
    let handle: ReturnType<TUI["showOverlay"]>;
    const close = () => { handle.hide(); this.overlayClose = undefined; };
    const dialog = new InputDialog(`Run command in '${safeCell(sandbox.name)}'`, "", (command) => {
      if (!command.trim()) return;
      close();
      const execModel = new ExecModel(sandbox);
      void execModel.submit(command).then((ok) => {
        this.notification = ok ? `Submitted command to '${safeCell(sandbox.name)}'` : execModel.snapshot().error ?? "Command submission failed";
        this.tui.requestRender();
      });
    }, close);
    handle = this.tui.showOverlay(dialog, { width: "75%", minWidth: 45, maxHeight: 5, anchor: "center" });
    this.overlayClose = close;
  }

  private showExecHistory(): void {
    const sandbox = this.model.snapshot().selected;
    if (!sandbox) return;
    let handle: ReturnType<TUI["showOverlay"]>;
    let dialog: ExecHistoryDialog;
    const close = () => { dialog.dispose(); handle.hide(); this.overlayClose = undefined; };
    dialog = new ExecHistoryDialog(this.tui, new ExecModel(sandbox), close, (stdout, stderr) => this.showExecOutput(stdout, stderr, close));
    handle = this.tui.showOverlay(dialog, { width: "90%", minWidth: 55, maxHeight: "85%", anchor: "center" });
    this.overlayClose = close;
  }

  private showExecOutput(stdout: string, stderr: string, historyClose: () => void): void {
    let handle: ReturnType<TUI["showOverlay"]>;
    const close = () => { handle.hide(); this.overlayClose = historyClose; };
    const dialog = new OutputDialog(stdout, stderr, close);
    handle = this.tui.showOverlay(dialog, { width: "90%", minWidth: 45, maxHeight: "85%", anchor: "center" });
    this.overlayClose = close;
  }

  private requestAction(action: SandboxAction): void {
    const sandbox = this.model.snapshot().selected;
    if (!sandbox || !ACTIONS_BY_STATUS[sandbox.status].includes(action)) return;
    const confirmation = action === "stop"
      ? `Stop sandbox '${safeCell(sandbox.name)}'?`
      : action === "delete"
        ? `Delete sandbox '${safeCell(sandbox.name)}' permanently?`
        : action === "start" && sandbox.status === "paused"
          ? `Cold-start '${safeCell(sandbox.name)}' and discard its memory snapshot?`
          : undefined;
    if (!confirmation) {
      void this.model.performAction(action);
      return;
    }
    let handle: ReturnType<TUI["showOverlay"]>;
    const close = () => { handle.hide(); this.overlayClose = undefined; };
    const dialog = new ConfirmDialog(confirmation, () => { close(); void this.model.performAction(action); }, close);
    handle = this.tui.showOverlay(dialog, { width: "70%", minWidth: 40, maxHeight: 4, anchor: "center" });
    this.overlayClose = close;
  }

  private showCreate(): void {
    let handle: ReturnType<TUI["showOverlay"]>;
    const close = () => { handle.hide(); this.overlayClose = undefined; };
    const dialog = new CreateDialog((form) => {
      try {
        const request = parseCreateSandboxForm(form);
        close();
        void this.model.create(request);
      } catch (error) {
        this.notification = error instanceof Error ? error.message : String(error);
        this.tui.requestRender();
      }
    }, close);
    handle = this.tui.showOverlay(dialog, { width: "75%", minWidth: 45, maxHeight: 5, anchor: "center" });
    this.overlayClose = close;
  }

  private showFork(): void {
    const sandbox = this.model.snapshot().selected;
    if (!sandbox || !ACTIONS_BY_STATUS[sandbox.status].includes("fork")) return;
    let handle: ReturnType<TUI["showOverlay"]>;
    const close = () => { handle.hide(); this.overlayClose = undefined; };
    const dialog = new InputDialog(`Fork '${safeCell(sandbox.name)}' · optional name`, "", (name) => {
      close();
      void this.model.performAction("fork", name.trim());
    }, close);
    handle = this.tui.showOverlay(dialog, { width: "60%", minWidth: 40, maxHeight: 5, anchor: "center" });
    this.overlayClose = close;
  }

  private showFilter(): void {
    const input = new Input();
    input.setValue(this.model.snapshot().filter);
    input.focused = true;
    const close = (value: string) => {
      this.model.setFilter(value);
      input.focused = false;
      this.filterInput = undefined;
    };
    input.onSubmit = close;
    input.onEscape = () => close(input.getValue());
    this.filterInput = input;
  }

  private showHelp(): void {
    let handle: ReturnType<TUI["showOverlay"]>;
    const close = () => { handle.hide(); this.overlayClose = undefined; };
    const dialog = new TextDialog([
      "SANDBOX KEYS", "↑/↓ or j/k  move selection", "g / G        first / last", "/            live filter", "r            refresh", "o            cycle sort", "c            create sandbox", "S/P/R/X      start/pause/resume/stop", "f            fork", "Ctrl+D       delete", "e            run durable command", "l            exec history", "t            interactive shell (Ctrl+] returns)", "?            this help", "q / Ctrl+C   quit", "", "Esc, Enter, or q closes this help",
    ], close);
    handle = this.tui.showOverlay(dialog, { width: 48, maxHeight: "80%", anchor: "center" });
    this.overlayClose = close;
  }
}
