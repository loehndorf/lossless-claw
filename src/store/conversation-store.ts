import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { withDatabaseTransaction } from "../transaction-mutex.js";
import { sanitizeFts5Query } from "./fts5-sanitize.js";
import { buildLikeSearchPlan, containsCjk, createFallbackSnippet } from "./full-text-fallback.js";
import { buildMessageIdentityHash } from "./message-identity.js";
import { parseUtcTimestamp, parseUtcTimestampOrNull } from "./parse-utc-timestamp.js";
import { buildFtsOrderBy, type SearchSort } from "./full-text-sort.js";

export type ConversationId = number;
export type MessageId = number;
export type SummaryId = string;
export type MessageRole = "system" | "user" | "assistant" | "tool";
export type MessagePartType =
  | "text"
  | "reasoning"
  | "tool"
  | "patch"
  | "file"
  | "subtask"
  | "compaction"
  | "step_start"
  | "step_finish"
  | "snapshot"
  | "agent"
  | "retry";

export type CreateMessageInput = {
  conversationId: ConversationId;
  seq: number;
  role: MessageRole;
  content: string;
  tokenCount: number;
  identityHash?: string;
  source?: MessageSourceIdentity;
};

export type MessageRecord = {
  messageId: MessageId;
  conversationId: ConversationId;
  seq: number;
  role: MessageRole;
  content: string;
  tokenCount: number;
  createdAt: Date;
  sourceProvider: string | null;
  sourceChannelId: string | null;
  sourceThreadId: string | null;
  sourceMessageId: string | null;
};

export type MessageSourceIdentity = {
  provider?: string | null;
  channelId?: string | null;
  threadId?: string | null;
  messageId?: string | null;
};

export type MessageSourceQuery = MessageSourceIdentity & {
  conversationId?: ConversationId;
  limit?: number;
};

export type SourceScopeDeletionInput = {
  provider?: string | null;
  channelId?: string | null;
  threadId?: string | null;
  scopeType: "channel" | "thread";
  reason?: string | null;
  purgeAfter?: Date | null;
};

export type CreateMessagePartInput = {
  sessionId: string;
  partType: MessagePartType;
  ordinal: number;
  textContent?: string | null;
  toolCallId?: string | null;
  toolName?: string | null;
  toolInput?: string | null;
  toolOutput?: string | null;
  metadata?: string | null;
};

export type MessagePartRecord = {
  partId: string;
  messageId: MessageId;
  sessionId: string;
  partType: MessagePartType;
  ordinal: number;
  textContent: string | null;
  toolCallId: string | null;
  toolName: string | null;
  toolInput: string | null;
  toolOutput: string | null;
  metadata: string | null;
};

export type CreateConversationInput = {
  sessionId: string;
  sessionKey?: string;
  title?: string;
  active?: boolean;
  archivedAt?: Date | null;
};

export type ConversationRecord = {
  conversationId: ConversationId;
  sessionId: string;
  sessionKey: string | null;
  active: boolean;
  archivedAt: Date | null;
  title: string | null;
  bootstrappedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type MessageSearchInput = {
  conversationId?: ConversationId;
  query: string;
  mode: "regex" | "full_text";
  since?: Date;
  before?: Date;
  limit?: number;
  sort?: SearchSort;
  allowedConversationIds?: ConversationId[];
};

export type MessageSearchResult = {
  messageId: MessageId;
  conversationId: ConversationId;
  role: MessageRole;
  snippet: string;
  createdAt: Date;
  rank?: number;
};

// ── DB row shapes (snake_case) ────────────────────────────────────────────────

interface ConversationRow {
  conversation_id: number;
  session_id: string;
  session_key: string | null;
  active: number;
  archived_at: string | null;
  title: string | null;
  bootstrapped_at: string | null;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  message_id: number;
  conversation_id: number;
  seq: number;
  role: MessageRole;
  content: string;
  token_count: number;
  created_at: string;
  source_provider?: string | null;
  source_channel_id?: string | null;
  source_thread_id?: string | null;
  source_message_id?: string | null;
}

interface MessageSearchRow {
  message_id: number;
  conversation_id: number;
  role: MessageRole;
  snippet: string;
  rank: number;
  created_at: string;
}

interface MessagePartRow {
  part_id: string;
  message_id: number;
  session_id: string;
  part_type: MessagePartType;
  ordinal: number;
  text_content: string | null;
  tool_call_id: string | null;
  tool_name: string | null;
  tool_input: string | null;
  tool_output: string | null;
  metadata: string | null;
}

interface CountRow {
  count: number;
}

interface MaxSeqRow {
  max_seq: number;
}

// ── Row mappers ───────────────────────────────────────────────────────────────

function toConversationRecord(row: ConversationRow): ConversationRecord {
  return {
    conversationId: row.conversation_id,
    sessionId: row.session_id,
    sessionKey: row.session_key ?? null,
    active: row.active === 1,
    archivedAt: parseUtcTimestampOrNull(row.archived_at),
    title: row.title,
    bootstrappedAt: parseUtcTimestampOrNull(row.bootstrapped_at),
    createdAt: parseUtcTimestamp(row.created_at),
    updatedAt: parseUtcTimestamp(row.updated_at),
  };
}

function toMessageRecord(row: MessageRow): MessageRecord {
  return {
    messageId: row.message_id,
    conversationId: row.conversation_id,
    seq: row.seq,
    role: row.role,
    content: row.content,
    tokenCount: row.token_count,
    createdAt: parseUtcTimestamp(row.created_at),
    sourceProvider: row.source_provider ?? null,
    sourceChannelId: row.source_channel_id ?? null,
    sourceThreadId: row.source_thread_id ?? null,
    sourceMessageId: row.source_message_id ?? null,
  };
}

function normalizeSourceField(value: string | null | undefined): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized.length > 0 ? normalized : null;
}

