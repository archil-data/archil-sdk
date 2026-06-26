import { Buffer } from "node:buffer";

export interface SQLiteDisk {
  id: string;
}

export interface SQLiteDatabaseOptions {
  timeoutMs?: number;
  readBigInts?: boolean;
  returnArrays?: boolean;
}

export type SQLiteValue = null | number | bigint | string | Uint8Array | ArrayBuffer;
export type SQLiteRow = Record<string, SQLiteValue>;

export interface SQLiteWriteResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

export interface SQLiteExecMount {
  disk: string;
  readOnly: boolean;
  conditional?: boolean;
  queueMs?: number;
  checkoutPaths?: string[];
}

export interface SQLiteExecOptions {
  command: string;
  disks: Record<string, SQLiteExecMount>;
}

export interface SQLiteExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timing: {
    totalMs: number;
    queueMs: number;
    executeMs: number;
  };
}

export type SQLiteExec = (opts: SQLiteExecOptions) => Promise<SQLiteExecResult>;

type SQLiteOperationKind = "read" | "write";
type SQLiteExecutionMethod = "get" | "all" | "run";

interface SQLiteOperationRequest {
  kind: SQLiteOperationKind;
  method: SQLiteExecutionMethod;
  sql: string;
  params: WireValue[];
}

type SQLiteQueryRequest = Omit<SQLiteOperationRequest, "method">;

interface RemotePayload {
  databasePath: string;
  displayPath: string;
  timeoutMs: number;
  readBigInts: boolean;
  returnArrays: boolean;
  readOnly: boolean;
  transaction: boolean;
  operations: SQLiteOperationRequest[];
}

type WireValue =
  | { type: "undefined" }
  | { type: "null" }
  | { type: "number"; value: number }
  | { type: "string"; value: string }
  | { type: "bigint"; value: string }
  | { type: "bytes"; value: string }
  | { type: "array"; value: WireValue[] }
  | { type: "object"; value: Record<string, WireValue> };

interface RemoteSuccess {
  ok: true;
  result: WireValue;
}

interface RemoteFailure {
  ok: false;
  error: {
    name?: string;
    message?: string;
    stack?: string;
    code?: string | number;
  };
}

type RemoteResult = RemoteSuccess | RemoteFailure;

const DEFAULT_TIMEOUT_MS = 5000;
const WRITE_MOUNT_QUEUE_MS = 5000;
const RESULT_PREFIX = "ARCHIL_SQLITE_RESULT:";
const DISK_EXEC_MOUNT_PATH = "/mnt/archil/disk";

interface ParsedDatabasePath {
  path: string;
  directory?: string;
  filename: string;
}

const REMOTE_RUNNER = `
const { Buffer } = require("node:buffer");
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");

const RESULT_PREFIX = ${JSON.stringify(RESULT_PREFIX)};

function emit(payload) {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  console.log(RESULT_PREFIX + encoded);
}

function decodeValue(value) {
  switch (value.type) {
    case "null":
      return null;
    case "number":
    case "string":
      return value.value;
    case "bigint":
      return BigInt(value.value);
    case "bytes":
      return Buffer.from(value.value, "base64");
    default:
      throw new TypeError("unsupported SQLite parameter type: " + value.type);
  }
}

function encodeValue(value) {
  if (value === undefined) return { type: "undefined" };
  if (value === null) return { type: "null" };
  if (typeof value === "number") return { type: "number", value };
  if (typeof value === "string") return { type: "string", value };
  if (typeof value === "bigint") return { type: "bigint", value: value.toString() };
  if (value instanceof Uint8Array) {
    return { type: "bytes", value: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64") };
  }
  if (Array.isArray(value)) return { type: "array", value: value.map(encodeValue) };
  if (typeof value === "object") {
    return {
      type: "object",
      value: Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, encodeValue(entry)])),
    };
  }
  throw new TypeError("unsupported SQLite result type: " + typeof value);
}

function executeOperation(db, operation) {
  const statement = db.prepare(operation.sql);
  const params = operation.params.map(decodeValue);
  switch (operation.method) {
    case "get":
      return statement.get(...params);
    case "all":
      return statement.all(...params);
    case "run":
      return statement.run(...params);
  }
}

function run(payload) {
  if (!fs.existsSync(payload.databasePath)) {
    const err = new Error("SQLite database does not exist at " + payload.displayPath);
    err.code = "SQLITE_DATABASE_NOT_FOUND";
    throw err;
  }

  const db = new DatabaseSync(payload.databasePath, {
    readOnly: payload.readOnly,
    timeout: payload.timeoutMs,
    readBigInts: payload.readBigInts,
    returnArrays: payload.returnArrays,
  });

  try {
    if (!payload.transaction) {
      return executeOperation(db, payload.operations[0]);
    }

    db.exec(payload.readOnly ? "BEGIN" : "BEGIN IMMEDIATE");
    try {
      const results = payload.operations.map((operation) => executeOperation(db, operation));
      db.exec("COMMIT");
      return results;
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw err;
    }
  } finally {
    db.close();
  }
}

try {
  const payload = JSON.parse(Buffer.from(process.argv[1], "base64").toString("utf8"));
  emit({ ok: true, result: encodeValue(run(payload)) });
} catch (err) {
  emit({
    ok: false,
    error: {
      name: err && err.name,
      message: err && err.message,
      stack: err && err.stack,
      code: err && err.code,
    },
  });
}
`;

