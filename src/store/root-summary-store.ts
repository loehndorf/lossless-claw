/**
 * Root Index Store — persistence layer for visibility-scoped root indices.
 *
 * Terminology note: a "root summary" is the root node of a single
 * conversation/session summary DAG. This store keeps the cross-session
 * visibility index (a "book of abstracts") that is still stored in the legacy
 * `root_summaries` table/config surface for compatibility.
 */
import type { DatabaseSync } from "node:sqlite";

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS root_summaries (
    root_key TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    token_count INTEGER NOT NULL,
    source_conversation_ids TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL,
    stale INTEGER NOT NULL DEFAULT 0
  )
`;

const CREATE_STALE_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS root_summaries_stale_idx ON root_summaries (stale)
`;

export interface RootSummaryRecord {
  rootKey: string;
  content: string;
  tokenCount: number;
  sourceConversationIds: number[];
  updatedAt: Date;
  stale: boolean;
}

export interface RootSummaryUpsertInput {
  rootKey: string;
  content: string;
  tokenCount: number;
  sourceConversationIds: number[];
}

export class RootSummaryStore {
  db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec(CREATE_TABLE_SQL);
    this.db.exec(CREATE_STALE_INDEX_SQL);
  }

  get(rootKey: string): RootSummaryRecord | null {
    const stmt = this.db.prepare(
      "SELECT root_key, content, token_count, source_conversation_ids, updated_at, stale FROM root_summaries WHERE root_key = ?"
    );
    const row = stmt.get(rootKey) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToRecord(row);
  }

  getStale(): RootSummaryRecord[] {
    const stmt = this.db.prepare(
      "SELECT root_key, content, token_count, source_conversation_ids, updated_at, stale FROM root_summaries WHERE stale = 1"
    );
    const rows = stmt.all() as Record<string, unknown>[];
    return rows.map((r) => this.rowToRecord(r));
  }

  upsert(input: RootSummaryUpsertInput): void {
    const sourceIds = JSON.stringify(input.sourceConversationIds);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO root_summaries (root_key, content, token_count, source_conversation_ids, updated_at, stale)
       VALUES (?, ?, ?, ?, ?, 0)
       ON CONFLICT(root_key) DO UPDATE SET
         content = excluded.content,
         token_count = excluded.token_count,
         source_conversation_ids = excluded.source_conversation_ids,
         updated_at = excluded.updated_at,
         stale = 0`
      )
      .run(input.rootKey, input.content, input.tokenCount, sourceIds, now);
  }

  markAllStale(): void {
    this.db.prepare("UPDATE root_summaries SET stale = 1").run();
  }

  markStale(rootKey: string): void {
    this.db
      .prepare("UPDATE root_summaries SET stale = 1 WHERE root_key = ?")
      .run(rootKey);
  }

  delete(rootKey: string): void {
    this.db
      .prepare("DELETE FROM root_summaries WHERE root_key = ?")
      .run(rootKey);
  }

  list(): RootSummaryRecord[] {
    const stmt = this.db.prepare(
      "SELECT root_key, content, token_count, source_conversation_ids, updated_at, stale FROM root_summaries ORDER BY updated_at DESC"
    );
    const rows = stmt.all() as Record<string, unknown>[];
    return rows.map((r) => this.rowToRecord(r));
  }

  private rowToRecord(row: Record<string, unknown>): RootSummaryRecord {
    return {
      rootKey: row.root_key as string,
      content: row.content as string,
      tokenCount: row.token_count as number,
      sourceConversationIds: JSON.parse(
        row.source_conversation_ids as string
      ) as number[],
      updatedAt: new Date(row.updated_at as string),
      stale: (row.stale as number) === 1,
    };
  }
}
