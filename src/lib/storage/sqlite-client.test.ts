import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLocalDbClient,
  isOpfsSupported,
  SqliteClient,
} from './sqlite-client';

describe('SQLite Client & OPFS SAH-Pool Storage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('isOpfsSupported', () => {
    it('returns false when Worker is not defined', async () => {
      // In jsdom environment Worker is not defined by default
      expect(await isOpfsSupported()).toBe(false);
    });

    it('returns false when navigator.storage.getDirectory is missing', async () => {
      vi.stubGlobal('Worker', class {});
      vi.stubGlobal('navigator', { storage: {} });
      expect(await isOpfsSupported()).toBe(false);
    });

    it('returns true when Worker and getDirectory are available', async () => {
      vi.stubGlobal('Worker', class {});
      vi.stubGlobal('navigator', {
        storage: {
          getDirectory: vi.fn().mockResolvedValue({}),
        },
      });
      expect(await isOpfsSupported()).toBe(true);
    });

    it('returns false when getDirectory throws an error', async () => {
      vi.stubGlobal('Worker', class {});
      vi.stubGlobal('navigator', {
        storage: {
          getDirectory: vi.fn().mockRejectedValue(new Error('Access denied')),
        },
      });
      expect(await isOpfsSupported()).toBe(false);
    });
  });

  describe('SqliteClient Fallback Behavior (Dexie / IndexedDB)', () => {
    let client: SqliteClient;

    beforeEach(async () => {
      client = new SqliteClient({
        forceFallback: true,
        dbName: `test_${Date.now()}_${Math.random()}`,
      });
      await client.init();
    });

    afterEach(async () => {
      await client.close();
    });

    it('initializes in dexie fallback mode when forced or unsupported', () => {
      expect(client.mode).toBe('dexie');
      expect(client.fallbackDatabase).not.toBeNull();
    });

    it('executes CREATE TABLE statements without error', async () => {
      const result = await client.execute(
        'CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, content TEXT);',
      );
      expect(result).toEqual([]);
    });

    it('executes INSERT, SELECT, and parameterized WHERE queries', async () => {
      await client.execute(
        'INSERT INTO messages (id, content, role) VALUES (?, ?, ?);',
        ['msg-1', 'Hello Potaeto', 'user'],
      );
      await client.execute(
        'INSERT INTO messages (id, content, role) VALUES (?, ?, ?);',
        ['msg-2', 'Hi there!', 'assistant'],
      );

      // Select all
      const all = await client.execute('SELECT * FROM messages;');
      expect(all).toHaveLength(2);
      expect(all).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'msg-1', content: 'Hello Potaeto' }),
          expect.objectContaining({ id: 'msg-2', content: 'Hi there!' }),
        ]),
      );

      // Select with WHERE parameterized condition
      const filtered = await client.execute(
        'SELECT * FROM messages WHERE role = ?;',
        ['assistant'],
      );
      expect(filtered).toHaveLength(1);
      expect(filtered[0]).toMatchObject({ id: 'msg-2', role: 'assistant' });

      // Column projection
      const projected = await client.execute(
        'SELECT content FROM messages WHERE id = ?;',
        ['msg-1'],
      );
      expect(projected).toEqual([{ content: 'Hello Potaeto' }]);

      // COUNT(*)
      const count = await client.execute('SELECT COUNT(*) FROM messages;');
      expect(count).toEqual([{ 'count(*)': 2 }]);
    });

    it('executes UPDATE and DELETE statements', async () => {
      await client.execute('INSERT INTO items (id, name) VALUES (?, ?);', ['item-1', 'Apple']);
      await client.execute('INSERT INTO items (id, name) VALUES (?, ?);', ['item-2', 'Banana']);

      // Update
      await client.execute('UPDATE items SET name = ? WHERE id = ?;', ['Apricot', 'item-1']);
      const updated = await client.execute('SELECT * FROM items WHERE id = ?;', ['item-1']);
      expect(updated[0]).toMatchObject({ id: 'item-1', name: 'Apricot' });

      // Delete
      await client.execute('DELETE FROM items WHERE id = ?;', ['item-2']);
      const remaining = await client.execute('SELECT * FROM items;');
      expect(remaining).toHaveLength(1);
      expect(remaining[0]).toMatchObject({ id: 'item-1' });
    });

    it('handles PRAGMA and SELECT without FROM', async () => {
      const pragma = await client.execute('PRAGMA integrity_check;');
      expect(pragma).toEqual([{ integrity_check: 'ok' }]);

      const selectOne = await client.execute('SELECT 1;');
      expect(selectOne).toEqual([{ '1': 1 }]);
    });

    it('handles DROP TABLE statement', async () => {
      await client.execute('INSERT INTO temp_table (key, val) VALUES (?, ?);', ['a', '1']);
      await client.execute('DROP TABLE temp_table;');
      const rows = await client.execute('SELECT * FROM temp_table;');
      expect(rows).toEqual([]);
    });
  });

  describe('SqliteClient OPFS Worker Mode', () => {
    it('initializes worker and transitions to opfs mode on success', async () => {
      vi.stubGlobal('Worker', class {});
      vi.stubGlobal('navigator', {
        storage: {
          getDirectory: vi.fn().mockResolvedValue({}),
        },
      });

      let workerListener: ((event: { data: any }) => void) | null = null;
      const postMessageSpy = vi.fn((data: any) => {
        if (data.type === 'init') {
          setTimeout(() => {
            workerListener?.({ data: { type: 'init_ok' } });
          }, 0);
        }
      });

      const mockWorker = {
        postMessage: postMessageSpy,
        set onmessage(fn: any) {
          workerListener = fn;
        },
        get onmessage() {
          return workerListener;
        },
        onerror: null,
        terminate: vi.fn(),
      } as unknown as Worker;

      const client = new SqliteClient({
        workerFactory: () => mockWorker,
      });

      await client.init();
      expect(client.mode).toBe('opfs');
      expect(postMessageSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'init' }),
      );

      await client.close();
      expect(mockWorker.terminate).toHaveBeenCalled();
    });

    it('dispatches execute queries to the worker in opfs mode', async () => {
      vi.stubGlobal('Worker', class {});
      vi.stubGlobal('navigator', {
        storage: {
          getDirectory: vi.fn().mockResolvedValue({}),
        },
      });

      let workerListener: ((event: { data: any }) => void) | null = null;
      const mockWorker = {
        postMessage: vi.fn((data: any) => {
          if (data.type === 'init') {
            setTimeout(() => {
              workerListener?.({ data: { type: 'init_ok' } });
            }, 0);
          } else if (data.type === 'exec') {
            setTimeout(() => {
              workerListener?.({
                data: {
                  type: 'exec_ok',
                  id: data.id,
                  rows: [{ col: 'value' }],
                },
              });
            }, 0);
          }
        }),
        set onmessage(fn: any) {
          workerListener = fn;
        },
        get onmessage() {
          return workerListener;
        },
        onerror: null,
        terminate: vi.fn(),
      } as unknown as Worker;

      const client = new SqliteClient({
        workerFactory: () => mockWorker,
      });

      await client.init();
      const rows = await client.execute('SELECT * FROM test;');
      expect(rows).toEqual([{ col: 'value' }]);

      await client.close();
    });

    it('gracefully falls back to dexie if worker initialization fails', async () => {
      vi.stubGlobal('Worker', class {});
      vi.stubGlobal('navigator', {
        storage: {
          getDirectory: vi.fn().mockResolvedValue({}),
        },
      });

      let workerListener: ((event: { data: any }) => void) | null = null;
      const mockWorker = {
        postMessage: vi.fn((data: any) => {
          if (data.type === 'init') {
            setTimeout(() => {
              workerListener?.({
                data: { type: 'init_error', error: 'WASM compile error' },
              });
            }, 0);
          }
        }),
        set onmessage(fn: any) {
          workerListener = fn;
        },
        get onmessage() {
          return workerListener;
        },
        onerror: null,
        terminate: vi.fn(),
      } as unknown as Worker;

      const client = new SqliteClient({
        workerFactory: () => mockWorker,
      });

      await client.init();
      expect(client.mode).toBe('dexie');
      expect(client.fallbackDatabase).not.toBeNull();

      // Can still execute queries via fallback
      const result = await client.execute('SELECT 1;');
      expect(result).toEqual([{ '1': 1 }]);

      await client.close();
    });

    it('createLocalDbClient helper constructs a working client', async () => {
      const helperClient = createLocalDbClient({ forceFallback: true });
      expect(await helperClient.isOpfsSupported()).toBe(false);
      await helperClient.init();
      expect(helperClient.mode).toBe('dexie');
      await helperClient.close();
    });
  });
});
