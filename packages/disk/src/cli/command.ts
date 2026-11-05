// A small command-line parser for the `disk` and `sandbox` CLIs: nested
// subcommands, `<required>` / `[optional]` / `<variadic...>` operands, short and
// long options (with `--no-x` negation, custom parsers, defaults and
// environment fallbacks), a `preAction` hook, and generated help.
//
// Options of a command are also recognized after any of its subcommands, so
// global flags like `--api-key` can appear anywhere on the line. `--` ends
// option parsing.

/** A usage problem with the command line itself (unknown option, missing argument). */
export class CliUsageError extends Error {}

type OptionParser = (value: string, previous: unknown) => unknown;
type ActionHandler = (...args: any[]) => void | Promise<void>;
type PreActionHook = (thisCommand: Command, actionCommand: Command) => void | Promise<void>;

function camelCase(name: string): string {
  return name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

export class Option {
  readonly short?: string;
  readonly long: string;
  readonly attribute: string;
  readonly valueName?: string;
  readonly negate: boolean;
  envVar?: string;
  parser?: OptionParser;
  defaultValue?: unknown;

  constructor(readonly flags: string, readonly description = "") {
    const match = /^(?:-([A-Za-z]),\s*)?--([A-Za-z][\w-]*)(?:\s+<([^>]+)>)?$/.exec(flags);
    if (!match) throw new Error(`Unsupported option flags '${flags}'`);
    this.short = match[1];
    this.long = match[2]!;
    this.valueName = match[3];
    this.negate = this.long.startsWith("no-");
    this.attribute = camelCase(this.negate ? this.long.slice(3) : this.long);
    if (this.negate) this.defaultValue = true;
  }

  /** Fall back to this environment variable when the option isn't given. */
  env(name: string): this {
    this.envVar = name;
    return this;
  }

  get takesValue(): boolean {
    return this.valueName !== undefined;
  }
}

interface Argument {
  name: string;
  required: boolean;
  variadic: boolean;
}

function parseArgument(spec: string): Argument {
  const match = /^([<[])([^>\]]+?)(\.\.\.)?[>\]]$/.exec(spec);
  if (!match) throw new Error(`Unsupported argument '${spec}'`);
  return { name: match[2]!, required: match[1] === "<", variadic: match[3] !== undefined };
}

function argumentUsage(argument: Argument): string {
  const name = `${argument.name}${argument.variadic ? "..." : ""}`;
  return argument.required ? `<${name}>` : `[${name}]`;
}

const HELP_OPTION = new Option("-h, --help", "display help for command");
const VERSION_FLAGS = "-V, --version";

/** Lay out `[term, description]` rows as an indented two-column list. */
function formatList(rows: Array<[string, string]>): string {
  const width = Math.max(...rows.map(([term]) => term.length));
  return rows
    .map(([term, description]) => `  ${term.padEnd(width)}  ${description}`.trimEnd())
    .join("\n");
}

export class Command {
  readonly commands: Command[] = [];
  parent?: Command;
  private _name: string;
  private _description = "";
  private _version?: Option & { version: string };
  private readonly _arguments: Argument[] = [];
  private readonly _options: Option[] = [];
  private _action?: ActionHandler;
  private readonly _preActionHooks: PreActionHook[] = [];
  private _helpAfter = "";
  private _showGlobalOptions = false;
  private _values: Record<string, unknown> = {};
  private readonly _fromCli = new Set<string>();

  constructor(name = "") {
    this._name = name;
  }

  name(): string;
  name(name: string): this;
  name(name?: string): string | this {
    if (name === undefined) return this._name;
    this._name = name;
    return this;
  }

  description(text: string): this {
    this._description = text;
    return this;
  }

  version(version: string): this {
    this._version = Object.assign(new Option(VERSION_FLAGS, "output the version number"), { version });
    return this;
  }

  hook(event: "preAction", hook: PreActionHook): this {
    this._preActionHooks.push(hook);
    return this;
  }

  /** Add a subcommand, e.g. `get <id|name>` or `run <id> <command...>`, and return it. */
  command(spec: string): Command {
    const [name, ...args] = spec.trim().split(/\s+/);
    const command = new Command(name);
    for (const arg of args) command._arguments.push(parseArgument(arg));
    command.parent = this;
    this.commands.push(command);
    return command;
  }

