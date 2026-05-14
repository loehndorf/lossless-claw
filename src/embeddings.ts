import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { VectorSearchConfig } from "./db/config.js";
import type { SummarySearchResult } from "./store/summary-store.js";
import { parseUtcTimestamp } from "./store/parse-utc-timestamp.js";

export type EmbeddingTargetType = "message" | "summary" | "large_file";

export type EmbeddingProvider = {
  provider: string;
  model: string;
  dimensions?: number;
  embed(texts: string[]): Promise<number[][]>;
};

export type EmbeddingModelRecord = {
  embeddingModelId: string;
  provider: string;
  model: string;
  dimensions: number;
  baseUrl?: string;
  configHash: string;
};

export type EmbeddingQueueItem = {
  targetType: EmbeddingTargetType;
  targetId: string;
  embeddingModelId: string;
  reason: string | null;
  attempts: number;
  lastError: string | null;
  requestedAt: Date;
};

export type SummaryEmbeddingJob = EmbeddingQueueItem & {
  conversationId: number;
  content: string;
  contentHash: string;
};

export type EmbeddingDrainResult = {
  processed: number;
  embedded: number;
  skipped: number;
  failed: number;
};

export function hashEmbeddingContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function hashModelConfig(input: Pick<VectorSearchConfig, "provider" | "model" | "baseUrl" | "dimensions">): string {
  return createHash("sha256")
    .update(JSON.stringify({
      provider: input.provider,
      model: input.model,
      baseUrl: input.baseUrl ?? "",
      dimensions: input.dimensions ?? null,
    }))
    .digest("hex")
    .slice(0, 16);
}

export function buildEmbeddingModelId(config: Pick<VectorSearchConfig, "provider" | "model" | "baseUrl" | "dimensions">): string {
  const provider = config.provider.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "provider";
  const model = config.model.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "model";
  return `${provider}:${model}:${hashModelConfig(config)}`;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    aNorm += av * av;
    bNorm += bv * bv;
  }
  if (aNorm <= 0 || bNorm <= 0) return 0;
  return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm));
}

function safeParseVector(value: string): number[] | null {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return null;
    const vector = parsed.map((entry) => typeof entry === "number" && Number.isFinite(entry) ? entry : NaN);
    return vector.every((entry) => Number.isFinite(entry)) ? vector : null;
  } catch {
    return null;
  }
}

function createSnippet(content: string, maxLen = 220): string {
  const singleLine = content.replace(/\s+/g, " ").trim();
  return singleLine.length <= maxLen ? singleLine : `${singleLine.slice(0, maxLen - 3)}...`;
}

function embeddingProviderBaseUrl(config: VectorSearchConfig): string {
  const configured = config.baseUrl?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  const provider = config.provider.trim().toLowerCase();
  if (provider === "ollama") return "http://localhost:11434";
  if (provider === "openrouter") return "https://openrouter.ai/api/v1";
  if (provider === "openai") return "https://api.openai.com/v1";
  return "";
}

function embeddingEndpoint(config: VectorSearchConfig): string {
  const baseUrl = embeddingProviderBaseUrl(config);
  if (!baseUrl) throw new Error(`No embedding baseUrl configured for provider '${config.provider}'.`);
  const provider = config.provider.trim().toLowerCase();
  if (provider === "ollama") return `${baseUrl}/api/embed`;
  return `${baseUrl}/embeddings`;
}

function parseEmbeddingVector(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const vector = value.map((entry) => typeof entry === "number" && Number.isFinite(entry) ? entry : NaN);
  return vector.length > 0 && vector.every((entry) => Number.isFinite(entry)) ? vector : null;
}

function parseOllamaEmbeddings(payload: unknown): number[][] {
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  const embeddings = record.embeddings;
  if (Array.isArray(embeddings)) {
    return embeddings.map(parseEmbeddingVector).filter((entry): entry is number[] => entry !== null);
  }
  const embedding = parseEmbeddingVector(record.embedding);
  return embedding ? [embedding] : [];
}

