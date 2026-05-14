import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { resolveLcmConfig } from "../src/db/config.js";
import { runLcmMigrations } from "../src/db/migration.js";
import {
  DeterministicEmbeddingProvider,
  EmbeddingStore,
  HttpEmbeddingProvider,
  cosineSimilarity,
  drainSummaryEmbeddingQueue,
} from "../src/embeddings.js";
import { RetrievalEngine } from "../src/retrieval.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { SummaryStore } from "../src/store/summary-store.js";

describe("vector search embeddings", () => {
  it("keeps vector search disabled by default and reads plugin config", () => {
    const defaults = resolveLcmConfig({}, {});
    expect(defaults.vectorSearch.enabled).toBe(false);
    expect(defaults.vectorSearch.provider).toBe("ollama");
    expect(defaults.vectorSearch.model).toBe("bge-m3");
    expect(defaults.vectorSearch.scope).toBe("summaries");

    const configured = resolveLcmConfig({}, {
      vectorSearch: {
        enabled: true,
        provider: "openrouter",
        model: "text-embedding-test",
        baseUrl: "https://example.test/v1",
        dimensions: 42,
        scope: "both",
        hybridWeight: 0.5,
        maxCandidates: 12,
        indexBatchSize: 3,
        timeoutMs: 1234,
      },
    });
    expect(configured.vectorSearch).toMatchObject({
      enabled: true,
      provider: "openrouter",
      model: "text-embedding-test",
      baseUrl: "https://example.test/v1",
      dimensions: 42,
      scope: "both",
      hybridWeight: 0.5,
      maxCandidates: 12,
      indexBatchSize: 3,
      timeoutMs: 1234,
    });
  });

  it("creates embedding tables in migrations", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("PRAGMA foreign_keys = ON");
      runLcmMigrations(db, { fts5Available: false });
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
      expect(tables.map((row) => row.name)).toEqual(expect.arrayContaining([
        "embedding_models",
        "embeddings",
        "embedding_queue",
      ]));
    } finally {
      db.close();
    }
  });

  it("calls Ollama /api/embed and parses batched embeddings", async () => {
    const config = resolveLcmConfig({}, {
      vectorSearch: {
        enabled: true,
        provider: "ollama",
        model: "bge-m3",
        timeoutMs: 1000,
      },
    }).vectorSearch;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
      embeddings: [[1, 0, 0], [0, 1, 0]],
    }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const provider = new HttpEmbeddingProvider(config, fetchImpl);

    const vectors = await provider.embed(["cats", "deployments"]);

    expect(vectors).toEqual([[1, 0, 0], [0, 1, 0]]);
    expect(provider.dimensions).toBe(3);
    expect(vi.mocked(fetchImpl)).toHaveBeenCalledWith("http://localhost:11434/api/embed", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ model: "bge-m3", input: ["cats", "deployments"] }),
    }));
  });

  it("drains queued summary embedding jobs", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("PRAGMA foreign_keys = ON");
      runLcmMigrations(db, { fts5Available: false });
      const conversationStore = new ConversationStore(db, { fts5Available: false });
      const summaryStore = new SummaryStore(db, { fts5Available: false });
      const embeddingStore = new EmbeddingStore(db);
      const provider = new DeterministicEmbeddingProvider(8);
      const config = resolveLcmConfig({}, {
        vectorSearch: {
          enabled: true,
          provider: provider.provider,
          model: provider.model,
          dimensions: provider.dimensions,
          scope: "summaries",
          indexBatchSize: 4,
        },
      }).vectorSearch;
      const model = embeddingStore.ensureModel(config, provider.dimensions);
      const conversation = await conversationStore.createConversation({ sessionId: "embedding-queue-test" });
      await summaryStore.insertSummary({
        summaryId: "sum_queue",
        conversationId: conversation.conversationId,
        kind: "leaf",
        content: "queued summary embedding content",
        tokenCount: 4,
      });

      expect(embeddingStore.enqueueMissingSummaryEmbeddings({ embeddingModelId: model.embeddingModelId })).toBe(1);
      const result = await drainSummaryEmbeddingQueue({
        store: embeddingStore,
        provider,
        config,
        embeddingModelId: model.embeddingModelId,
      });

      expect(result).toMatchObject({ processed: 1, embedded: 1, failed: 0 });
      expect(embeddingStore.countQueue(model.embeddingModelId)).toBe(0);
      const search = embeddingStore.searchSummaryEmbeddings({
        embeddingModelId: model.embeddingModelId,
        queryVector: (await provider.embed(["queued content"]))[0]!,
        limit: 1,
      });
      expect(search.map((summary) => summary.summaryId)).toEqual(["sum_queue"]);
    } finally {
      db.close();
    }
  });

  it("marks every queued job failed when provider batch embedding fails", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("PRAGMA foreign_keys = ON");
      runLcmMigrations(db, { fts5Available: false });
      const conversationStore = new ConversationStore(db, { fts5Available: false });
      const summaryStore = new SummaryStore(db, { fts5Available: false });
      const embeddingStore = new EmbeddingStore(db);
      const config = resolveLcmConfig({}, {
        vectorSearch: {
          enabled: true,
          provider: "deterministic",
          model: "test-embedding",
          dimensions: 8,
          scope: "summaries",
          indexBatchSize: 4,
        },
      }).vectorSearch;
      const model = embeddingStore.ensureModel(config, 8);
      const conversation = await conversationStore.createConversation({ sessionId: "embedding-fail-test" });
      for (const id of ["sum_fail_a", "sum_fail_b"] as const) {
        await summaryStore.insertSummary({
          summaryId: id,
          conversationId: conversation.conversationId,
          kind: "leaf",
          content: `content for ${id}`,
          tokenCount: 4,
        });
      }
      expect(embeddingStore.enqueueMissingSummaryEmbeddings({ embeddingModelId: model.embeddingModelId })).toBe(2);
      const provider = {
        provider: "failing",
        model: "failing",
        dimensions: 8,
        embed: vi.fn(async () => {
          throw new Error("provider offline");
        }),
      };

      const result = await drainSummaryEmbeddingQueue({
        store: embeddingStore,
        provider,
        config,
        embeddingModelId: model.embeddingModelId,
      });

      expect(result).toEqual({ processed: 2, embedded: 0, skipped: 0, failed: 2 });
      expect(embeddingStore.countQueue(model.embeddingModelId)).toBe(2);
      expect(embeddingStore.listQueue({ embeddingModelId: model.embeddingModelId, limit: 10 }).map((item) => item.attempts)).toEqual([1, 1]);
    } finally {
      db.close();
    }
  });

  it("returns summary candidates with semantic mode", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("PRAGMA foreign_keys = ON");
      runLcmMigrations(db, { fts5Available: false });
      const conversationStore = new ConversationStore(db, { fts5Available: false });
      const summaryStore = new SummaryStore(db, { fts5Available: false });
      const embeddingStore = new EmbeddingStore(db);
      const provider = new DeterministicEmbeddingProvider(16);
      const config = resolveLcmConfig({}, {
        vectorSearch: {
          enabled: true,
          provider: provider.provider,
          model: provider.model,
          dimensions: provider.dimensions,
          scope: "summaries",
        },
      }).vectorSearch;
      const model = embeddingStore.ensureModel(config, provider.dimensions);

      const conversation = await conversationStore.createConversation({ sessionId: "semantic-summary-test" });
      await summaryStore.insertSummary({
        summaryId: "sum_cats",
        conversationId: conversation.conversationId,
        kind: "leaf",
        depth: 0,
        content: "cat nutrition feeding schedule and kitten wet food notes",
        tokenCount: 10,
      });
      await summaryStore.insertSummary({
        summaryId: "sum_deploy",
        conversationId: conversation.conversationId,
        kind: "leaf",
        depth: 0,
        content: "deployment pipeline rollback migration notes",
        tokenCount: 8,
      });

      for (const [summaryId, content] of [
        ["sum_cats", "cat nutrition feeding schedule and kitten wet food notes"],
        ["sum_deploy", "deployment pipeline rollback migration notes"],
      ] as const) {
        const [vector] = await provider.embed([content]);
        embeddingStore.upsertEmbedding({
          targetType: "summary",
          targetId: summaryId,
          conversationId: conversation.conversationId,
          embeddingModelId: model.embeddingModelId,
          content,
          vector: vector!,
        });
      }

      const retrieval = new RetrievalEngine(conversationStore, summaryStore, {
        config,
        store: embeddingStore,
        provider,
      });
      const result = await retrieval.grep({
        query: "kitten food",
        mode: "semantic",
        scope: "summaries",
        conversationId: conversation.conversationId,
        limit: 1,
      });

      expect(result.summaries.map((summary) => summary.summaryId)).toEqual(["sum_cats"]);
      expect(result.totalMatches).toBe(1);
      expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
    } finally {
      db.close();
    }
  });
});
