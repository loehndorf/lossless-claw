import type { DatabaseSync } from "node:sqlite";

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS session_root_summaries (
    conversation_id INTEGER PRIMARY KEY REFERENCES conversations(conversation_id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    keywords TEXT NOT NULL DEFAULT '[]',
    token_count INTEGER NOT NULL,
    source_fingerprint TEXT NOT NULL,
    source_summary_ids TEXT NOT NULL DEFAULT '[]',
    source_message_ids TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL,
    stale INTEGER NOT NULL DEFAULT 0,
    model TEXT NOT NULL DEFAULT 'unknown'
  )
`;

const CREATE_STALE_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS session_root_summaries_stale_idx
    ON session_root_summaries (stale, updated_at)
`;

export interface SessionRootSummaryRecord {
  conversationId: number;
  content: string;
  keywords: string[];
  tokenCount: number;
  sourceFingerprint: string;
  sourceSummaryIds: string[];
  sourceMessageIds: number[];
  updatedAt: Date;
  stale: boolean;
  model: string;
}

export interface SessionRootSummaryUpsertInput {
  conversationId: number;
  content: string;
  keywords?: string[];
  tokenCount: number;
  sourceFingerprint: string;
  sourceSummaryIds?: string[];
  sourceMessageIds?: number[];
  model?: string;
}

export class SessionRootSummaryStore {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec(CREATE_TABLE_SQL);
    this.db.exec(CREATE_STALE_INDEX_SQL);
  }

  get(conversationId: number): SessionRootSummaryRecord | null {
    const row = this.db
      .prepare(
        `SELECT conversation_id, content, keywords, token_count, source_fingerprint,
                source_summary_ids, source_message_ids, updated_at, stale, model
         FROM session_root_summaries
         WHERE conversation_id = ?`,
      )
      .get(conversationId) as Record<string, unknown> | undefined;
    return row ? this.rowToRecord(row) : null;
  }

  list(): SessionRootSummaryRecord[] {
    const rows = this.db
      .prepare(
        `SELECT conversation_id, content, keywords, token_count, source_fingerprint,
                source_summary_ids, source_message_ids, updated_at, stale, model
         FROM session_root_summaries
         ORDER BY updated_at DESC`,
      )
      .all() as Record<string, unknown>[];
    return rows.map((row) => this.rowToRecord(row));
  }

  listStale(): SessionRootSummaryRecord[] {
    const rows = this.db
      .prepare(
        `SELECT conversation_id, content, keywords, token_count, source_fingerprint,
                source_summary_ids, source_message_ids, updated_at, stale, model
         FROM session_root_summaries
         WHERE stale = 1
         ORDER BY updated_at ASC`,
      )
      .all() as Record<string, unknown>[];
    return rows.map((row) => this.rowToRecord(row));
  }

  upsert(input: SessionRootSummaryUpsertInput): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO session_root_summaries (
           conversation_id, content, keywords, token_count, source_fingerprint,
           source_summary_ids, source_message_ids, updated_at, stale, model
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
         ON CONFLICT(conversation_id) DO UPDATE SET
           content = excluded.content,
           keywords = excluded.keywords,
           token_count = excluded.token_count,
           source_fingerprint = excluded.source_fingerprint,
           source_summary_ids = excluded.source_summary_ids,
           source_message_ids = excluded.source_message_ids,
           updated_at = excluded.updated_at,
           stale = 0,
           model = excluded.model`,
      )
      .run(
        input.conversationId,
        input.content,
        JSON.stringify(input.keywords ?? []),
        Math.max(0, Math.floor(input.tokenCount)),
        input.sourceFingerprint,
        JSON.stringify(input.sourceSummaryIds ?? []),
        JSON.stringify(input.sourceMessageIds ?? []),
        now,
        input.model ?? "unknown",
      );
  }

  markStale(conversationId: number): void {
    this.db
      .prepare("UPDATE session_root_summaries SET stale = 1 WHERE conversation_id = ?")
      .run(conversationId);
  }

  markAllStale(): void {
    this.db.prepare("UPDATE session_root_summaries SET stale = 1").run();
  }

  delete(conversationId: number): void {
    this.db
      .prepare("DELETE FROM session_root_summaries WHERE conversation_id = ?")
      .run(conversationId);
  }

  private rowToRecord(row: Record<string, unknown>): SessionRootSummaryRecord {
    return {
      conversationId: Number(row.conversation_id),
      content: typeof row.content === "string" ? row.content : "",
      keywords: parseStringArray(row.keywords),
      tokenCount: Number(row.token_count) || 0,
      sourceFingerprint: typeof row.source_fingerprint === "string" ? row.source_fingerprint : "",
      sourceSummaryIds: parseStringArray(row.source_summary_ids),
      sourceMessageIds: parseNumberArray(row.source_message_ids),
      updatedAt: new Date(typeof row.updated_at === "string" ? row.updated_at : 0),
      stale: Number(row.stale) === 1,
      model: typeof row.model === "string" ? row.model : "unknown",
    };
  }
}

function parseStringArray(value: unknown): string[] {
  if (typeof value !== "string" || value.length === 0) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function parseNumberArray(value: unknown): number[] {
  if (typeof value !== "string" || value.length === 0) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed
          .map((item) => Number(item))
          .filter((item) => Number.isFinite(item))
          .map((item) => Math.trunc(item))
      : [];
  } catch {
    return [];
  }
}