  option<T>(flags: string, description: string, parser: (value: string, previous: T) => T, defaultValue?: T): this;
  option(flags: string, description: string, defaultValue?: string | boolean | string[]): this;
  option(flags: string, description: string, parserOrDefault?: unknown, defaultValue?: unknown): this {
    const option = new Option(flags, description);
    if (typeof parserOrDefault === "function") {
      option.parser = parserOrDefault as OptionParser;
      if (defaultValue !== undefined) option.defaultValue = defaultValue;
    } else if (parserOrDefault !== undefined) {
      option.defaultValue = parserOrDefault;
    }
    return this.addOption(option);
  }

  addOption(option: Option): this {
    this._options.push(option);
    return this;
  }

  configureHelp(settings: { showGlobalOptions?: boolean }): this {
    this._showGlobalOptions = settings.showGlobalOptions ?? this._showGlobalOptions;
    return this;
  }

  addHelpText(position: "after", text: string): this {
    this._helpAfter += text;
    return this;
  }

  action(handler: ActionHandler): this {
    this._action = handler;
    return this;
  }

  opts<T = Record<string, unknown>>(): T {
    return { ...this._values } as T;
  }

  /** Parse `argv` (`[node, script, ...args]`) and run the selected command's action. */
  async parseAsync(argv: string[]): Promise<this> {
    await this._run(argv.slice(2));
    return this;
  }

  private _ancestors(): Command[] {
    const chain: Command[] = [];
    for (let command: Command | undefined = this; command; command = command.parent) chain.unshift(command);
    return chain;
  }

  private _commandPath(): string {
    return this._ancestors().map((command) => command._name).join(" ");
  }

  private _root(): Command {
    return this._ancestors()[0]!;
  }

  private _reset(): void {
    this._values = {};
    this._fromCli.clear();
    for (const option of this._options) {
      if (option.defaultValue !== undefined) this._values[option.attribute] = option.defaultValue;
    }
  }

  /** Find an option on this command or an ancestor, by `--long` name or `-s` flag. */
  private _findOption(matches: (option: Option) => boolean): { owner: Command; option: Option } | undefined {
    for (const owner of this._ancestors().reverse()) {
      const option = owner._options.find(matches);
      if (option) return { owner, option };
    }
    return undefined;
  }

  private _setOption(owner: Command, option: Option, value: string | undefined): void {
    if (!option.takesValue) {
      owner._values[option.attribute] = !option.negate;
    } else {
      const previous = owner._values[option.attribute];
      owner._values[option.attribute] = option.parser ? option.parser(value!, previous) : value;
    }
    owner._fromCli.add(option.attribute);
  }

  private _applyEnvironment(): void {
    for (const option of this._options) {
      if (!option.envVar || this._fromCli.has(option.attribute)) continue;
      const value = process.env[option.envVar];
      if (value === undefined) continue;
      this._values[option.attribute] = option.parser ? option.parser(value, this._values[option.attribute]) : value;
    }
  }

