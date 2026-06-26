import { exec as archilExec } from "disk";
import {
  createSQLiteAdapter,
  type SQLiteDatabase,
  type SQLiteDatabaseOptions,
  type SQLiteDisk,
} from "./adapter.js";

export {
  ArchilSQLiteError,
  type SQLiteDatabase,
  type SQLiteDatabaseOptions,
  type SQLiteDisk,
  type SQLiteOperation,
  type SQLiteQuery,
  type SQLiteRow,
  type SQLiteTransactionResult,
  type SQLiteValue,
  type SQLiteWriteResult,
} from "./adapter.js";

const sqlite = createSQLiteAdapter((opts) => archilExec(opts));

export function createDatabase(
  disk: SQLiteDisk,
  databasePath: string,
  options?: SQLiteDatabaseOptions,
): Promise<SQLiteDatabase> {
  return sqlite.createDatabase(disk, databasePath, options);
}

export function getDatabase(
  disk: SQLiteDisk,
  databasePath: string,
  options?: SQLiteDatabaseOptions,
): Promise<SQLiteDatabase> {
  return sqlite.getDatabase(disk, databasePath, options);
}
