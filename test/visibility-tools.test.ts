import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLcmDbFeatures } from "../src/db/features.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { RetrievalEngine } from "../src/retrieval.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { SummaryStore } from "../src/store/summary-store.js";
import { createLcmDescribeTool } from "../src/tools/lcm-describe-tool.js";
import { createLcmExpandTool } from "../src/tools/lcm-expand-tool.js";
import { createLcmExpandQueryTool } from "../src/tools/lcm-expand-query-tool.js";
import { createLcmGrepTool } from "../src/tools/lcm-grep-tool.js";
import type { LcmContextEngine } from "../src/engine.js";
import type { LcmDependencies } from "../src/types.js";
import {
  createDelegatedExpansionGrant,
  resetDelegatedExpansionGrantsForTests,
} from "../src/expansion-auth.js";

function parseAgentSessionKey(sessionKey: string): { agentId: string; suffix: string } | null {
  const trimmed = sessionKey.trim();
  if (!trimmed.startsWith("agent:")) return null;
  const parts = trimmed.split(":");
  if (parts.length < 3) return null;
  return { agentId: parts[1] ?? "main", suffix: parts.slice(2).join(":") };
}

function makeDeps(): LcmDependencies {
  return {
    config: {
      enabled: true,
      databasePath: ":memory:",
      ignoreSessionPatterns: [],
      statelessSessionPatterns: [],
      skipStatelessSessions: true,
      contextThreshold: 0.75,
      freshTailCount: 8,
      newSessionRetainDepth: 2,
      leafMinFanout: 8,
      condensedMinFanout: 4,
      condensedMinFanoutHard: 2,
      incrementalMaxDepth: 0,
      leafChunkTokens: 20_000,
      leafTargetTokens: 600,
      condensedTargetTokens: 900,
      maxExpandTokens: 120,
      largeFileTokenThreshold: 25_000,
      summaryProvider: "",
      summaryModel: "",
      largeFileSummaryProvider: "",
      largeFileSummaryModel: "",
      timezone: "UTC",
      pruneHeartbeatOk: false,
      transcriptGcEnabled: false,
      proactiveThresholdCompactionMode: "deferred",
      summaryMaxOverageFactor: 3,
    },
    complete: vi.fn(),
    callGateway: vi.fn(async () => ({})),
    resolveModel: () => ({ provider: "anthropic", model: "claude-opus-4-5" }),
    getApiKey: async () => undefined,
    requireApiKey: async () => "",
    parseAgentSessionKey,
    isSubagentSessionKey: (sessionKey: string) => sessionKey.includes(":subagent:"),
    normalizeAgentId: (id?: string) => (id?.trim() ? id : "main"),
    buildSubagentSystemPrompt: () => "subagent prompt",
    readLatestAssistantReply: () => undefined,
    resolveAgentDir: () => "/tmp/openclaw-agent",
    resolveSessionIdFromSessionKey: async () => undefined,
    resolveSessionTranscriptFile: async () => undefined,
    agentLaneSubagent: "subagent",
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  } as LcmDependencies;
}

function createFixture() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const { fts5Available } = getLcmDbFeatures(db);
  runLcmMigrations(db, { fts5Available });
  const conversationStore = new ConversationStore(db, { fts5Available });
  const summaryStore = new SummaryStore(db, { fts5Available });
  const retrieval = new RetrievalEngine(conversationStore, summaryStore);
  const lcm = {
    info: { id: "lcm", name: "LCM", version: "0.0.0" },
    timezone: "UTC",
    config: {
      visibility: {
        enabled: true,
        rules: [],
        defaultPolicy: "owner-only",
        userIdSource: "sender-id",
        channelMembers: {
          "100000000000000001": ["alice"],
          "100000000000000002": ["bob"],
        },
      },
    },
    db,
    getRetrieval: () => retrieval,
    getConversationStore: () => conversationStore,
    getSummaryStore: () => summaryStore,
  } as unknown as LcmContextEngine;
  return { db, conversationStore, summaryStore, lcm };
}

async function seedVisibilityData(
  conversationStore: ConversationStore,
  summaryStore: SummaryStore,
) {
  const alice = await conversationStore.createConversation({
    sessionId: "alice-session",
    sessionKey: "agent:main:discord:channel:100000000000000001",
  });
  const bob = await conversationStore.createConversation({
    sessionId: "bob-session",
    sessionKey: "agent:main:discord:channel:100000000000000002",
  });
  await summaryStore.insertSummary({
    summaryId: "sum_alice_root",
    conversationId: alice.conversationId,
    kind: "condensed",
    depth: 1,
    content: "alice root shared marker",
    tokenCount: 5,
  });
  await summaryStore.insertSummary({
    summaryId: "sum_bob_leaf",
    conversationId: bob.conversationId,
    kind: "leaf",
    depth: 0,
    content: "bob private leaf shared marker",
    tokenCount: 7,
  });
  await conversationStore.createMessage({
    conversationId: alice.conversationId,
    seq: 1,
    role: "user",
    content: "alice visible raw shared marker",
    tokenCount: 5,
  });
  await conversationStore.createMessage({
    conversationId: bob.conversationId,
    seq: 1,
    role: "user",
    content: "bob private raw shared marker",
    tokenCount: 5,
  });
  await summaryStore.linkSummaryToParents("sum_alice_root", ["sum_bob_leaf"]);
  return { alice, bob };
}