export class ArchilSQLiteError extends Error {
  readonly code?: string | number;
  readonly remoteStack?: string;

  constructor(message: string, opts: { code?: string | number; remoteStack?: string } = {}) {
    super(message);
    this.name = "ArchilSQLiteError";
    this.code = opts.code;
    this.remoteStack = opts.remoteStack;
  }
}

export interface SQLiteOperation<Result> extends PromiseLike<Result> {
  execute(): Promise<Result>;
}

interface SQLiteOperationState {
  request: SQLiteOperationRequest;
  executeRequest: (request: SQLiteOperationRequest) => Promise<unknown>;
  promise?: Promise<unknown>;
}

const operationStates = new WeakMap<SQLiteOperation<unknown>, SQLiteOperationState>();

function deferredPromise<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

class SQLiteOperationImpl<Result> implements SQLiteOperation<Result> {
  constructor(
    private readonly executeRequest: (request: SQLiteOperationRequest) => Promise<unknown>,
    request: SQLiteOperationRequest,
  ) {
    operationStates.set(this as SQLiteOperation<unknown>, {
      executeRequest,
      request,
    });
  }

  execute(): Promise<Result> {
    const state = operationStates.get(this as SQLiteOperation<unknown>);
    if (!state) {
      throw new TypeError("unknown SQLite operation");
    }
    state.promise ??= this.executeRequest(state.request);
    return state.promise as Promise<Result>;
  }

  then<TResult1 = Result, TResult2 = never>(
    onfulfilled?: ((value: Result) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }
}

export interface SQLiteQuery<Row = SQLiteRow> {
  get(): SQLiteOperation<Row | undefined>;
  all(): SQLiteOperation<Row[]>;
  run(): SQLiteOperation<SQLiteWriteResult>;
}

class SQLiteQueryImpl<Row> implements SQLiteQuery<Row> {
  constructor(
    private readonly executeRequest: (request: SQLiteOperationRequest) => Promise<unknown>,
    private readonly request: SQLiteQueryRequest,
  ) {}

  get(): SQLiteOperation<Row | undefined> {
    return new SQLiteOperationImpl<Row | undefined>(this.executeRequest, {
      ...this.request,
      method: "get",
    });
  }

  all(): SQLiteOperation<Row[]> {
    return new SQLiteOperationImpl<Row[]>(this.executeRequest, {
      ...this.request,
      method: "all",
    });
  }

  run(): SQLiteOperation<SQLiteWriteResult> {
    return new SQLiteOperationImpl<SQLiteWriteResult>(this.executeRequest, {
      ...this.request,
      method: "run",
    });
  }
}

type SQLiteOperationResult<Operation> =
  Operation extends SQLiteOperation<infer Result> ? Result : never;

export type SQLiteTransactionResult<Operations extends readonly SQLiteOperation<unknown>[]> = {
  -readonly [Index in keyof Operations]: SQLiteOperationResult<Operations[Index]>;
};

export interface SQLiteDatabase {
  read<Row = SQLiteRow>(
    strings: TemplateStringsArray,
    ...values: SQLiteValue[]
  ): SQLiteQuery<Row>;
  write<Row = SQLiteRow>(
    strings: TemplateStringsArray,
    ...values: SQLiteValue[]
  ): SQLiteQuery<Row>;
  transaction<const Operations extends readonly SQLiteOperation<unknown>[]>(
    operations: Operations,
  ): Promise<SQLiteTransactionResult<Operations>>;
}

class SQLiteAdapter implements SQLiteDatabase {
  private readonly timeoutMs: number;
  private readonly readBigInts: boolean;
  private readonly returnArrays: boolean;

