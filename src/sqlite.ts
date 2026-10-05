import { createRequire } from 'module';

export interface SqliteDatabase {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase;
}

let sqliteModule: SqliteModule | null | undefined;

/** Older extension hosts have no node:sqlite; callers report the missing source. */
export function loadSqlite(): SqliteModule | undefined {
  if (sqliteModule === undefined) {
    try {
      sqliteModule = createRequire(__filename)('node:sqlite') as SqliteModule;
    } catch {
      sqliteModule = null;
    }
  }
  return sqliteModule ?? undefined;
}
