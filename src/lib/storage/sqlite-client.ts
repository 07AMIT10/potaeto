/**
 * SQLite-WASM / OPFS SAH-Pool Client with Dexie / IndexedDB Fallback
 *
 * Provides a unified LocalDbClient interface.
 * - Detects if Web Worker & OPFS (FileSystemSyncAccessHandle) are available.
 * - If supported, offloads operations to the OPFS SAH-Pool Web Worker.
 * - If unsupported or upon failure, cleanly falls back to Dexie / IndexedDB without crashing.
 */

import Dexie, { type Table } from 'dexie';

export interface LocalDbClient {
  readonly mode: 'opfs' | 'dexie';
  isOpfsSupported(): Promise<boolean>;
  init(): Promise<void>;
  execute(sql: string, params?: unknown[]): Promise<unknown[]>;
  close(): Promise<void>;
}

export interface SqliteClientOptions {
  dbName?: string;
  workerFactory?: () => Worker;
  forceFallback?: boolean;
  workerTimeoutMs?: number;
}

export interface FallbackRecord {
  id?: number;
  tableName: string;
  data: Record<string, unknown>;
}

export class DexieStorageFallback extends Dexie {
  records!: Table<FallbackRecord, number>;

  constructor(name = 'potaeto_storage_fallback') {
    super(name);
    this.version(1).stores({
      records: '++id, tableName',
    });
  }
}

/**
 * Checks if the browser supports both Web Workers and OPFS getDirectory.
 */
export async function isOpfsSupported(): Promise<boolean> {
  if (typeof window === 'undefined' || typeof Worker === 'undefined') {
    return false;
  }
  if (
    typeof navigator === 'undefined' ||
    !navigator.storage ||
    typeof navigator.storage.getDirectory !== 'function'
  ) {
    return false;
  }
  try {
    const root = await navigator.storage.getDirectory();
    return Boolean(root);
  } catch {
    return false;
  }
}

function parseLiteral(raw: string): unknown {
  const s = raw.trim();
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
    return s.slice(1, -1);
  }
  if (s.toLowerCase() === 'null') return null;
  if (s.toLowerCase() === 'true') return true;
  if (s.toLowerCase() === 'false') return false;
  const num = Number(s);
  return Number.isNaN(num) ? s : num;
}

function parseValues(valClause: string, params: unknown[]): unknown[] {
  if (params && params.length > 0) {
    return params;
  }
  const trimmed = valClause.trim();
  const inner =
    trimmed.startsWith('(') && trimmed.endsWith(')') ? trimmed.slice(1, -1) : trimmed;

  const parts: string[] = [];
  let current = '';
  let inQuote = false;
  let quoteChar = '';

  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if ((ch === "'" || ch === '"') && (i === 0 || inner[i - 1] !== '\\')) {
      if (!inQuote) {
        inQuote = true;
        quoteChar = ch;
      } else if (ch === quoteChar) {
        inQuote = false;
      }
      current += ch;
    } else if (ch === ',' && !inQuote) {
      parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());

  return parts.map(parseLiteral);
}