  constructor(
    private readonly exec: SQLiteExec,
    private readonly disk: SQLiteDisk,
    private readonly database: ParsedDatabasePath,
    options: SQLiteDatabaseOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.readBigInts = options.readBigInts ?? false;
    this.returnArrays = options.returnArrays ?? false;
  }

  read<Row = SQLiteRow>(
    strings: TemplateStringsArray,
    ...values: SQLiteValue[]
  ): SQLiteQuery<Row> {
    return new SQLiteQueryImpl<Row>((request) => this.executeSingle(request), {
      kind: "read",
      sql: templateToSql(strings),
      params: values.map(encodeParameter),
    });
  }

  write<Row = SQLiteRow>(
    strings: TemplateStringsArray,
    ...values: SQLiteValue[]
  ): SQLiteQuery<Row> {
    return new SQLiteQueryImpl<Row>((request) => this.executeSingle(request), {
      kind: "write",
      sql: templateToSql(strings),
      params: values.map(encodeParameter),
    });
  }

  async transaction<const Operations extends readonly SQLiteOperation<unknown>[]>(
    operations: Operations,
  ): Promise<SQLiteTransactionResult<Operations>> {
    const states = operations.map((operation) => {
      const state = operationStates.get(operation);
      if (!state) {
        throw new TypeError("unknown SQLite operation");
      }
      return state;
    });
    const seen = new Set<SQLiteOperationState>();
    for (const state of states) {
      if (state.promise) {
        throw new TypeError("SQLite operation has already started");
      }
      if (seen.has(state)) {
        throw new TypeError("SQLite operation cannot be used more than once in a transaction");
      }
      seen.add(state);
    }

    const requests = states.map((state) => state.request);
    const readOnly = requests.every((request) => request.kind === "read");
    const deferreds = states.map(() => deferredPromise<unknown>());
    states.forEach((state, index) => {
      state.promise = deferreds[index].promise;
    });

    try {
      const results = await this.executeRemote(requests, { transaction: true, readOnly });
      results.forEach((result, index) => {
        deferreds[index].resolve(result);
      });
      return results as SQLiteTransactionResult<Operations>;
    } catch (err) {
      deferreds.forEach((deferred) => {
        deferred.reject(err);
      });
      throw err;
    }
  }

  private executeSingle(request: SQLiteOperationRequest): Promise<unknown> {
    return this.executeRemote([request], {
      transaction: false,
      readOnly: request.kind === "read",
    }).then((results) => results[0]);
  }

  private async executeRemote(
    operations: SQLiteOperationRequest[],
    opts: { transaction: boolean; readOnly: boolean },
  ): Promise<unknown[]> {
    const payload: RemotePayload = {
      databasePath: `${DISK_EXEC_MOUNT_PATH}/${this.database.path}`,
      displayPath: this.database.path,
      timeoutMs: this.timeoutMs,
      readBigInts: this.readBigInts,
      returnArrays: this.returnArrays,
      readOnly: opts.readOnly,
      transaction: opts.transaction,
      operations,
    };
    const checkoutPaths =
      opts.readOnly || !this.database.directory ? undefined : [this.database.directory];
    const queueMs = opts.readOnly ? undefined : WRITE_MOUNT_QUEUE_MS;
    const mount: SQLiteExecMount = {
      disk: this.disk.id,
      readOnly: opts.readOnly,
      checkoutPaths,
      queueMs,
    };
    const command = buildCommand(payload);
    const result = await this.exec({
      command,
      disks: { disk: mount },
    });
    const decoded = parseExecResult(result);
    return opts.transaction ? (decoded as unknown[]) : [decoded];
  }
}

export interface SQLiteAdapterModule {
  createDatabase(
    disk: SQLiteDisk,
    databasePath: string,
    options?: SQLiteDatabaseOptions,
  ): Promise<SQLiteDatabase>;
  getDatabase(
    disk: SQLiteDisk,
    databasePath: string,
    options?: SQLiteDatabaseOptions,
  ): Promise<SQLiteDatabase>;
}

export function createSQLiteAdapter(exec: SQLiteExec): SQLiteAdapterModule {
  return {
    async createDatabase(
      disk: SQLiteDisk,
      databasePath: string,
      options: SQLiteDatabaseOptions = {},
    ): Promise<SQLiteDatabase> {
      const database = normalizeDatabasePath(databasePath);
      const rootDirectory = database.directory
        ? `${DISK_EXEC_MOUNT_PATH}/${database.directory}`
        : DISK_EXEC_MOUNT_PATH;
      const mountedDatabasePath = `${rootDirectory}/${database.filename}`;
      const command =
        `mkdir -p ${shellQuote(rootDirectory)} && ` +
        `node --no-warnings -e ${shellQuote(CREATE_DATABASE_RUNNER)} ${shellQuote(mountedDatabasePath)}`;
      const result = await exec({
        command,
        disks: {
          disk: {
            disk: disk.id,
            readOnly: false,
            queueMs: WRITE_MOUNT_QUEUE_MS,
          },
        },
      });
      if (result.exitCode !== 0) {
        throw new ArchilSQLiteError(
          `SQLite database creation failed with exit code ${result.exitCode}: ${result.stderr || result.stdout}`,
        );
      }
      return new SQLiteAdapter(exec, disk, database, options);
    },

    async getDatabase(
      disk: SQLiteDisk,
      databasePath: string,
      options: SQLiteDatabaseOptions = {},
    ): Promise<SQLiteDatabase> {
      const database = normalizeDatabasePath(databasePath);
      return new SQLiteAdapter(exec, disk, database, options);
    },
  };
}

function templateToSql(strings: TemplateStringsArray): string {
  let sql = strings[0] ?? "";
  for (let i = 1; i < strings.length; i++) {
    sql += "?" + strings[i];
  }
  return sql;
}

function normalizeDatabasePath(path: string): ParsedDatabasePath {
  if (path.endsWith("/")) {
    throw new TypeError("database path must include a file name and not end with '/'");
  }
  const segments = path.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.length === 0 || segments.some((segment) => segment === "..")) {
    throw new TypeError("database path must be a non-empty relative file path without '..'");
  }
  const filename = segments[segments.length - 1];
  const directorySegments = segments.slice(0, -1);
  return {
    path: segments.join("/"),
    directory: directorySegments.length > 0 ? directorySegments.join("/") : undefined,
    filename,
  };
}

