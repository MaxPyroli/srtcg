/**
 * Fausse base D1 pour les tests, basée sur le SQLite intégré à Node.
 * Elle reproduit ce qui compte ici : les instructions préparées, et surtout
 * batch(), qui exécute un lot comme une transaction et l'annule en entier si
 * une instruction échoue (contrainte ou RAISE d'un déclencheur), comme D1.
 */
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

type Row = Record<string, unknown>;

export class FakeStatement {
  db: DatabaseSync;
  sql: string;
  params: unknown[];

  constructor(db: DatabaseSync, sql: string, params: unknown[] = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  bind(...params: unknown[]) {
    return new FakeStatement(this.db, this.sql, params);
  }

  async all() {
    const rows = this.db.prepare(this.sql).all(...(this.params as never[])) as Row[];
    return { results: rows.map((r) => ({ ...r })), success: true, meta: {} };
  }

  async first(column?: string) {
    const row = this.db.prepare(this.sql).get(...(this.params as never[])) as Row | undefined;
    if (!row) return null;
    return column ? row[column] : { ...row };
  }

  async run() {
    const info = this.db.prepare(this.sql).run(...(this.params as never[]));
    return { success: true, results: [], meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
  }
}

export class FakeD1 {
  db: DatabaseSync;

  constructor() {
    this.db = new DatabaseSync(':memory:');
    this.db.exec('PRAGMA foreign_keys = ON');
    const dir = join(import.meta.dirname, '..', 'migrations');
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      this.db.exec(readFileSync(join(dir, file), 'utf8'));
    }
  }

  prepare(sql: string) {
    return new FakeStatement(this.db, sql);
  }

  private queue: Promise<unknown> = Promise.resolve();

  /**
   * Comme D1 : le lot est une transaction, annulée en entier si une instruction échoue.
   * Les lots sont exécutés l'un après l'autre (D1 n'écrit qu'un lot à la fois par base).
   */
  batch(statements: FakeStatement[]) {
    const run = async () => {
      this.db.exec('BEGIN');
      try {
        const out = [];
        for (const s of statements) out.push(await s.all());
        this.db.exec('COMMIT');
        return out;
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  /** Utilitaire de test pour préparer des données. */
  exec(sql: string) {
    this.db.exec(sql);
  }

  one(sql: string, ...params: unknown[]) {
    return this.db.prepare(sql).get(...(params as never[])) as Row | undefined;
  }
}