  private async _run(args: string[]): Promise<void> {
    this._reset();
    const operands: string[] = [];
    let index = 0;

    const takeValue = (option: Option, inline: string | undefined): string => {
      if (inline !== undefined) return inline;
      const value = args[index++];
      if (value === undefined) throw new CliUsageError(`error: option '${option.flags}' argument missing`);
      return value;
    };

    while (index < args.length) {
      const token = args[index++]!;

      if (token === "--") {
        operands.push(...args.slice(index));
        break;
      }

      if (token.startsWith("--")) {
        const eq = token.indexOf("=");
        const long = token.slice(2, eq === -1 ? undefined : eq);
        const inline = eq === -1 ? undefined : token.slice(eq + 1);
        if (long === "help") return this._printHelp();
        if (long === "version" && this._root()._version) return this._printVersion();
        const found = this._findOption((option) => option.long === long);
        if (!found) throw new CliUsageError(`error: unknown option '--${long}'`);
        if (!found.option.takesValue && inline !== undefined) {
          throw new CliUsageError(`error: option '${found.option.flags}' does not take an argument`);
        }
        this._setOption(found.owner, found.option, found.option.takesValue ? takeValue(found.option, inline) : undefined);
        continue;
      }

      if (token.startsWith("-") && token.length > 1) {
        // Short flags may be combined (-iU); a flag taking a value consumes the
        // rest of the token (-C3) or the next argument (-C 3).
        for (let position = 1; position < token.length; position++) {
          const flag = token[position]!;
          if (flag === "h") return this._printHelp();
          if (flag === "V" && this._root()._version) return this._printVersion();
          const found = this._findOption((option) => option.short === flag);
          if (!found) throw new CliUsageError(`error: unknown option '${position === 1 ? token : `-${flag}`}'`);
          if (found.option.takesValue) {
            const rest = token.slice(position + 1);
            this._setOption(found.owner, found.option, takeValue(found.option, rest === "" ? undefined : rest));
            break;
          }
          this._setOption(found.owner, found.option, undefined);
        }
        continue;
      }

      if (operands.length === 0 && this.commands.length > 0) {
        if (token === "help") {
          const target = this.commands.find((command) => command._name === args[index]);
          return (target ?? this)._printHelp();
        }
        const subcommand = this.commands.find((command) => command._name === token);
        if (!subcommand) throw new CliUsageError(`error: unknown command '${token}'`);
        return subcommand._run(args.slice(index));
      }
      operands.push(token);
    }

    for (const command of this._ancestors()) command._applyEnvironment();

    if (!this._action) {
      if (this.commands.length > 0) throw new CliUsageError(this.helpInformation());
      return;
    }

    const values: unknown[] = [];
    for (const [position, argument] of this._arguments.entries()) {
      if (argument.variadic) {
        const rest = operands.slice(position);
        if (argument.required && rest.length === 0) {
          throw new CliUsageError(`error: missing required argument '${argument.name}'`);
        }
        values.push(rest);
      } else {
        const value = operands[position];
        if (argument.required && value === undefined) {
          throw new CliUsageError(`error: missing required argument '${argument.name}'`);
        }
        values.push(value);
      }
    }
    const last = this._arguments[this._arguments.length - 1];
    if (!last?.variadic && operands.length > this._arguments.length) {
      throw new CliUsageError(
        `error: too many arguments for '${this._name}'. Expected ${this._arguments.length} argument${this._arguments.length === 1 ? "" : "s"} but got ${operands.length}.`,
      );
    }

    for (const command of this._ancestors()) {
      for (const hook of command._preActionHooks) await hook(command, this);
    }
    await this._action(...values, this.opts(), this);
  }

  private _printHelp(): void {
    process.stdout.write(`${this.helpInformation()}${this._helpAfter}`);
  }

  private _printVersion(): void {
    process.stdout.write(`${this._root()._version!.version}\n`);
  }

  private _optionRows(options: Option[]): Array<[string, string]> {
    return options.map((option) => {
      const term = `${option.short ? `-${option.short}, ` : ""}--${option.long}${option.takesValue ? ` <${option.valueName}>` : ""}`;
      const extras: string[] = [];
      if (option.takesValue && option.defaultValue !== undefined && !(Array.isArray(option.defaultValue) && option.defaultValue.length === 0)) {
        extras.push(`default: ${JSON.stringify(option.defaultValue)}`);
      }
      if (option.envVar) extras.push(`env: ${option.envVar}`);
      return [term, extras.length > 0 ? `${option.description} (${extras.join(", ")})` : option.description];
    });
  }

  /** The command's help text. */
  helpInformation(): string {
    const usage = [this._commandPath(), "[options]"];
    if (this.commands.length > 0) usage.push("[command]");
    usage.push(...this._arguments.map(argumentUsage));

    const sections = [`Usage: ${usage.join(" ")}`];
    if (this._description) sections.push(this._description);

    const ownOptions = [...this._options];
    if (this === this._root() && this._version) ownOptions.push(this._version);
    sections.push(`Options:\n${formatList(this._optionRows([...ownOptions, HELP_OPTION]))}`);

    if (this._ancestors().some((command) => command._showGlobalOptions)) {
      const inherited = this._ancestors().slice(0, -1).flatMap((command) => command._options);
      if (inherited.length > 0) sections.push(`Global Options:\n${formatList(this._optionRows(inherited))}`);
    }

    if (this.commands.length > 0) {
      const rows: Array<[string, string]> = this.commands.map((command) => [
        [command._name, ...(command._options.length > 0 ? ["[options]"] : []), ...command._arguments.map(argumentUsage)].join(" "),
        command._description,
      ]);
      rows.push(["help [command]", "display help for command"]);
      sections.push(`Commands:\n${formatList(rows)}`);
    }
    return `${sections.join("\n\n")}\n`;
  }
}