function parseOpenAiEmbeddings(payload: unknown): number[][] {
  if (!payload || typeof payload !== "object") return [];
  const data = (payload as Record<string, unknown>).data;
  if (!Array.isArray(data)) return [];
  return data
    .map((entry) => entry && typeof entry === "object" ? parseEmbeddingVector((entry as Record<string, unknown>).embedding) : null)
    .filter((entry): entry is number[] => entry !== null);
}

export class HttpEmbeddingProvider implements EmbeddingProvider {
  provider: string;
  model: string;
  dimensions?: number;

  constructor(
    private config: VectorSearchConfig,
    private fetchImpl: typeof fetch = fetch,
  ) {
    this.provider = config.provider;
    this.model = config.model;
    this.dimensions = config.dimensions;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const provider = this.config.provider.trim().toLowerCase();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (this.config.apiKey && provider !== "ollama") {
        headers.authorization = `Bearer ${this.config.apiKey}`;
      }
      const body = provider === "ollama"
        ? { model: this.config.model, input: texts }
        : { model: this.config.model, input: texts };
      const response = await this.fetchImpl(embeddingEndpoint(this.config), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const bodyText = await response.text().catch(() => "");
        throw new Error(`Embedding provider ${provider} returned HTTP ${response.status}${bodyText ? `: ${bodyText.slice(0, 300)}` : ""}`);
      }
      const payload = await response.json() as unknown;
      const vectors = provider === "ollama" ? parseOllamaEmbeddings(payload) : parseOpenAiEmbeddings(payload);
      if (vectors.length !== texts.length) {
        throw new Error(`Embedding provider ${provider} returned ${vectors.length} vectors for ${texts.length} inputs.`);
      }
      const dimensions = vectors[0]?.length ?? 0;
      if (dimensions <= 0 || vectors.some((vector) => vector.length !== dimensions)) {
        throw new Error(`Embedding provider ${provider} returned empty or mixed-dimension vectors.`);
      }
      this.dimensions = dimensions;
      return vectors;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Embedding provider ${provider} timed out after ${this.config.timeoutMs}ms.`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function toQueueItem(row: {
  target_type: EmbeddingTargetType;
  target_id: string;
  embedding_model_id: string;
  reason: string | null;
  attempts: number;
  last_error: string | null;
  requested_at: string;
}): EmbeddingQueueItem {
  return {
    targetType: row.target_type,
    targetId: row.target_id,
    embeddingModelId: row.embedding_model_id,
    reason: row.reason,
    attempts: row.attempts,
    lastError: row.last_error,
    requestedAt: parseUtcTimestamp(row.requested_at),
  };
}

export class EmbeddingStore {
  constructor(private db: DatabaseSync) {}

  ensureSchema(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS embedding_models (
      embedding_model_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      base_url TEXT,
      config_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS embeddings (
      target_type TEXT NOT NULL CHECK (target_type IN ('message', 'summary', 'large_file')),
      target_id TEXT NOT NULL,
      conversation_id INTEGER NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
      embedding_model_id TEXT NOT NULL REFERENCES embedding_models(embedding_model_id) ON DELETE CASCADE,
      content_hash TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      vector_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (target_type, target_id, embedding_model_id)
    );

    CREATE TABLE IF NOT EXISTS embedding_queue (
      target_type TEXT NOT NULL CHECK (target_type IN ('message', 'summary', 'large_file')),
      target_id TEXT NOT NULL,
      embedding_model_id TEXT NOT NULL REFERENCES embedding_models(embedding_model_id) ON DELETE CASCADE,
      reason TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      requested_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (target_type, target_id, embedding_model_id)
    );

    CREATE INDEX IF NOT EXISTS embeddings_model_type_idx
      ON embeddings (embedding_model_id, target_type, conversation_id);
    CREATE INDEX IF NOT EXISTS embeddings_content_hash_idx ON embeddings (content_hash);
    CREATE INDEX IF NOT EXISTS embedding_queue_requested_idx
      ON embedding_queue (embedding_model_id, requested_at);`);
  }

  ensureModel(config: VectorSearchConfig, dimensions: number): EmbeddingModelRecord {
    this.ensureSchema();
    const embeddingModelId = buildEmbeddingModelId({
      provider: config.provider,
      model: config.model,
      baseUrl: config.baseUrl,
      dimensions: config.dimensions ?? dimensions,
    });
    const configHash = hashModelConfig({
      provider: config.provider,
      model: config.model,
      baseUrl: config.baseUrl,
      dimensions: config.dimensions ?? dimensions,
    });
    this.db.prepare(`INSERT INTO embedding_models (embedding_model_id, provider, model, dimensions, base_url, config_hash)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(embedding_model_id) DO UPDATE SET
        provider = excluded.provider,
        model = excluded.model,
        dimensions = excluded.dimensions,
        base_url = excluded.base_url,
        config_hash = excluded.config_hash`).run(
      embeddingModelId,
      config.provider,
      config.model,
      Math.floor(dimensions),
      config.baseUrl ?? null,
      configHash,
    );
    return {
      embeddingModelId,
      provider: config.provider,
      model: config.model,
      dimensions: Math.floor(dimensions),
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      configHash,
    };
  }

  upsertEmbedding(input: {
    targetType: EmbeddingTargetType;
    targetId: string;
    conversationId: number;
    embeddingModelId: string;
    content: string;
    vector: number[];
  }): void {
    this.ensureSchema();
    this.db.prepare(`INSERT INTO embeddings (target_type, target_id, conversation_id, embedding_model_id, content_hash, dimensions, vector_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(target_type, target_id, embedding_model_id) DO UPDATE SET
        conversation_id = excluded.conversation_id,
        content_hash = excluded.content_hash,
        dimensions = excluded.dimensions,
        vector_json = excluded.vector_json,
        created_at = datetime('now')`).run(
      input.targetType,
      input.targetId,
      input.conversationId,
      input.embeddingModelId,
      hashEmbeddingContent(input.content),
      input.vector.length,
      JSON.stringify(input.vector),
    );
  }

  enqueueSummary(summaryId: string, embeddingModelId: string, reason = "summary-updated"): void {
    this.enqueue("summary", summaryId, embeddingModelId, reason);
  }

  enqueue(targetType: EmbeddingTargetType, targetId: string, embeddingModelId: string, reason = "updated"): void {
    this.ensureSchema();
    this.db.prepare(`INSERT INTO embedding_queue (target_type, target_id, embedding_model_id, reason, requested_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(target_type, target_id, embedding_model_id) DO UPDATE SET
        reason = excluded.reason,
        requested_at = excluded.requested_at`).run(targetType, targetId, embeddingModelId, reason);
  }

  enqueueMissingSummaryEmbeddings(input: {
    embeddingModelId: string;
    conversationId?: number;
    reason?: string;
    limit?: number;
  }): number {
    this.ensureSchema();
    const where = ["1 = 1"];
    const args: Array<string | number> = [];
    if (input.conversationId != null) {
      where.push("s.conversation_id = ?");
      args.push(input.conversationId);
    }
    const limitSql = input.limit != null ? " LIMIT ?" : "";
    if (input.limit != null) args.push(Math.max(1, Math.floor(input.limit)));
    const rows = this.db.prepare(`SELECT s.summary_id, s.content
      FROM summaries s
      WHERE ${where.join(" AND ")}
      ORDER BY COALESCE(s.latest_at, s.created_at) DESC${limitSql}`).all(...args) as Array<{
      summary_id: string;
      content: string;
    }>;
    let enqueued = 0;
    for (const row of rows) {
      const existing = this.db.prepare(`SELECT content_hash FROM embeddings
        WHERE target_type = 'summary' AND target_id = ? AND embedding_model_id = ?`).get(
        row.summary_id,
        input.embeddingModelId,
      ) as { content_hash: string } | undefined;
      if (existing?.content_hash === hashEmbeddingContent(row.content)) continue;
      this.enqueueSummary(row.summary_id, input.embeddingModelId, input.reason ?? "missing-or-stale");
      enqueued += 1;
    }
    return enqueued;
  }

  listQueue(input: { embeddingModelId: string; targetType?: EmbeddingTargetType; limit: number }): EmbeddingQueueItem[] {
    this.ensureSchema();
    const where = ["embedding_model_id = ?"];
    const args: Array<string | number> = [input.embeddingModelId];
    if (input.targetType) {
      where.push("target_type = ?");
      args.push(input.targetType);
    }
    args.push(Math.max(1, Math.floor(input.limit)));
    const rows = this.db.prepare(`SELECT target_type, target_id, embedding_model_id, reason, attempts, last_error, requested_at
      FROM embedding_queue
      WHERE ${where.join(" AND ")}
      ORDER BY attempts ASC, requested_at ASC
      LIMIT ?`).all(...args) as Array<{
      target_type: EmbeddingTargetType;
      target_id: string;
      embedding_model_id: string;
      reason: string | null;
      attempts: number;
      last_error: string | null;
      requested_at: string;
    }>;
    return rows.map(toQueueItem);
  }

  listPendingSummaryJobs(input: { embeddingModelId: string; limit: number }): SummaryEmbeddingJob[] {
    this.ensureSchema();
    const rows = this.db.prepare(`SELECT
        q.target_type,
        q.target_id,
        q.embedding_model_id,
        q.reason,
        q.attempts,
        q.last_error,
        q.requested_at,
        s.conversation_id,
        s.content
      FROM embedding_queue q
      JOIN summaries s ON s.summary_id = q.target_id
      WHERE q.embedding_model_id = ?
        AND q.target_type = 'summary'
      ORDER BY q.attempts ASC, q.requested_at ASC
      LIMIT ?`).all(input.embeddingModelId, Math.max(1, Math.floor(input.limit))) as Array<{
      target_type: EmbeddingTargetType;
      target_id: string;
      embedding_model_id: string;
      reason: string | null;
      attempts: number;
      last_error: string | null;
      requested_at: string;
      conversation_id: number;
      content: string;
    }>;
    return rows.map((row) => ({
      ...toQueueItem(row),
      conversationId: row.conversation_id,
      content: row.content,
      contentHash: hashEmbeddingContent(row.content),
    }));
  }

  completeQueueItem(item: Pick<EmbeddingQueueItem, "targetType" | "targetId" | "embeddingModelId">): void {
    this.ensureSchema();
    this.db.prepare(`DELETE FROM embedding_queue
      WHERE target_type = ? AND target_id = ? AND embedding_model_id = ?`).run(
      item.targetType,
      item.targetId,
      item.embeddingModelId,
    );
  }

  failQueueItem(item: Pick<EmbeddingQueueItem, "targetType" | "targetId" | "embeddingModelId">, error: unknown): void {
    this.ensureSchema();
    const message = error instanceof Error ? error.message : String(error);
    this.db.prepare(`UPDATE embedding_queue
      SET attempts = attempts + 1,
          last_error = ?,
          requested_at = datetime('now')
      WHERE target_type = ? AND target_id = ? AND embedding_model_id = ?`).run(
      message.slice(0, 1000),
      item.targetType,
      item.targetId,
      item.embeddingModelId,
    );
  }

  countQueue(embeddingModelId: string): number {
    this.ensureSchema();
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM embedding_queue WHERE embedding_model_id = ?`).get(embeddingModelId) as { count: number };
    return row.count;
  }

  searchSummaryEmbeddings(input: {
    embeddingModelId: string;
    queryVector: number[];
    limit: number;
    conversationId?: number;
    allowedConversationIds?: number[];
    since?: Date;
    before?: Date;
  }): SummarySearchResult[] {
    this.ensureSchema();
    if (input.allowedConversationIds && input.allowedConversationIds.length === 0) return [];
    const where = [
      "e.embedding_model_id = ?",
      "e.target_type = 'summary'",
      "e.dimensions = ?",
    ];
    const args: Array<string | number> = [input.embeddingModelId, input.queryVector.length];
    if (input.conversationId != null) {
      where.push("s.conversation_id = ?");
      args.push(input.conversationId);
    } else if (input.allowedConversationIds) {
      where.push(`s.conversation_id IN (${input.allowedConversationIds.map(() => "?").join(",")})`);
      args.push(...input.allowedConversationIds);
    }
    if (input.since) {
      where.push("julianday(COALESCE(s.latest_at, s.created_at)) >= julianday(?)");
      args.push(input.since.toISOString());
    }
    if (input.before) {
      where.push("julianday(COALESCE(s.latest_at, s.created_at)) < julianday(?)");
      args.push(input.before.toISOString());
    }
    const rows = this.db.prepare(`SELECT
        s.summary_id,
        s.conversation_id,
        s.kind,
        s.content,
        COALESCE(s.latest_at, s.created_at) AS created_at,
        e.vector_json
      FROM embeddings e
      JOIN summaries s ON s.summary_id = e.target_id
      WHERE ${where.join(" AND ")}`).all(...args) as Array<{
      summary_id: string;
      conversation_id: number;
      kind: "leaf" | "condensed";
      content: string;
      created_at: string;
      vector_json: string;
    }>;

    const results: SummarySearchResult[] = [];
    for (const row of rows) {
      const vector = safeParseVector(row.vector_json);
      if (!vector || vector.length !== input.queryVector.length) continue;
      const score = cosineSimilarity(input.queryVector, vector);
      results.push({
        summaryId: row.summary_id,
        conversationId: row.conversation_id,
        kind: row.kind,
        snippet: createSnippet(row.content),
        createdAt: parseUtcTimestamp(row.created_at),
        rank: -score,
      });
    }

    return results
      .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0) || b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, input.limit);
  }
}

export async function drainSummaryEmbeddingQueue(input: {
  store: EmbeddingStore;
  provider: EmbeddingProvider;
  config: VectorSearchConfig;
  embeddingModelId: string;
  limit?: number;
}): Promise<EmbeddingDrainResult> {
  const jobs = input.store.listPendingSummaryJobs({
    embeddingModelId: input.embeddingModelId,
    limit: input.limit ?? input.config.indexBatchSize,
  });
  if (jobs.length === 0) {
    return { processed: 0, embedded: 0, skipped: 0, failed: 0 };
  }

  const result: EmbeddingDrainResult = { processed: jobs.length, embedded: 0, skipped: 0, failed: 0 };
  let vectors: number[][];
  try {
    vectors = await input.provider.embed(jobs.map((job) => job.content));
    if (vectors.length !== jobs.length) {
      throw new Error(`Embedding provider returned ${vectors.length} vectors for ${jobs.length} queued summary jobs.`);
    }
  } catch (error) {
    for (const job of jobs) {
      input.store.failQueueItem(job, error);
    }
    return { processed: jobs.length, embedded: 0, skipped: 0, failed: jobs.length };
  }

  for (let i = 0; i < jobs.length; i += 1) {
    const job = jobs[i]!;
    const vector = vectors[i];
    try {
      if (!vector || vector.length === 0) {
        throw new Error(`Embedding provider returned an empty vector for ${job.targetId}.`);
      }
      input.store.upsertEmbedding({
        targetType: "summary",
        targetId: job.targetId,
        conversationId: job.conversationId,
        embeddingModelId: input.embeddingModelId,
        content: job.content,
        vector,
      });
      input.store.completeQueueItem(job);
      result.embedded += 1;
    } catch (error) {
      input.store.failQueueItem(job, error);
      result.failed += 1;
    }
  }

  return result;
}

export class DeterministicEmbeddingProvider implements EmbeddingProvider {
  provider = "deterministic";
  model = "test-embedding";
  dimensions: number;

  constructor(dimensions = 16) {
    this.dimensions = dimensions;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const vector = new Array(this.dimensions).fill(0);
      for (const token of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
        const hash = createHash("sha256").update(token).digest();
        const index = hash[0]! % this.dimensions;
        vector[index] += 1;
      }
      return vector;
    });
  }
}
