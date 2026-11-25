import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-ignore node:sqlite is built into Node 22.13+
import { DatabaseSync } from 'node:sqlite';

class SqlitePreparedStatement {
  private sql: string;
  private db: any;
  private params: unknown[] = [];

  constructor(db: any, sql: string) {
    this.db = db;
    this.sql = sql;
  }

  bind(...values: unknown[]): SqlitePreparedStatement {
    this.params = values;
    return this;
  }

  private execQuery(): Record<string, unknown>[] {
    const stmt = this.db.prepare(this.sql);
    return stmt.all(...this.params) as Record<string, unknown>[];
  }

  async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
    const rows = this.execQuery();
    if (!rows.length) return null;
    if (colName) return (rows[0][colName] as T) ?? null;
    return rows[0] as T;
  }

  async all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: boolean; meta: Record<string, unknown> }> {
    const rows = this.execQuery();
    return { results: rows as T[], success: true, meta: {} };
  }

  async run(): Promise<{ success: boolean; meta: { changes: number; last_row_id: number } }> {
    const stmt = this.db.prepare(this.sql);
    const info = stmt.run(...this.params);
    return {
      success: true,
      meta: {
        changes: Number(info.changes),
        last_row_id: Number(info.lastInsertRowid),
      },
    };
  }
}

export function createTestDb(): { d1: D1Database; raw: any } {
  const raw = new DatabaseSync(':memory:');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const migDir = path.resolve(here, '../migrations');
  const files = fs.readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    raw.exec(fs.readFileSync(path.join(migDir, file), 'utf-8'));
  }

  const d1 = {
    prepare(sql: string) {
      return new SqlitePreparedStatement(raw, sql);
    },
    async batch(statements: SqlitePreparedStatement[]) {
      const out = [];
      for (const s of statements) {
        out.push(await s.run());
      }
      return out;
    },
    async exec(sql: string) {
      raw.exec(sql);
      return { count: 1, duration: 0 };
    },
  } as unknown as D1Database;

  return { d1, raw };
}