const CREATE_DATABASE_RUNNER = `
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1]);
db.close();
`;

function encodeParameter(value: SQLiteValue): WireValue {
  if (value === null) return { type: "null" };
  if (typeof value === "number") return { type: "number", value };
  if (typeof value === "string") return { type: "string", value };
  if (typeof value === "bigint") return { type: "bigint", value: value.toString() };
  if (value instanceof Uint8Array) {
    return {
      type: "bytes",
      value: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64"),
    };
  }
  if (value instanceof ArrayBuffer) {
    return { type: "bytes", value: Buffer.from(value).toString("base64") };
  }
  throw new TypeError(`unsupported SQLite parameter type: ${typeof value}`);
}

function decodeWireValue(value: WireValue): unknown {
  switch (value.type) {
    case "undefined":
      return undefined;
    case "null":
      return null;
    case "number":
    case "string":
      return value.value;
    case "bigint":
      return BigInt(value.value);
    case "bytes":
      return Uint8Array.from(Buffer.from(value.value, "base64"));
    case "array":
      return value.value.map(decodeWireValue);
    case "object":
      return Object.fromEntries(
        Object.entries(value.value).map(([key, entry]) => [key, decodeWireValue(entry)]),
      );
  }
}

function buildCommand(payload: RemotePayload): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  return `node --no-warnings -e ${shellQuote(REMOTE_RUNNER)} ${shellQuote(encodedPayload)}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function parseExecResult(result: SQLiteExecResult): unknown {
  if (result.exitCode !== 0) {
    throw new ArchilSQLiteError(
      `SQLite serverless execution failed with exit code ${result.exitCode}: ${result.stderr || result.stdout}`,
    );
  }

  const line = result.stdout
    .split(/\r?\n/)
    .reverse()
    .find((entry) => entry.startsWith(RESULT_PREFIX));

  if (!line) {
    throw new ArchilSQLiteError("SQLite serverless execution did not return a result payload");
  }

  let parsed: RemoteResult;
  try {
    parsed = JSON.parse(
      Buffer.from(line.slice(RESULT_PREFIX.length), "base64").toString("utf8"),
    ) as RemoteResult;
  } catch (err) {
    throw new ArchilSQLiteError(`SQLite serverless execution returned invalid JSON: ${err}`);
  }

  if (!parsed.ok) {
    throw new ArchilSQLiteError(parsed.error.message ?? "SQLite serverless execution failed", {
      code: parsed.error.code,
      remoteStack: parsed.error.stack,
    });
  }

  return decodeWireValue(parsed.result);
}
