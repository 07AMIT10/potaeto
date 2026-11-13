/**
 * SQLite-WASM OPFS SAH-Pool Web Worker
 *
 * Runs inside a dedicated Web Worker to take advantage of synchronous
 * FileSystemSyncAccessHandle in the Origin Private File System (OPFS)
 * via @sqlite.org/sqlite-wasm's installOpfsSAHPoolVfs.
 *
 * This VFS operates without requiring COOP/COEP isolation headers.
 */

import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

export interface SqliteDbInstance {
  exec(options: {
    sql: string;
    bind?: unknown[];
    rowMode?: 'object' | 'array';
    resultRows?: unknown[];
  }): unknown[];
  close(): void;
}

let dbInstance: SqliteDbInstance | null = null;

/**
 * Initializes SQLite with OPFS SAH-Pool VFS, falling back to oo1.DB if needed.
 */
export async function initSqlite(dbName = '/potaeto.db'): Promise<SqliteDbInstance> {
  const sqlite3 = await sqlite3InitModule();

  if (typeof (sqlite3 as any).installOpfsSAHPoolVfs === 'function') {
    const poolUtil = await (sqlite3 as any).installOpfsSAHPoolVfs({ name: 'opfs-sahpool' });
    dbInstance = new poolUtil.OpfsSAHPoolDb(dbName) as SqliteDbInstance;
  } else if ((sqlite3 as any).oo1?.OpfsDatabase) {
    dbInstance = new (sqlite3 as any).oo1.OpfsDatabase(dbName) as SqliteDbInstance;
  } else if ((sqlite3 as any).oo1?.DB) {
    dbInstance = new (sqlite3 as any).oo1.DB(dbName, 'c') as SqliteDbInstance;
  } else {
    throw new Error('No compatible SQLite database constructor found');
  }

  return dbInstance;
}

/**
 * Executes a SQL statement on the active SQLite instance.
 */
export function execSql(sql: string, params: unknown[] = []): unknown[] {
  if (!dbInstance) {
    throw new Error('Database is not initialized');
  }
  const rows: unknown[] = [];
  dbInstance.exec({
    sql,
    bind: params,
    rowMode: 'object',
    resultRows: rows,
  });
  return rows;
}

/**
 * Closes the active SQLite instance.
 */
export function closeSqlite(): void {
  if (dbInstance) {
    try {
      dbInstance.close();
    } finally {
      dbInstance = null;
    }
  }
}

// Dedicated worker message listener
if (typeof self !== 'undefined' && typeof (self as any).addEventListener === 'function') {
  (self as any).addEventListener('message', async (event: MessageEvent) => {
    const data = event.data;
    if (!data || typeof data.type !== 'string') return;

    if (data.type === 'init') {
      try {
        await initSqlite(data.dbName);
        (self as any).postMessage({ type: 'init_ok' });
      } catch (err) {
        (self as any).postMessage({
          type: 'init_error',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else if (data.type === 'exec') {
      try {
        const rows = execSql(data.sql, data.params ?? []);
        (self as any).postMessage({ type: 'exec_ok', id: data.id, rows });
      } catch (err) {
        (self as any).postMessage({
          type: 'exec_error',
          id: data.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else if (data.type === 'close') {
      try {
        closeSqlite();
        (self as any).postMessage({ type: 'close_ok', id: data.id });
      } catch (err) {
        (self as any).postMessage({
          type: 'close_error',
          id: data.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  });
}
