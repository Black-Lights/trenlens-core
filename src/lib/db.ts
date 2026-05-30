'use client';

import { drizzle } from 'drizzle-orm/sqlite-proxy';
import * as schema from '@/db/schema';
import { ipc } from './ipc';

/**
 * The Drizzle ↔ Tauri bridge.
 *
 * Drizzle doesn't speak Tauri IPC, so we use its official `sqlite-proxy` driver:
 * Drizzle hands us each generated statement as `(sql, params, method)`, and we
 * route it through the Rust SQL bridge over `invoke`. Writes (`run`) go to
 * `execute_sql`; reads (`all`/`get`/`values`) go to `query_sql`, which returns
 * rows as POSITIONAL value arrays — exactly what sqlite-proxy maps back onto the
 * selected columns.
 *
 * Only reachable inside the Tauri webview (the proxy callback calls `invoke`);
 * in a plain browser the underlying IPC throws, which surfaces to the caller.
 */
export const db = drizzle(
  async (sql, params, method) => {
    if (method === 'run') {
      await ipc.executeSql(sql, params);
      return { rows: [] };
    }
    const rows = await ipc.querySql(sql, params);
    // `get` wants a single row's value-array; `all`/`values` want every row.
    // (Empty `get` yields []; our reads use `all`, so this edge is not hit.)
    return { rows: method === 'get' ? (rows[0] ?? []) : rows };
  },
  { schema },
);