function normalizeSourceIdentity(source: MessageSourceIdentity | undefined): Required<MessageSourceIdentity> {
  return {
    provider: normalizeSourceField(source?.provider),
    channelId: normalizeSourceField(source?.channelId),
    threadId: normalizeSourceField(source?.threadId),
    messageId: normalizeSourceField(source?.messageId),
  };
}

function escapeSqlLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function toSearchResult(row: MessageSearchRow): MessageSearchResult {
  return {
    messageId: row.message_id,
    conversationId: row.conversation_id,
    role: row.role,
    snippet: row.snippet,
    createdAt: parseUtcTimestamp(row.created_at),
    rank: row.rank,
  };
}

function toMessagePartRecord(row: MessagePartRow): MessagePartRecord {
  return {
    partId: row.part_id,
    messageId: row.message_id,
    sessionId: row.session_id,
    partType: row.part_type,
    ordinal: row.ordinal,
    textContent: row.text_content,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    toolInput: row.tool_input,
    toolOutput: row.tool_output,
    metadata: row.metadata,
  };
}

function normalizeMessageContentForFullTextIndex(content: string): string | null {
  if (typeof content !== "string") return null;
  const trimmed = content.trim();
  if (!trimmed) {
    return null;
  }

  const isExternalizedReference =
    trimmed.startsWith("[LCM File:") || trimmed.startsWith("[LCM Tool Output:");
  if (!isExternalizedReference) {
    return content;
  }

  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return null;
  }

  const header = lines[0] ?? "";
  const summaryLines: string[] = [];
  let inSummary = false;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line === "Exploration Summary:") {
      inSummary = true;
      continue;
    }
    if (line.startsWith("Use lcm_describe")) {
      continue;
    }
    if (inSummary) {
      summaryLines.push(line);
    }
  }

  const normalized = [header, ...summaryLines].filter((line) => line.length > 0).join("\n");
  return normalized || null;
}

// ── ConversationStore ─────────────────────────────────────────────────────────

export class ConversationStore {
  private readonly fts5Available: boolean;
  private readonly messageSelectColumns =
    `message_id, conversation_id, seq, role, content, token_count, created_at,
     source_provider, source_channel_id, source_thread_id, source_message_id`;

  constructor(
    private db: DatabaseSync,
    options?: { fts5Available?: boolean },
  ) {
    this.fts5Available = options?.fts5Available ?? true;
  }

  // ── Transaction helpers ──────────────────────────────────────────────────

  async withTransaction<T>(operation: () => Promise<T> | T): Promise<T> {
    return withDatabaseTransaction(this.db, "BEGIN IMMEDIATE", operation);
  }

  // ── Conversation operations ───────────────────────────────────────────────