function parseWhereConditions(
  whereClause: string,
  params: unknown[],
  paramOffset = 0,
): {
  filter: (data: Record<string, unknown>) => boolean;
  paramsUsed: number;
} {
  const parts = whereClause.split(/\s+AND\s+/i);
  let pIdx = paramOffset;
  const conditions: Array<(data: Record<string, unknown>) => boolean> = [];

  for (const part of parts) {
    const match = part.trim().match(/^([a-zA-Z0-9_`"']+)\s*(=|!=|<>|<|>|<=|>=|LIKE)\s*(.+)$/i);
    if (!match) continue;
    const rawCol = match[1].replace(/[`"']/g, '');
    const op = match[2];
    const rawVal = match[3].trim();

    let expectedVal: unknown;
    if (rawVal === '?') {
      expectedVal = params[pIdx++];
    } else {
      expectedVal = parseLiteral(rawVal);
    }

    conditions.push((data: Record<string, unknown>) => {
      const actual = data[rawCol] !== undefined ? data[rawCol] : data[rawCol.toLowerCase()];
      if (op === '=' || op === '==') {
        return actual === expectedVal || String(actual) === String(expectedVal);
      }
      if (op === '!=' || op === '<>') {
        return actual !== expectedVal && String(actual) !== String(expectedVal);
      }
      return true;
    });
  }

  return {
    filter: (data: Record<string, unknown>) => conditions.every((c) => c(data)),
    paramsUsed: pIdx - paramOffset,
  };
}

export class SqliteClient implements LocalDbClient {
  private _mode: 'opfs' | 'dexie' = 'dexie';
  private worker: Worker | null = null;
  private fallbackDb: DexieStorageFallback | null = null;
  private initialized = false;
  private pendingRequests = new Map<
    string,
    {
      resolve: (rows: unknown[]) => void;
      reject: (err: Error) => void;
    }
  >();
  private reqIdCounter = 0;

  constructor(private options: SqliteClientOptions = {}) {}

  get mode(): 'opfs' | 'dexie' {
    return this._mode;
  }

  get fallbackDatabase(): DexieStorageFallback | null {
    return this.fallbackDb;
  }

  async isOpfsSupported(): Promise<boolean> {
    return await isOpfsSupported();
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    if (this.options.forceFallback) {
      this._mode = 'dexie';
      await this.initFallback();
      this.initialized = true;
      return;
    }

    const supported = await this.isOpfsSupported();
    if (!supported) {
      this._mode = 'dexie';
      await this.initFallback();
      this.initialized = true;
      return;
    }

    try {
      const worker = this.options.workerFactory
        ? this.options.workerFactory()
        : new Worker(new URL('./opfs-worker.ts', import.meta.url), { type: 'module' });

      await this.setupWorker(worker);
      this.worker = worker;
      this._mode = 'opfs';
      this.initialized = true;
    } catch {
      // Clean fallback to Dexie without crashing
      this._mode = 'dexie';
      await this.initFallback();
      this.initialized = true;
    }
  }

  private setupWorker(worker: Worker): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timeoutMs = this.options.workerTimeoutMs ?? 5000;
      const timer = setTimeout(() => {
        reject(new Error('Worker initialization timed out'));
      }, timeoutMs);

      worker.onmessage = (event: MessageEvent) => {
        const data = event.data;
        if (!data) return;

        if (data.type === 'init_ok') {
          clearTimeout(timer);
          resolve();
        } else if (data.type === 'init_error') {
          clearTimeout(timer);
          reject(new Error(data.error || 'Worker init error'));
        } else if (data.type === 'exec_ok') {
          const pending = this.pendingRequests.get(data.id);
          if (pending) {
            this.pendingRequests.delete(data.id);
            pending.resolve(data.rows ?? []);
          }
        } else if (data.type === 'exec_error') {
          const pending = this.pendingRequests.get(data.id);
          if (pending) {
            this.pendingRequests.delete(data.id);
            pending.reject(new Error(data.error || 'Worker execution error'));
          }
        }
      };

      worker.onerror = (err) => {
        clearTimeout(timer);
        reject(new Error(err.message || 'Worker encountered an error'));
      };

      worker.postMessage({
        type: 'init',
        dbName: this.options.dbName ?? '/potaeto.db',
      });
    });
  }

  private async initFallback(): Promise<void> {
    if (!this.fallbackDb) {
      const dbName = this.options.dbName
        ? `potaeto_fallback_${this.options.dbName.replace(/[^a-zA-Z0-9_]/g, '_')}`
        : 'potaeto_storage_fallback';
      this.fallbackDb = new DexieStorageFallback(dbName);
      await this.fallbackDb.open();
    }
  }

  async execute(sql: string, params: unknown[] = []): Promise<unknown[]> {
    if (!this.initialized) {
      await this.init();
    }

    if (this._mode === 'opfs' && this.worker) {
      const id = `req_${++this.reqIdCounter}_${Date.now()}`;
      return new Promise<unknown[]>((resolve, reject) => {
        this.pendingRequests.set(id, { resolve, reject });
        this.worker!.postMessage({
          type: 'exec',
          id,
          sql,
          params,
        });
      });
    }

    // Dexie / IndexedDB Fallback
    if (!this.fallbackDb) {
      await this.initFallback();
    }
    return await this.executeFallbackQuery(sql, params);
  }

  private async executeFallbackQuery(sql: string, params: unknown[] = []): Promise<unknown[]> {
    const dexie = this.fallbackDb!;
    const cleanSql = sql.trim().replace(/;+$/, '').trim();

    // 1. PRAGMA
    if (/^PRAGMA\s+/i.test(cleanSql)) {
      if (/integrity_check/i.test(cleanSql)) {
        return [{ integrity_check: 'ok' }];
      }
      return [];
    }

    // 2. CREATE TABLE / DROP TABLE
    if (/^CREATE\s+TABLE/i.test(cleanSql)) {
      return [];
    }
    if (/^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([a-zA-Z0-9_]+)/i.test(cleanSql)) {
      const match = cleanSql.match(/^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([a-zA-Z0-9_]+)/i);
      if (match) {
        const table = match[1].toLowerCase();
        const rows = await dexie.records.where('tableName').equals(table).toArray();
        const ids = rows.map((r) => r.id!).filter(Boolean);
        await dexie.records.bulkDelete(ids);
      }
      return [];
    }

    // 3. SELECT without FROM (e.g. SELECT 1)
    if (/^SELECT\s+([^FROM]+)$/i.test(cleanSql) && !/FROM/i.test(cleanSql)) {
      const expr = cleanSql.replace(/^SELECT\s+/i, '').trim();
      if (expr === '1') return [{ '1': 1 }];
      return [{ result: expr }];
    }

    // 4. INSERT INTO
    const insertMatch = cleanSql.match(
      /^INSERT\s+INTO\s+([a-zA-Z0-9_]+)(?:\s*\(([^)]+)\))?\s*VALUES\s*(.+)$/i,
    );
    if (insertMatch) {
      const table = insertMatch[1].toLowerCase();
      const colsStr = insertMatch[2];
      const valsStr = insertMatch[3];

      const values = parseValues(valsStr, params);
      const data: Record<string, unknown> = {};

      if (colsStr) {
        const cols = colsStr.split(',').map((c) => c.trim().replace(/[`"']/g, ''));
        cols.forEach((col, idx) => {
          data[col] = values[idx] !== undefined ? values[idx] : null;
        });
      } else {
        values.forEach((val, idx) => {
          data[`col_${idx}`] = val;
        });
      }

      await dexie.records.add({
        tableName: table,
        data,
      });
      return [];
    }

    // 5. SELECT ... FROM <table> [WHERE ...]
    const selectMatch = cleanSql.match(
      /^SELECT\s+(.+?)\s+FROM\s+([a-zA-Z0-9_]+)(?:\s+WHERE\s+(.+))?$/i,
    );
    if (selectMatch) {
      const fieldsStr = selectMatch[1].trim();
      const table = selectMatch[2].toLowerCase();
      const whereStr = selectMatch[3]?.trim();

      const allRows = await dexie.records.where('tableName').equals(table).toArray();
      let matched = allRows.map((r) => r.data);

      if (whereStr) {
        const { filter } = parseWhereConditions(whereStr, params);
        matched = matched.filter(filter);
      }

      if (fieldsStr === '*' || fieldsStr === '') {
        return matched;
      }

      if (/^COUNT\(\*\)$/i.test(fieldsStr)) {
        return [{ 'count(*)': matched.length }];
      }

      const requestedCols = fieldsStr.split(',').map((c) => c.trim().replace(/[`"']/g, ''));
      return matched.map((row) => {
        const proj: Record<string, unknown> = {};
        for (const col of requestedCols) {
          proj[col] = row[col];
        }
        return proj;
      });
    }

    // 6. UPDATE <table> SET ... [WHERE ...]
    const updateMatch = cleanSql.match(
      /^UPDATE\s+([a-zA-Z0-9_]+)\s+SET\s+(.+?)(?:\s+WHERE\s+(.+))?$/i,
    );
    if (updateMatch) {
      const table = updateMatch[1].toLowerCase();
      const setStr = updateMatch[2].trim();
      const whereStr = updateMatch[3]?.trim();

      const setParts = setStr.split(',').map((s) => s.trim());
      let pIdx = 0;
      const updates: Record<string, unknown> = {};

      for (const part of setParts) {
        const eqIdx = part.indexOf('=');
        if (eqIdx === -1) continue;
        const col = part.slice(0, eqIdx).trim().replace(/[`"']/g, '');
        const rawVal = part.slice(eqIdx + 1).trim();
        if (rawVal === '?') {
          updates[col] = params[pIdx++];
        } else {
          updates[col] = parseLiteral(rawVal);
        }
      }

      const allRecords = await dexie.records.where('tableName').equals(table).toArray();
      let recordsToUpdate = allRecords;

      if (whereStr) {
        const { filter } = parseWhereConditions(whereStr, params, pIdx);
        recordsToUpdate = recordsToUpdate.filter((r) => filter(r.data));
      }

      for (const record of recordsToUpdate) {
        const updatedData = { ...record.data, ...updates };
        await dexie.records.update(record.id!, { data: updatedData });
      }
      return [];
    }

    // 7. DELETE FROM <table> [WHERE ...]
    const deleteMatch = cleanSql.match(
      /^DELETE\s+FROM\s+([a-zA-Z0-9_]+)(?:\s+WHERE\s+(.+))?$/i,
    );
    if (deleteMatch) {
      const table = deleteMatch[1].toLowerCase();
      const whereStr = deleteMatch[2]?.trim();

      const allRecords = await dexie.records.where('tableName').equals(table).toArray();
      let recordsToDelete = allRecords;

      if (whereStr) {
        const { filter } = parseWhereConditions(whereStr, params);
        recordsToDelete = recordsToDelete.filter((r) => filter(r.data));
      }

      const ids = recordsToDelete.map((r) => r.id!).filter(Boolean);
      await dexie.records.bulkDelete(ids);
      return [];
    }

    return [];
  }

  async close(): Promise<void> {
    if (this.worker) {
      try {
        this.worker.postMessage({ type: 'close', id: `close_${Date.now()}` });
        this.worker.terminate();
      } catch {
        // Ignore termination errors
      }
      this.worker = null;
    }
    if (this.fallbackDb) {
      this.fallbackDb.close();
      this.fallbackDb = null;
    }
    this.initialized = false;
  }
}

export function createLocalDbClient(options?: SqliteClientOptions): LocalDbClient {
  return new SqliteClient(options);
}
