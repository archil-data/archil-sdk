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
  type TUI,
} from "@earendil-works/pi-tui";
import { SandboxModel, type SandboxSort } from "./model.js";
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
    const prefix = bold(cyan(" FILTER › "));
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
      return `↑/↓ j/k select · g/G ends · / filter${filtered ? ` (${safeCell(filtered)})` : ""} · r refresh · o sort · ? help · q quit`;
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
      "SANDBOX KEYS", "↑/↓ or j/k  move selection", "g / G        first / last", "/            live filter", "r            refresh", "o            cycle sort", "?            this help", "q / Ctrl+C   quit", "", "Esc, Enter, or q closes this help",
    ], close);
    handle = this.tui.showOverlay(dialog, { width: 48, maxHeight: "80%", anchor: "center" });
    this.overlayClose = close;
  }
}