describe("visibility-scoped LCM tools", () => {
  beforeEach(() => resetDelegatedExpansionGrantsForTests());
  afterEach(() => resetDelegatedExpansionGrantsForTests());

  it("fails closed for allConversations=true when the current user id cannot be resolved", async () => {
    const { db, lcm, conversationStore, summaryStore } = createFixture();
    try {
      await seedVisibilityData(conversationStore, summaryStore);
      const tool = createLcmDescribeTool({
        deps: makeDeps(),
        lcm,
        sessionKey: "agent:main:discord:channel:100000000000000001",
      });

      const result = await tool.execute("call-no-user", {
        id: "sum_alice_root",
        allConversations: true,
      });

      expect((result.details as { error?: string }).error).toContain("current user could not be resolved");
    } finally {
      db.close();
    }
  });

  it("does not describe known foreign IDs across conversations", async () => {
    const { db, lcm, conversationStore, summaryStore } = createFixture();
    try {
      await seedVisibilityData(conversationStore, summaryStore);
      const tool = createLcmDescribeTool({
        deps: makeDeps(),
        lcm,
        sessionKey: "agent:main:discord:channel:100000000000000001",
        senderId: "alice",
      });

      const result = await tool.execute("call-foreign-describe", {
        id: "sum_bob_leaf",
        allConversations: true,
      });

      expect((result.details as { error?: string }).error).toBe("Not found: sum_bob_leaf");
      expect((result.content[0] as { text: string }).text).not.toContain("bob private leaf");
    } finally {
      db.close();
    }
  });

  it("does not describe an explicit foreign conversationId", async () => {
    const { db, lcm, conversationStore, summaryStore } = createFixture();
    try {
      const { bob } = await seedVisibilityData(conversationStore, summaryStore);
      const tool = createLcmDescribeTool({
        deps: makeDeps(),
        lcm,
        sessionKey: "agent:main:discord:channel:100000000000000001",
        senderId: "alice",
      });

      const result = await tool.execute("call-foreign-describe-explicit", {
        id: "sum_bob_leaf",
        conversationId: bob.conversationId,
      });

      expect((result.details as { error?: string }).error).toBe("Not found: sum_bob_leaf");
      expect((result.content[0] as { text: string }).text).not.toContain("bob private leaf");
    } finally {
      db.close();
    }
  });

  it("filters lcm_grep allConversations by visibility", async () => {
    const { db, lcm, conversationStore, summaryStore } = createFixture();
    try {
      await seedVisibilityData(conversationStore, summaryStore);
      const tool = createLcmGrepTool({
        deps: makeDeps(),
        lcm,
        sessionKey: "agent:main:discord:channel:100000000000000001",
        senderId: "alice",
      });

      const result = await tool.execute("call-grep-visible", {
        pattern: "marker",
        mode: "full_text",
        allConversations: true,
      });

      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("alice");
      expect(text).not.toContain("bob private");
      expect(result.details).toMatchObject({ totalMatches: 2 });
    } finally {
      db.close();
    }
  });

  it("blocks lcm_grep for an explicit foreign conversationId", async () => {
    const { db, lcm, conversationStore, summaryStore } = createFixture();
    try {
      const { bob } = await seedVisibilityData(conversationStore, summaryStore);
      const tool = createLcmGrepTool({
        deps: makeDeps(),
        lcm,
        sessionKey: "agent:main:discord:channel:100000000000000001",
        senderId: "alice",
      });

      const result = await tool.execute("call-grep-foreign-explicit", {
        pattern: "bob",
        mode: "full_text",
        conversationId: bob.conversationId,
      });

      const text = (result.content[0] as { text: string }).text;
      expect(text).not.toContain("bob private");
      expect(result.details).toMatchObject({ totalMatches: 0 });
    } finally {
      db.close();
    }
  });

  it("filters lcm_expand_query candidates before delegation", async () => {
    const { db, lcm, conversationStore, summaryStore } = createFixture();
    try {
      const { alice } = await seedVisibilityData(conversationStore, summaryStore);
      const delegatedMessages: string[] = [];
      const deps = {
        ...makeDeps(),
        readLatestAssistantReply: vi.fn((messages: unknown[]) => {
          const last = [...messages].reverse().find((message) =>
            (message as { role?: unknown }).role === "assistant"
          ) as { content?: unknown } | undefined;
          return typeof last?.content === "string" ? last.content : undefined;
        }),
        callGateway: vi.fn(async (request: { method: string; params?: Record<string, unknown> }) => {
          if (request.method === "agent") {
            delegatedMessages.push(String(request.params?.message ?? ""));
            return { runId: "run-visible" };
          }
          if (request.method === "agent.wait") {
            return { status: "ok" };
          }
          if (request.method === "sessions.get") {
            return {
              messages: [
                {
                  role: "assistant",
                  content: JSON.stringify({
                    answer: "visible answer",
                    citedIds: ["sum_alice_root"],
                    expandedSummaryCount: 1,
                    totalSourceTokens: 5,
                    truncated: false,
                  }),
                },
              ],
            };
          }
          return {};
        }),
      } as LcmDependencies;
      const tool = createLcmExpandQueryTool({
        deps,
        lcm,
        sessionKey: "agent:main:discord:channel:100000000000000001",
        requesterSessionKey: "agent:main:discord:channel:100000000000000001",
        senderId: "alice",
      });

      const result = await tool.execute("call-expand-query-visible", {
        query: "shared marker",
        prompt: "answer from visible memory",
        allConversations: true,
      });

      expect(delegatedMessages).toHaveLength(1);
      expect(delegatedMessages[0]).toContain(`Conversation scope: ${alice.conversationId}`);
      expect(delegatedMessages[0]).toContain("sum_alice_root");
      expect(delegatedMessages[0]).not.toContain("sum_bob_leaf");
      expect(result.details).toMatchObject({
        sourceConversationIds: [alice.conversationId],
        citedIds: ["sum_alice_root"],
      });
    } finally {
      db.close();
    }
  });

  it("does not expand known foreign IDs across conversations", async () => {
    const { db, lcm, conversationStore, summaryStore } = createFixture();
    try {
      const { alice } = await seedVisibilityData(conversationStore, summaryStore);
      createDelegatedExpansionGrant({
        delegatedSessionKey: "agent:main:subagent:foreign-expand",
        issuerSessionId: "main",
        allowedConversationIds: [alice.conversationId],
        tokenCap: 120,
      });
      const tool = createLcmExpandTool({
        deps: makeDeps(),
        lcm,
        sessionId: "agent:main:subagent:foreign-expand",
        senderId: "alice",
      });

      const result = await tool.execute("call-foreign-expand", {
        summaryIds: ["sum_bob_leaf"],
        conversationId: alice.conversationId,
      });

      expect((result.content[0] as { text: string }).text).not.toContain("bob private leaf");
      expect(result.details).toMatchObject({ expansionCount: 1, totalTokens: 0 });
    } finally {
      db.close();
    }
  });

  it("blocks a foreign child in the summary DAG during describe and expand", async () => {
    const { db, lcm, conversationStore, summaryStore } = createFixture();
    try {
      const { alice } = await seedVisibilityData(conversationStore, summaryStore);
      const describeTool = createLcmDescribeTool({
        deps: makeDeps(),
        lcm,
        sessionKey: "agent:main:discord:channel:100000000000000001",
        senderId: "alice",
      });
      const described = await describeTool.execute("call-dag-describe", {
        id: "sum_alice_root",
        allConversations: true,
      });

      expect((described.content[0] as { text: string }).text).toContain("sum_alice_root");
      expect((described.content[0] as { text: string }).text).not.toContain("sum_bob_leaf");

      createDelegatedExpansionGrant({
        delegatedSessionKey: "agent:main:subagent:dag-expand",
        issuerSessionId: "main",
        allowedConversationIds: [alice.conversationId],
        tokenCap: 120,
      });
      const expandTool = createLcmExpandTool({
        deps: makeDeps(),
        lcm,
        sessionId: "agent:main:subagent:dag-expand",
        senderId: "alice",
      });
      const expanded = await expandTool.execute("call-dag-expand", {
        summaryIds: ["sum_alice_root"],
        conversationId: alice.conversationId,
        maxDepth: 2,
      });

      expect((expanded.content[0] as { text: string }).text).not.toContain("bob private leaf");
      expect(expanded.details).toMatchObject({ totalTokens: 0 });
    } finally {
      db.close();
    }
  });

  it("does not resolve a base parent channel to an arbitrary topic conversation", async () => {
    const { db, conversationStore } = createFixture();
    try {
      await conversationStore.createConversation({
        sessionId: "thread-session",
        sessionKey: "agent:main:discord:channel:100000000000000001:topic:999999999999999999",
      });

      const resolved = await conversationStore.getConversationForSession({
        sessionKey: "agent:main:discord:channel:100000000000000001",
      });

      expect(resolved).toBeNull();
    } finally {
      db.close();
    }
  });
});