  async createConversation(input: CreateConversationInput): Promise<ConversationRecord> {
    try {
      const result = this.db
        .prepare(
          `INSERT INTO conversations (session_id, session_key, active, archived_at, title)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          input.sessionId,
          input.sessionKey ?? null,
          input.active === false ? 0 : 1,
          input.archivedAt?.toISOString() ?? null,
          input.title ?? null,
        );

      const row = this.db
        .prepare(
          `SELECT conversation_id, session_id, session_key, active, archived_at, title, bootstrapped_at, created_at, updated_at
         FROM conversations WHERE conversation_id = ?`,
        )
        .get(Number(result.lastInsertRowid)) as unknown as ConversationRow;

      return toConversationRecord(row);
    } catch (err: unknown) {
      // Handle UNIQUE constraint race: another writer created the conversation first
      if (
        err instanceof Error &&
        /UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE/i.test(err.message)
      ) {
        if (input.sessionKey) {
          const existing = await this.getConversationBySessionKey(input.sessionKey);
          if (existing) return existing;
        }
        const existing = await this.getConversationBySessionId(input.sessionId);
        if (existing) return existing;
      }
      throw err;
    }
  }

  async getConversation(conversationId: ConversationId): Promise<ConversationRecord | null> {
    const row = this.db
      .prepare(
        `SELECT conversation_id, session_id, session_key, active, archived_at, title, bootstrapped_at, created_at, updated_at
       FROM conversations WHERE conversation_id = ?`,
      )
      .get(conversationId) as unknown as ConversationRow | undefined;

    return row ? toConversationRecord(row) : null;
  }

  async getConversationBySessionId(sessionId: string): Promise<ConversationRecord | null> {
    const row = this.db
      .prepare(
        `SELECT conversation_id, session_id, session_key, active, archived_at, title, bootstrapped_at, created_at, updated_at
       FROM conversations
       WHERE session_id = ?
       ORDER BY active DESC, created_at DESC
       LIMIT 1`,
      )
      .get(sessionId) as unknown as ConversationRow | undefined;

    return row ? toConversationRecord(row) : null;
  }

  async getConversationBySessionKey(sessionKey: string): Promise<ConversationRecord | null> {
    const row = this.db
      .prepare(
        `SELECT conversation_id, session_id, session_key, active, archived_at, title, bootstrapped_at, created_at, updated_at
       FROM conversations
       WHERE session_key = ?
         AND active = 1
       ORDER BY created_at DESC
       LIMIT 1`,
      )
      .get(sessionKey) as unknown as ConversationRow | undefined;

    return row ? toConversationRecord(row) : null;
  }

  /** Resolve a conversation by stable session identity. */
  async getConversationForSession(input: {
    sessionId?: string;
    sessionKey?: string;
  }): Promise<ConversationRecord | null> {
    const normalizedSessionKey = input.sessionKey?.trim();
    if (normalizedSessionKey) {
      const byKey = await this.getConversationBySessionKey(normalizedSessionKey);
      if (byKey) {
        return byKey;
      }
    }

    const normalizedSessionId = input.sessionId?.trim();
    if (!normalizedSessionId) {
      return null;
    }

    return this.getConversationBySessionId(normalizedSessionId);
  }

  async getOrCreateConversation(
    sessionId: string,
    titleOrOpts?: string | { title?: string; sessionKey?: string },
  ): Promise<ConversationRecord> {
    const opts = typeof titleOrOpts === "string" ? { title: titleOrOpts } : titleOrOpts ?? {};
    const normalizedSessionKey = opts.sessionKey?.trim();
    if (normalizedSessionKey) {
      const byKey = await this.getConversationBySessionKey(normalizedSessionKey);
      if (byKey) {
        if (byKey.sessionId !== sessionId) {
          this.db
            .prepare(
              `UPDATE conversations SET session_id = ?, updated_at = datetime('now') WHERE conversation_id = ?`,
            )
            .run(sessionId, byKey.conversationId);
          byKey.sessionId = sessionId;
        }
        return byKey;
      }
    }

    const existing = await this.getConversationBySessionId(sessionId);
    if (existing) {
      if (!normalizedSessionKey) {
        return existing;
      }
      if (existing.active && !existing.sessionKey) {
        this.db
          .prepare(
            `UPDATE conversations SET session_key = ?, updated_at = datetime('now') WHERE conversation_id = ?`,
          )
          .run(normalizedSessionKey, existing.conversationId);
        existing.sessionKey = normalizedSessionKey;
        return existing;
      }
      if (existing.active && existing.sessionKey === normalizedSessionKey) {
        return existing;
      }
    }

    return this.createConversation({ sessionId, title: opts.title, sessionKey: normalizedSessionKey });
  }

  async markConversationBootstrapped(conversationId: ConversationId): Promise<void> {
    this.db
      .prepare(
        `UPDATE conversations
       SET bootstrapped_at = COALESCE(bootstrapped_at, datetime('now')),
           updated_at = datetime('now')
       WHERE conversation_id = ?`,
      )
      .run(conversationId);
  }

  async archiveConversation(conversationId: ConversationId): Promise<void> {
    this.db
      .prepare(
        `UPDATE conversations
       SET active = 0,
           archived_at = COALESCE(archived_at, datetime('now')),
           updated_at = datetime('now')
       WHERE conversation_id = ?`,
      )
      .run(conversationId);
  }

  async archiveConversations(conversationIds: ConversationId[]): Promise<number> {
    const uniqueIds = Array.from(new Set(conversationIds.filter((id) => Number.isInteger(id))));
    if (uniqueIds.length === 0) {
      return 0;
    }
    const result = this.db
      .prepare(
        `UPDATE conversations
         SET active = 0,
             archived_at = COALESCE(archived_at, datetime('now')),
             updated_at = datetime('now')
         WHERE conversation_id IN (${uniqueIds.map(() => "?").join(",")})`,
      )
      .run(...uniqueIds);
    return Number(result.changes ?? 0);
  }

  // ── Message operations ────────────────────────────────────────────────────

  async createMessage(input: CreateMessageInput): Promise<MessageRecord> {
    const identityHash = input.identityHash ?? buildMessageIdentityHash(input.role, input.content);
    const source = normalizeSourceIdentity(input.source);

    // Use INSERT OR IGNORE to handle UNIQUE constraint violations gracefully
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO messages (
           conversation_id,
           seq,
           role,
           content,
           token_count,
           identity_hash,
           source_provider,
           source_channel_id,
           source_thread_id,
           source_message_id
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.conversationId,
        input.seq,
        input.role,
        input.content,
        input.tokenCount,
        identityHash,
        source.provider,
        source.channelId,
        source.threadId,
        source.messageId,
      );

    const changes = result.changes ?? 0;

    // If INSERT OR IGNORE skipped the insert (duplicate), fetch the existing row
    if (changes === 0) {
      const existingRow = this.db
        .prepare(
          `SELECT ${this.messageSelectColumns}
         FROM messages WHERE conversation_id = ? AND identity_hash = ? AND role = ? AND content = ?
         LIMIT 1`,
        )
        .get(input.conversationId, identityHash, input.role, input.content) as unknown as MessageRow | undefined;

      if (existingRow) {
        this.updateMessageSourceIfMissing(existingRow.message_id, input.source);
        return (await this.getMessageById(existingRow.message_id)) ?? toMessageRecord(existingRow);
      }

      throw new Error(
        `createMessage failed: INSERT OR IGNORE returned no rowid for conversation=${input.conversationId} seq=${input.seq} role=${input.role}`,
      );
    }

    // INSERT succeeded – read back the message using the auto-generated message_id
    const messageId = Number(result.lastInsertRowid);

    this.indexMessageForFullText(messageId, input.content);

    const row = this.db
      .prepare(
        `SELECT ${this.messageSelectColumns}
       FROM messages WHERE message_id = ?`,
      )
      .get(messageId) as unknown as MessageRow | undefined;

    if (row) {
      return toMessageRecord(row);
    }

    // SELECT returned no row despite successful INSERT – return a synthetic record
    // This can happen in WAL mode when the read snapshot lags behind the write
    return {
      messageId,
      conversationId: input.conversationId,
      seq: input.seq,
      role: input.role,
      content: input.content,
      tokenCount: input.tokenCount,
      createdAt: new Date(),
      sourceProvider: source.provider,
      sourceChannelId: source.channelId,
      sourceThreadId: source.threadId,
      sourceMessageId: source.messageId,
    };
  }

  async createMessagesBulk(inputs: CreateMessageInput[]): Promise<MessageRecord[]> {
    if (inputs.length === 0) {
      return [];
    }
    const insertStmt = this.db.prepare(
      `INSERT INTO messages (
         conversation_id,
         seq,
         role,
         content,
         token_count,
         identity_hash,
         source_provider,
         source_channel_id,
         source_thread_id,
         source_message_id
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const selectStmt = this.db.prepare(
      `SELECT ${this.messageSelectColumns}
       FROM messages WHERE message_id = ?`,
    );

    const records: MessageRecord[] = [];
    for (const input of inputs) {
      const source = normalizeSourceIdentity(input.source);
      const result = insertStmt.run(
        input.conversationId,
        input.seq,
        input.role,
        input.content,
        input.tokenCount,
        input.identityHash ?? buildMessageIdentityHash(input.role, input.content),
        source.provider,
        source.channelId,
        source.threadId,
        source.messageId,
      );

      const messageId = Number(result.lastInsertRowid);
      this.indexMessageForFullText(messageId, input.content);
      const row = selectStmt.get(messageId) as unknown as MessageRow;
      records.push(toMessageRecord(row));
    }

    return records;
  }

  async getMessages(
    conversationId: ConversationId,
    opts?: { afterSeq?: number; limit?: number },
  ): Promise<MessageRecord[]> {
    const afterSeq = opts?.afterSeq ?? -1;
    const limit = opts?.limit;

    if (limit != null) {
      const rows = this.db
        .prepare(
          `SELECT ${this.messageSelectColumns}
         FROM messages
         WHERE conversation_id = ? AND seq > ?
         ORDER BY seq
         LIMIT ?`,
        )
        .all(conversationId, afterSeq, limit) as unknown as MessageRow[];
      return rows.map(toMessageRecord);
    }

    const rows = this.db
      .prepare(
        `SELECT ${this.messageSelectColumns}
       FROM messages
       WHERE conversation_id = ? AND seq > ?
       ORDER BY seq`,
      )
      .all(conversationId, afterSeq) as unknown as MessageRow[];
    return rows.map(toMessageRecord);
  }

  async getLastMessage(conversationId: ConversationId): Promise<MessageRecord | null> {
    const row = this.db
      .prepare(
        `SELECT ${this.messageSelectColumns}
       FROM messages
       WHERE conversation_id = ?
       ORDER BY seq DESC
       LIMIT 1`,
      )
      .get(conversationId) as unknown as MessageRow | undefined;

    return row ? toMessageRecord(row) : null;
  }

  async hasMessage(
    conversationId: ConversationId,
    role: MessageRole,
    content: string,
  ): Promise<boolean> {
    const identityHash = buildMessageIdentityHash(role, content);
    const row = this.db
      .prepare(
        `SELECT 1 AS count
       FROM messages
       WHERE conversation_id = ? AND identity_hash = ? AND role = ? AND content = ?
       LIMIT 1`,
      )
      .get(conversationId, identityHash, role, content) as unknown as CountRow | undefined;

    return row?.count === 1;
  }

  async countMessagesByIdentity(
    conversationId: ConversationId,
    role: MessageRole,
    content: string,
  ): Promise<number> {
    const identityHash = buildMessageIdentityHash(role, content);
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
       FROM messages
       WHERE conversation_id = ? AND identity_hash = ? AND role = ? AND content = ?`,
      )
      .get(conversationId, identityHash, role, content) as unknown as CountRow | undefined;

    return row?.count ?? 0;
  }

  async getMessageById(messageId: MessageId): Promise<MessageRecord | null> {
    const row = this.db
      .prepare(
        `SELECT ${this.messageSelectColumns}
       FROM messages WHERE message_id = ?`,
      )
      .get(messageId) as unknown as MessageRow | undefined;
    return row ? toMessageRecord(row) : null;
  }

  async createMessageParts(messageId: MessageId, parts: CreateMessagePartInput[]): Promise<void> {
    if (parts.length === 0) {
      return;
    }

    const stmt = this.db.prepare(
      `INSERT INTO message_parts (
         part_id,
         message_id,
         session_id,
         part_type,
         ordinal,
         text_content,
         tool_call_id,
         tool_name,
         tool_input,
         tool_output,
         metadata
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const part of parts) {
      stmt.run(
        randomUUID(),
        messageId,
        part.sessionId,
        part.partType,
        part.ordinal,
        part.textContent ?? null,
        part.toolCallId ?? null,
        part.toolName ?? null,
        part.toolInput ?? null,
        part.toolOutput ?? null,
        part.metadata ?? null,
      );
    }
  }

  async getMessageParts(messageId: MessageId): Promise<MessagePartRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT
         part_id,
         message_id,
         session_id,
         part_type,
         ordinal,
         text_content,
         tool_call_id,
         tool_name,
         tool_input,
         tool_output,
         metadata
       FROM message_parts
       WHERE message_id = ?
       ORDER BY ordinal`,
      )
      .all(messageId) as unknown as MessagePartRow[];

    return rows.map(toMessagePartRecord);
  }

  async getMessageCount(conversationId: ConversationId): Promise<number> {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?`)
      .get(conversationId) as unknown as CountRow;
    return row?.count ?? 0;
  }

  async getMaxSeq(conversationId: ConversationId): Promise<number> {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(seq), 0) AS max_seq
       FROM messages WHERE conversation_id = ?`,
      )
      .get(conversationId) as unknown as MaxSeqRow;
    return row?.max_seq ?? 0;
  }

  async listMessagesAfterSeq(conversationId: ConversationId, seq: number): Promise<MessageRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT ${this.messageSelectColumns}
         FROM messages
         WHERE conversation_id = ? AND seq >= ?
         ORDER BY seq`,
      )
      .all(conversationId, Math.floor(seq)) as unknown as MessageRow[];
    return rows.map(toMessageRecord);
  }

  async findMessagesBySource(input: MessageSourceQuery): Promise<MessageRecord[]> {
    const source = normalizeSourceIdentity(input);
    if (!source.messageId) {
      return [];
    }

    const where = ["source_message_id = ?"];
    const args: Array<string | number> = [source.messageId];
    if (input.conversationId != null) {
      where.push("conversation_id = ?");
      args.push(input.conversationId);
    }
    if (source.provider) {
      where.push("source_provider = ?");
      args.push(source.provider);
    }
    if (source.channelId) {
      where.push("source_channel_id = ?");
      args.push(source.channelId);
    }
    if (source.threadId) {
      where.push("source_thread_id = ?");
      args.push(source.threadId);
    }

    args.push(Math.max(1, Math.floor(input.limit ?? 100)));
    const rows = this.db
      .prepare(
        `SELECT ${this.messageSelectColumns}
         FROM messages
         WHERE ${where.join(" AND ")}
         ORDER BY conversation_id, seq
         LIMIT ?`,
      )
      .all(...args) as unknown as MessageRow[];
    return rows.map(toMessageRecord);
  }

  async findMessagesContainingSourceMessageId(input: {
    conversationId?: ConversationId;
    messageId: string;
    limit?: number;
  }): Promise<MessageRecord[]> {
    const messageId = normalizeSourceField(input.messageId);
    if (!messageId) {
      return [];
    }
    const where = ["content LIKE ? ESCAPE '\\'"];
    const args: Array<string | number> = [`%${escapeSqlLike(messageId)}%`];
    if (input.conversationId != null) {
      where.push("conversation_id = ?");
      args.push(input.conversationId);
    }
    args.push(Math.max(1, Math.floor(input.limit ?? 100)));

    const rows = this.db
      .prepare(
        `SELECT ${this.messageSelectColumns}
         FROM messages
         WHERE ${where.join(" AND ")}
         ORDER BY conversation_id, seq
         LIMIT ?`,
      )
      .all(...args) as unknown as MessageRow[];
    return rows
      .filter((row) => row.content.includes(messageId))
      .map(toMessageRecord);
  }

  private updateMessageSourceIfMissing(messageId: MessageId, sourceInput: MessageSourceIdentity | undefined): void {
    const source = normalizeSourceIdentity(sourceInput);
    if (!source.provider && !source.channelId && !source.threadId && !source.messageId) {
      return;
    }
    this.db
      .prepare(
        `UPDATE messages
         SET source_provider = COALESCE(source_provider, ?),
             source_channel_id = COALESCE(source_channel_id, ?),
             source_thread_id = COALESCE(source_thread_id, ?),
             source_message_id = COALESCE(source_message_id, ?)
         WHERE message_id = ?`,
      )
      .run(source.provider, source.channelId, source.threadId, source.messageId, messageId);
  }

  // ── Deletion ──────────────────────────────────────────────────────────────

  /**
   * Delete messages and their associated records (context_items, FTS, message_parts).
   *
   * Skips messages referenced in summary_messages (already compacted) to avoid
   * breaking the summary DAG. Returns the count of actually deleted messages.
   */
  async deleteMessages(messageIds: MessageId[]): Promise<number> {
    if (messageIds.length === 0) {
      return 0;
    }

    let deleted = 0;
    for (const messageId of messageIds) {
      // Skip if referenced by a summary (ON DELETE RESTRICT would fail anyway)
      const refRow = this.db
        .prepare(`SELECT 1 AS found FROM summary_messages WHERE message_id = ? LIMIT 1`)
        .get(messageId) as unknown as { found: number } | undefined;
      if (refRow) {
        continue;
      }

      // Remove from context_items first (RESTRICT constraint)
      this.db
        .prepare(`DELETE FROM context_items WHERE item_type = 'message' AND message_id = ?`)
        .run(messageId);

      this.deleteMessageFromFullText(messageId);

      // Delete the message (message_parts cascade via ON DELETE CASCADE)
      this.db.prepare(`DELETE FROM messages WHERE message_id = ?`).run(messageId);

      deleted += 1;
    }

    return deleted;
  }

  async recordSourceScopeDeletion(input: SourceScopeDeletionInput): Promise<void> {
    const channelId = normalizeSourceField(input.channelId);
    const threadId = normalizeSourceField(input.threadId);
    if (input.scopeType === "channel" && !channelId) {
      return;
    }
    if (input.scopeType === "thread" && !threadId) {
      return;
    }
    this.db
      .prepare(
        `INSERT INTO source_scope_deletions (
           provider,
           channel_id,
           thread_id,
           scope_type,
           reason,
           purge_after
         )
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        normalizeSourceField(input.provider),
        channelId,
        threadId,
        input.scopeType,
        normalizeSourceField(input.reason),
        input.purgeAfter?.toISOString() ?? null,
      );
  }

  async listConversationIdsInSourceScope(input: SourceScopeDeletionInput): Promise<ConversationId[]> {
    const channelId = normalizeSourceField(input.channelId);
    const threadId = normalizeSourceField(input.threadId);
    const provider = normalizeSourceField(input.provider);
    const ids = new Set<ConversationId>();

    if (input.scopeType === "thread" && !threadId) {
      return [];
    }
    if (input.scopeType === "channel" && !channelId) {
      return [];
    }

    const messageWhere: string[] = [];
    const messageArgs: Array<string | number> = [];
    if (provider) {
      messageWhere.push("source_provider = ?");
      messageArgs.push(provider);
    }
    if (input.scopeType === "thread") {
      messageWhere.push("source_thread_id = ?");
      messageArgs.push(threadId!);
    } else {
      messageWhere.push("source_channel_id = ?");
      messageArgs.push(channelId!);
    }
    const messageRows = this.db
      .prepare(
        `SELECT DISTINCT conversation_id
         FROM messages
         WHERE ${messageWhere.join(" AND ")}`,
      )
      .all(...messageArgs) as Array<{ conversation_id: number }>;
    for (const row of messageRows) {
      ids.add(row.conversation_id);
    }

    const sessionWhere: string[] = [];
    const sessionArgs: string[] = [];
    if (input.scopeType === "thread") {
      sessionWhere.push("session_key LIKE ?");
      sessionArgs.push(`agent:%:discord:channel:%:topic:${threadId}`);
    } else {
      sessionWhere.push("(session_key LIKE ? OR session_key LIKE ?)");
      sessionArgs.push(
        `agent:%:discord:channel:${channelId}`,
        `agent:%:discord:channel:${channelId}:%`,
      );
    }
    const sessionRows = this.db
      .prepare(
        `SELECT conversation_id
         FROM conversations
         WHERE session_key IS NOT NULL
           AND ${sessionWhere.join(" AND ")}`,
      )
      .all(...sessionArgs) as Array<{ conversation_id: number }>;
    for (const row of sessionRows) {
      ids.add(row.conversation_id);
    }

    return Array.from(ids).sort((left, right) => left - right);
  }

  // ── Search ────────────────────────────────────────────────────────────────

  async searchMessages(input: MessageSearchInput): Promise<MessageSearchResult[]> {
    if (input.allowedConversationIds && input.allowedConversationIds.length === 0) {
      return [];
    }
    if (
      input.allowedConversationIds &&
      input.conversationId != null &&
      !input.allowedConversationIds.includes(input.conversationId)
    ) {
      return [];
    }
    const limit = input.limit ?? 50;

    if (input.mode === "full_text") {
      // FTS5 unicode61 can return incomplete matches for CJK text, so route
      // those queries through the existing LIKE fallback path immediately.
      if (containsCjk(input.query)) {
        return this.searchLike(
          input.query,
          limit,
          input.conversationId,
          input.since,
          input.before,
          input.allowedConversationIds,
        );
      }
      if (this.fts5Available) {
        try {
          return this.searchFullText(
            input.query,
            limit,
            input.conversationId,
            input.since,
            input.before,
            input.sort,
            input.allowedConversationIds,
          );
        } catch {
          return this.searchLike(
            input.query,
            limit,
            input.conversationId,
            input.since,
            input.before,
            input.allowedConversationIds,
          );
        }
      }
      return this.searchLike(input.query, limit, input.conversationId, input.since, input.before, input.allowedConversationIds);
    }
    return this.searchRegex(input.query, limit, input.conversationId, input.since, input.before, input.allowedConversationIds);
  }

  private indexMessageForFullText(messageId: MessageId, content: string): void {
    if (!this.fts5Available) {
      return;
    }
    const normalizedContent = normalizeMessageContentForFullTextIndex(content);
    if (!normalizedContent) {
      return;
    }
    try {
      this.db
        .prepare(`INSERT INTO messages_fts(rowid, content) VALUES (?, ?)`)
        .run(messageId, normalizedContent);
    } catch {
      // Full-text indexing is optional. Message persistence must still succeed.
    }
  }

  private deleteMessageFromFullText(messageId: MessageId): void {
    if (!this.fts5Available) {
      return;
    }
    try {
      this.db.prepare(`DELETE FROM messages_fts WHERE rowid = ?`).run(messageId);
    } catch {
      // Ignore FTS cleanup failures; the source row deletion is authoritative.
    }
  }

  private searchFullText(
    query: string,
    limit: number,
    conversationId?: ConversationId,
    since?: Date,
    before?: Date,
    sort?: SearchSort,
    allowedConversationIds?: ConversationId[],
  ): MessageSearchResult[] {
    const where: string[] = ["messages_fts MATCH ?"];
    const args: Array<string | number> = [sanitizeFts5Query(query)];
    if (conversationId != null) {
      where.push("m.conversation_id = ?");
      args.push(conversationId);
    } else if (allowedConversationIds) {
      where.push(`m.conversation_id IN (${allowedConversationIds.map(() => "?").join(",")})`);
      args.push(...allowedConversationIds);
    }
    if (since) {
      where.push("julianday(m.created_at) >= julianday(?)");
      args.push(since.toISOString());
    }
    if (before) {
      where.push("julianday(m.created_at) < julianday(?)");
      args.push(before.toISOString());
    }
    args.push(limit);
    const orderBy = buildFtsOrderBy(sort, "m.created_at");

    const sql = `SELECT
         m.message_id,
         m.conversation_id,
         m.role,
         snippet(messages_fts, 0, '', '', '...', 32) AS snippet,
         rank,
         m.created_at
       FROM messages_fts
       JOIN messages m ON m.message_id = messages_fts.rowid
       WHERE ${where.join(" AND ")}
       ORDER BY ${orderBy}
       LIMIT ?`;
    const rows = this.db.prepare(sql).all(...args) as unknown as MessageSearchRow[];
    return rows.map(toSearchResult);
  }

  private searchLike(
    query: string,
    limit: number,
    conversationId?: ConversationId,
    since?: Date,
    before?: Date,
    allowedConversationIds?: ConversationId[],
  ): MessageSearchResult[] {
    const plan = buildLikeSearchPlan("content", query);
    if (plan.terms.length === 0) {
      return [];
    }

    const where: string[] = [...plan.where];
    const args: Array<string | number> = [...plan.args];
    if (conversationId != null) {
      where.push("conversation_id = ?");
      args.push(conversationId);
    } else if (allowedConversationIds) {
      where.push(`conversation_id IN (${allowedConversationIds.map(() => "?").join(",")})`);
      args.push(...allowedConversationIds);
    }
    if (since) {
      where.push("julianday(created_at) >= julianday(?)");
      args.push(since.toISOString());
    }
    if (before) {
      where.push("julianday(created_at) < julianday(?)");
      args.push(before.toISOString());
    }
    args.push(limit);

    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT message_id, conversation_id, seq, role, content, token_count, created_at
         FROM messages
         ${whereClause}
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(...args) as unknown as MessageRow[];

    return rows
      .map((row): MessageSearchResult | null => {
        const normalizedContent = normalizeMessageContentForFullTextIndex(row.content) ?? row.content;
        const haystack = normalizedContent.toLowerCase();
        const matchesAllTerms = plan.terms.every((term) => haystack.includes(term));
        if (!matchesAllTerms) {
          return null;
        }
        return {
          messageId: row.message_id,
          conversationId: row.conversation_id,
          role: row.role,
          snippet: createFallbackSnippet(normalizedContent, plan.terms),
          createdAt: parseUtcTimestamp(row.created_at),
          rank: 0,
        };
      })
      .filter((row): row is MessageSearchResult => row !== null);
  }

  private searchRegex(
    pattern: string,
    limit: number,
    conversationId?: ConversationId,
    since?: Date,
    before?: Date,
    allowedConversationIds?: ConversationId[],
  ): MessageSearchResult[] {
    // SQLite has no native POSIX regex; fetch candidates and filter in JS
    // Guard against ReDoS: reject patterns with nested quantifiers or excessive length
    if (pattern.length > 500 || /(\+|\*|\?)\)(\+|\*|\?|\{\d)/.test(pattern)) {
      return [];
    }
    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch {
      return [];
    }

    const where: string[] = [];
    const args: Array<string | number> = [];
    if (conversationId != null) {
      where.push("conversation_id = ?");
      args.push(conversationId);
    } else if (allowedConversationIds) {
      where.push(`conversation_id IN (${allowedConversationIds.map(() => "?").join(",")})`);
      args.push(...allowedConversationIds);
    }
    if (since) {
      where.push("julianday(created_at) >= julianday(?)");
      args.push(since.toISOString());
    }
    if (before) {
      where.push("julianday(created_at) < julianday(?)");
      args.push(before.toISOString());
    }
    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT message_id, conversation_id, seq, role, content, token_count, created_at
         FROM messages
         ${whereClause}
         ORDER BY created_at DESC`,
      )
      .all(...args) as unknown as MessageRow[];

    const MAX_ROW_SCAN = 10_000;
    const results: MessageSearchResult[] = [];
    let scanned = 0;
    for (const row of rows) {
      if (results.length >= limit || scanned >= MAX_ROW_SCAN) {
        break;
      }
      scanned++;
      const match = re.exec(row.content);
      if (match) {
        results.push({
          messageId: row.message_id,
          conversationId: row.conversation_id,
          role: row.role,
          snippet: match[0],
          createdAt: parseUtcTimestamp(row.created_at),
          rank: 0,
        });
      }
    }
    return results;
  }
}
