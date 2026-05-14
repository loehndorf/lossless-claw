import { describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { RootSummaryStore } from "../src/store/root-summary-store.js";
import { SessionRootSummaryStore } from "../src/store/session-root-summary-store.js";
import { materializeRootIndexKeywordsForVisibleConversations, regenerateStaleRoots, rootIndexKeysVisibleToConversation, rootKeyForSessionVisibility, sanitizeRootIndexKeywordListForTesting } from "../src/root-summary.js";
import type { VisibilityConfig } from "../src/visibility.js";
import type { RootSummaryConfig } from "../src/db/config.js";

function createRootSummaryTestDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE conversations (
      conversation_id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      session_key TEXT,
      title TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE messages (
      message_id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE summaries (
      summary_id TEXT PRIMARY KEY,
      conversation_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      depth INTEGER NOT NULL DEFAULT 0,
      content TEXT NOT NULL,
      token_count INTEGER NOT NULL,
      earliest_at TEXT,
      latest_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      stale INTEGER NOT NULL DEFAULT 0,
      invalidated_at TEXT,
      invalidation_reason TEXT
    );
    CREATE TABLE context_items (
      conversation_id INTEGER NOT NULL,
      ordinal INTEGER NOT NULL,
      item_type TEXT NOT NULL,
      message_id INTEGER,
      summary_id TEXT,
      PRIMARY KEY (conversation_id, ordinal)
    );
    CREATE TABLE channel_membership (
      channel_id TEXT PRIMARY KEY,
      is_open INTEGER NOT NULL DEFAULT 0,
      member_ids TEXT NOT NULL DEFAULT '[]',
      source TEXT NOT NULL DEFAULT 'auto',
      channel_name TEXT,
      guild_id TEXT
    );
  `);
  return db;
}

const visibility: VisibilityConfig = {
  enabled: true,
  rules: [],
  defaultPolicy: "owner-only",
  channelMembers: {
    "123456789": ["111111"],
    "987654321": ["111111"],
  },
};

const rootConfig: RootSummaryConfig = {
  enabled: true,
  maxTokens: 2000,
  scope: "user",
  minAgeMinutes: 0,
  customInstructions: "Prefer concise German bullets.",
};

describe("root-index keyword sanitization", () => {
  it("drops prompt instruction fragments leaked by failed keyword review calls", () => {
    expect(sanitizeRootIndexKeywordListForTesting([
      "review-these-root-index-keywords-for-quality",
      "title-fa9334f1-bbd6-480a-a31c-73d1ed0b930d",
      "current-keywords-rules",
      "rules",
      "return-only-a-json-array-of-strings",
      "5-12-keywords",
      "lowercase-kebab-case",
      "prefer-stable-topics-projects-concepts",
      "not-people",
      "dates",
      "generic-metadata",
      "or-vague-words",
      "avoid-root",
      "capture-the-actual-engineering-themes",
      "root-index-regeneration",
      "nightly-compaction",
      "keyword-materialization",
    ], 10)).toEqual([
      "root-index-regeneration",
      "nightly-compaction",
      "keyword-materialization",
    ]);
  });

  it("keeps real semantic domain tags after normalization", () => {
    expect(sanitizeRootIndexKeywordListForTesting([
      "Japan Etikette",
      "Onsen-Etikette",
      "crypto-writing",
      "gateway",
      "OpenClaw Support",
    ], 10)).toEqual([
      "japan-etikette",
      "onsen-etikette",
      "crypto-writing",
      "openclaw-support",
    ]);
  });
});

describe("root index regeneration", () => {
  it("indexes short uncompacted sessions from independent session root summaries", () => {
    const db = createRootSummaryTestDb();
    const rootStore = new RootSummaryStore(db);
    const sessionRootStore = new SessionRootSummaryStore(db);

    db.prepare("INSERT INTO conversations (session_id, session_key, created_at) VALUES (?, ?, ?)")
      .run("session-short", "agent:main:discord:channel:123456789", "2026-05-01T00:00:00Z");
    const conversationId = Number((db.prepare("SELECT last_insert_rowid() AS id").get() as any).id);
    db.prepare("INSERT INTO messages (conversation_id, seq, role, content) VALUES (?, ?, ?, ?)")
      .run(conversationId, 1, "user", '{"sender_id":"111111"}\nShort session about Tokyo rail passes and ryokan booking.');

    sessionRootStore.upsert({
      conversationId,
      content: "**Root Summary**\n\nShort session compares Tokyo rail passes and ryokan booking constraints.",
      keywords: ["tokyo-rail-passes", "ryokan-booking"],
      tokenCount: 18,
      sourceFingerprint: "short-frontier-v1",
      sourceMessageIds: [1],
    });

    regenerateStaleRoots(rootStore, db, visibility, rootConfig, "UTC", {
      sessionRootSummaryStore: sessionRootStore,
    });

    const scopedRoot = rootStore.get("channel:123456789");
    expect(scopedRoot?.content).toContain('id: "123456789"');
    expect(scopedRoot?.content).toContain('keywords: ["tokyo-rail-passes", "ryokan-booking"]');
    expect(scopedRoot?.sourceConversationIds).toEqual([conversationId]);

    db.close();
  });

  it("uses the context_items summary frontier instead of a single deepest summary when building a root index", () => {
    const db = createRootSummaryTestDb();
    const rootStore = new RootSummaryStore(db);

    db.prepare("INSERT INTO conversations (session_id, session_key, created_at) VALUES (?, ?, ?)")
      .run("session-1", "agent:main:discord:channel:123456789", "2026-05-01T00:00:00Z");
    const conversationId = Number((db.prepare("SELECT last_insert_rowid() AS id").get() as any).id);
    db.prepare("INSERT INTO messages (conversation_id, seq, role, content) VALUES (?, ?, ?, ?)")
      .run(conversationId, 1, "user", '{"sender_id":"111111"}\nHello');

    db.prepare("INSERT INTO summaries (summary_id, conversation_id, kind, depth, content, token_count, earliest_at, latest_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("sum_leaf_one", conversationId, "leaf", 0, "first frontier summary", 5, "2026-05-01T00:00:00Z", "2026-05-01T00:10:00Z", "2026-05-01T00:11:00Z");
    db.prepare("INSERT INTO summaries (summary_id, conversation_id, kind, depth, content, token_count, earliest_at, latest_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("sum_leaf_two", conversationId, "leaf", 0, "second frontier summary", 5, "2026-05-01T00:11:00Z", "2026-05-01T00:20:00Z", "2026-05-01T00:21:00Z");
    db.prepare("INSERT INTO summaries (summary_id, conversation_id, kind, depth, content, token_count, earliest_at, latest_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("sum_old_deep", conversationId, "condensed", 2, "old deep summary not on frontier", 5, "2026-04-01T00:00:00Z", "2026-04-01T00:10:00Z", "2026-05-02T00:00:00Z");

    db.prepare("INSERT INTO context_items (conversation_id, ordinal, item_type, summary_id) VALUES (?, ?, ?, ?)")
      .run(conversationId, 1, "summary", "sum_leaf_one");
    db.prepare("INSERT INTO context_items (conversation_id, ordinal, item_type, summary_id) VALUES (?, ?, ?, ?)")
      .run(conversationId, 2, "summary", "sum_leaf_two");

    regenerateStaleRoots(rootStore, db, visibility, rootConfig, "UTC");

    const legacyRoot = rootStore.get("111111");
    expect(legacyRoot).toBeNull();

    const scopedRoot = rootStore.get("channel:123456789");
    expect(scopedRoot?.content).not.toContain("instructions: |-");
    expect(scopedRoot?.content).toContain('id: "123456789"');
    expect(scopedRoot?.content).not.toContain("generated_at:");
    expect(scopedRoot?.content).not.toContain("timezone:");
    expect(scopedRoot?.content).not.toContain("stats:");
    expect(scopedRoot?.content).not.toContain("messages:");
    expect(scopedRoot?.content).not.toContain("depth:");
    expect(scopedRoot?.content).not.toContain("summary_id:");
    expect(scopedRoot?.content).not.toContain("one_liner:");
    expect(scopedRoot?.content).not.toContain("first frontier summary");
    expect(scopedRoot?.content).not.toContain("second frontier summary");
    expect(scopedRoot?.content).not.toContain("old deep summary not on frontier");
    expect(scopedRoot?.content).toContain('scope: "Visibility-Scope Memory Root Index (channel:123456789)"');
    expect(scopedRoot?.content).not.toContain("threads: []");
    expect(scopedRoot?.sourceConversationIds).toEqual([conversationId]);

    db.close();
  });

  it("refreshes cached keywords when the selected root-index summary changes", async () => {
    const db = createRootSummaryTestDb();
    const rootStore = new RootSummaryStore(db);
    const summarize = vi.fn(async (prompt: string) => {
      if (prompt.includes("new project abstract")) return '["new-project"]';
      return '["old-project"]';
    });

    db.prepare("INSERT INTO conversations (session_id, session_key, created_at) VALUES (?, ?, ?)")
      .run("session-keywords", "agent:main:discord:channel:123456789", "2026-05-01T00:00:00Z");
    const conversationId = Number((db.prepare("SELECT last_insert_rowid() AS id").get() as any).id);
    db.prepare("INSERT INTO messages (conversation_id, seq, role, content) VALUES (?, ?, ?, ?)")
      .run(conversationId, 1, "user", '{"sender_id":"111111"}\nHello');
    db.prepare("INSERT INTO summaries (summary_id, conversation_id, kind, depth, content, token_count) VALUES (?, ?, ?, ?, ?, ?)")
      .run("sum_keywords", conversationId, "leaf", 0, "old project abstract", 5);
    db.prepare("INSERT INTO context_items (conversation_id, ordinal, item_type, summary_id) VALUES (?, ?, ?, ?)")
      .run(conversationId, 1, "summary", "sum_keywords");

    await materializeRootIndexKeywordsForVisibleConversations({
      db,
      visibilityConfig: visibility,
      summarize,
    });
    regenerateStaleRoots(rootStore, db, visibility, rootConfig, "UTC");
    expect(rootStore.get("channel:123456789")?.content).toContain('keywords: ["old-project"]');

    db.prepare("UPDATE summaries SET content = ?, created_at = datetime('now') WHERE summary_id = ?")
      .run("new project abstract", "sum_keywords");
    await materializeRootIndexKeywordsForVisibleConversations({
      db,
      visibilityConfig: visibility,
      summarize,
    });
    rootStore.markStale("channel:123456789");
    regenerateStaleRoots(rootStore, db, visibility, rootConfig, "UTC");

    const root = rootStore.get("channel:123456789");
    expect(root?.content).toContain('keywords: ["new-project"]');
    expect(root?.content).not.toContain("old-project");

    db.close();
  });

  it("finds existing same-audience roots that should become stale for a changed session", () => {
    const db = createRootSummaryTestDb();
    db.prepare("INSERT INTO channel_membership (channel_id, member_ids, channel_name, guild_id) VALUES (?, ?, ?, ?)")
      .run("111111111", JSON.stringify(["111111", "222222"]), "current", "guild-1");
    db.prepare("INSERT INTO channel_membership (channel_id, member_ids, channel_name, guild_id) VALUES (?, ?, ?, ?)")
      .run("222222222", JSON.stringify(["111111", "222222"]), "peer", "guild-1");
    db.prepare("INSERT INTO channel_membership (channel_id, member_ids, channel_name, guild_id) VALUES (?, ?, ?, ?)")
      .run("333333333", JSON.stringify(["222222"]), "narrower", "guild-1");
    db.prepare("INSERT INTO channel_membership (channel_id, member_ids, channel_name, guild_id) VALUES (?, ?, ?, ?)")
      .run("444444444", JSON.stringify(["333333"]), "unrelated", "guild-1");

    const affected = rootIndexKeysVisibleToConversation({
      db,
      rootKeys: ["channel:111111111", "channel:333333333", "channel:444444444"],
      sourceSessionKey: "agent:main:discord:channel:222222222",
      visibilityConfig: {
        ...visibility,
        channelMembers: {
          "111111111": ["111111", "222222"],
          "222222222": ["111111", "222222"],
          "333333333": ["222222"],
          "444444444": ["333333"],
        },
      },
    });

    expect(affected).toContain("channel:111111111");
    expect(affected).toContain("channel:222222222");
    expect(affected).toContain("channel:333333333");
    expect(affected).not.toContain("channel:444444444");

    db.close();
  });

  it("includes archived same-scope conversations until they have been stale for a full year", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T00:00:00Z"));
    const db = createRootSummaryTestDb();
    const rootStore = new RootSummaryStore(db);

    db.prepare("INSERT INTO conversations (session_id, session_key, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("recent-archived", "agent:main:discord:channel:123456789", 0, "2025-12-24T00:00:00Z", "2025-12-24T00:00:00Z");
    const recentArchivedId = Number((db.prepare("SELECT last_insert_rowid() AS id").get() as any).id);
    db.prepare("INSERT INTO conversations (session_id, session_key, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("old-archived", "agent:main:discord:channel:123456789", 0, "2024-04-30T00:00:00Z", "2024-04-30T00:00:00Z");
    const oldArchivedId = Number((db.prepare("SELECT last_insert_rowid() AS id").get() as any).id);
    db.prepare("INSERT INTO conversations (session_id, session_key, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("active", "agent:main:discord:channel:123456789", 1, "2026-05-01T00:00:00Z", "2026-05-01T00:00:00Z");
    const activeId = Number((db.prepare("SELECT last_insert_rowid() AS id").get() as any).id);

    for (const [id, text, createdAt] of [
      [recentArchivedId, "recent archived same-scope memory", "2025-12-24T00:00:00Z"],
      [oldArchivedId, "old archived stale memory", "2024-04-30T00:00:00Z"],
      [activeId, "active same-scope memory", "2026-05-01T00:00:00Z"],
    ] as const) {
      db.prepare("INSERT INTO messages (conversation_id, seq, role, content, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(id, 1, "user", '{"sender_id":"111111"}\nHello', createdAt);
      db.prepare("INSERT INTO summaries (summary_id, conversation_id, kind, depth, content, token_count, latest_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(`sum_${id}`, id, "leaf", 0, text, 5, createdAt);
      db.prepare("INSERT INTO context_items (conversation_id, ordinal, item_type, summary_id) VALUES (?, ?, ?, ?)")
        .run(id, 1, "summary", `sum_${id}`);
    }

    regenerateStaleRoots(rootStore, db, visibility, rootConfig, "UTC");

    const root = rootStore.get("channel:123456789");
    expect(root?.content).not.toContain("sessions:");
    expect(root?.content).not.toContain("messages:");
    expect(root?.content).not.toContain("old archived stale memory");
    expect(root?.sourceConversationIds).toEqual([recentArchivedId, activeId]);

    db.close();
    vi.useRealTimers();
  });

  it("honors minAgeMinutes for eager root-index regeneration", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T01:00:00Z"));
    const db = createRootSummaryTestDb();
    const rootStore = new RootSummaryStore(db);

    db.prepare("INSERT INTO conversations (session_id, session_key, created_at) VALUES (?, ?, ?)")
      .run("old", "agent:main:discord:channel:123456789", "2026-05-01T00:00:00Z");
    const oldId = Number((db.prepare("SELECT last_insert_rowid() AS id").get() as any).id);
    db.prepare("INSERT INTO conversations (session_id, session_key, created_at) VALUES (?, ?, ?)")
      .run("new", "agent:main:discord:channel:123456789", "2026-05-01T00:50:00Z");
    const newId = Number((db.prepare("SELECT last_insert_rowid() AS id").get() as any).id);

    for (const [id, text] of [[oldId, "old enough"], [newId, "too new"]] as const) {
      db.prepare("INSERT INTO messages (conversation_id, seq, role, content) VALUES (?, ?, ?, ?)")
        .run(id, 1, "user", '{"sender_id":"111111"}\nHello');
      db.prepare("INSERT INTO summaries (summary_id, conversation_id, kind, depth, content, token_count) VALUES (?, ?, ?, ?, ?, ?)")
        .run(`sum_${id}`, id, "leaf", 0, text, 5);
      db.prepare("INSERT INTO context_items (conversation_id, ordinal, item_type, summary_id) VALUES (?, ?, ?, ?)")
        .run(id, 1, "summary", `sum_${id}`);
    }

    regenerateStaleRoots(rootStore, db, visibility, { ...rootConfig, minAgeMinutes: 30 }, "UTC");

    const root = rootStore.get("channel:123456789");
    expect(root?.content).not.toContain("sessions:");
    expect(root?.content).not.toContain("messages:");
    expect(root?.content).not.toContain("too new");
    expect(root?.sourceConversationIds).toEqual([oldId]);

    db.close();
    vi.useRealTimers();
  });

  it("groups visible Discord thread summaries under their parent channel", () => {
    const db = createRootSummaryTestDb();
    const rootStore = new RootSummaryStore(db);

    const insertConversation = (sessionId: string, sessionKey: string, summaryId: string, summary: string) => {
      db.prepare("INSERT INTO conversations (session_id, session_key, created_at) VALUES (?, ?, ?)")
        .run(sessionId, sessionKey, "2026-05-01T00:00:00Z");
      const conversationId = Number((db.prepare("SELECT last_insert_rowid() AS id").get() as any).id);
      db.prepare("INSERT INTO messages (conversation_id, seq, role, content) VALUES (?, ?, ?, ?)")
        .run(conversationId, 1, "user", '{"sender_id":"111111"}\nHello');
      db.prepare("INSERT INTO summaries (summary_id, conversation_id, kind, depth, content, token_count) VALUES (?, ?, ?, ?, ?, ?)")
        .run(summaryId, conversationId, "leaf", 0, summary, 5);
      db.prepare("INSERT INTO context_items (conversation_id, ordinal, item_type, summary_id) VALUES (?, ?, ?, ?)")
        .run(conversationId, 1, "summary", summaryId);
      return conversationId;
    };

    const channelId = insertConversation(
      "channel-session",
      "agent:main:discord:channel:123456789",
      "sum_channel",
      "root channel summary",
    );
    const threadId = insertConversation(
      "thread-session",
      "agent:main:discord:channel:123456789:topic:987654321",
      "sum_thread",
      "thread-specific summary",
    );

    regenerateStaleRoots(rootStore, db, visibility, rootConfig, "UTC");

    const root = rootStore.get("channel:123456789");
    expect(root?.content).toContain('id: "123456789"');
    expect(root?.content).not.toContain("messages:");
    expect(root?.content).not.toContain('threads:');
    expect(root?.content).not.toContain('id: "987654321"');
    expect(root?.content).not.toContain("root channel summary");
    expect(root?.content).not.toContain("thread-specific summary");
    expect(root?.sourceConversationIds).toEqual([channelId]);

    const threadRoot = rootStore.get("channel:123456789:topic:987654321");
    expect(threadRoot?.content).toContain('id: "987654321"');
    expect(threadRoot?.sourceConversationIds).toEqual([threadId]);

    db.close();
  });

  it("does not list a parent channel without standalone LCM history when its threads are summarized", () => {
    const db = createRootSummaryTestDb();
    const rootStore = new RootSummaryStore(db);

    db.prepare("INSERT INTO channel_membership (channel_id, member_ids, channel_name, guild_id) VALUES (?, ?, ?, ?)")
      .run("123456789", JSON.stringify(["111111"]), "dev", "guild-1");
    db.prepare("INSERT INTO channel_membership (channel_id, member_ids, channel_name, guild_id) VALUES (?, ?, ?, ?)")
      .run("987654321", JSON.stringify(["111111"]), "Openclaw Support", "guild-1");
    db.prepare("INSERT INTO conversations (session_id, session_key, created_at) VALUES (?, ?, ?)")
      .run("thread-session", "agent:main:discord:channel:123456789:topic:987654321", "2026-05-01T00:00:00Z");
    const conversationId = Number((db.prepare("SELECT last_insert_rowid() AS id").get() as any).id);
    db.prepare("INSERT INTO messages (conversation_id, seq, role, content) VALUES (?, ?, ?, ?)")
      .run(conversationId, 1, "user", '{"sender_id":"111111"}\nHello');
    db.prepare("INSERT INTO summaries (summary_id, conversation_id, kind, depth, content, token_count) VALUES (?, ?, ?, ?, ?, ?)")
      .run("sum_thread_only", conversationId, "leaf", 0, "thread-only summary", 5);
    db.prepare("INSERT INTO context_items (conversation_id, ordinal, item_type, summary_id) VALUES (?, ?, ?, ?)")
      .run(conversationId, 1, "summary", "sum_thread_only");

    rootStore.upsert({
      rootKey: "channel:123456789",
      content: "stale placeholder",
      tokenCount: 1,
      sourceConversationIds: [],
    });
    rootStore.markStale("channel:123456789");
    regenerateStaleRoots(rootStore, db, visibility, rootConfig, "UTC");

    const root = rootStore.get("channel:123456789");
    expect(root?.content).toContain('id: "987654321"');
    expect(root?.content).not.toContain("messages:");
    expect(root?.content).not.toContain("thread-only summary");
    expect(root?.content).not.toContain("visible_discord_channels_without_lcm_history");
    expect(root?.content).not.toContain("threads: []");
    expect(root?.sourceConversationIds).toEqual([conversationId]);

    db.close();
  });

  it("derives visibility-scope root-index keys from Discord session keys", () => {
    expect(rootKeyForSessionVisibility("agent:main:discord:direct:111111")).toBe("dm:111111");
    expect(rootKeyForSessionVisibility("agent:main:discord:channel:123456789")).toBe("channel:123456789");
    expect(rootKeyForSessionVisibility("agent:main:discord:channel:123456789:topic:987654321")).toBe("channel:123456789:topic:987654321");
  });

  it("keeps DM root indices isolated to the exact DM participant", () => {
    const db = createRootSummaryTestDb();
    const rootStore = new RootSummaryStore(db);

    const insertDm = (userId: string, summaryId: string, summary: string) => {
      db.prepare("INSERT INTO conversations (session_id, session_key, created_at) VALUES (?, ?, ?)")
        .run(`dm-${userId}`, `agent:main:discord:direct:${userId}`, "2026-05-01T00:00:00Z");
      const conversationId = Number((db.prepare("SELECT last_insert_rowid() AS id").get() as any).id);
      db.prepare("INSERT INTO messages (conversation_id, seq, role, content) VALUES (?, ?, ?, ?)")
        .run(conversationId, 1, "user", `dm ${userId}`);
      db.prepare("INSERT INTO summaries (summary_id, conversation_id, kind, depth, content, token_count) VALUES (?, ?, ?, ?, ?, ?)")
        .run(summaryId, conversationId, "leaf", 0, summary, 5);
      db.prepare("INSERT INTO context_items (conversation_id, ordinal, item_type, summary_id) VALUES (?, ?, ?, ?)")
        .run(conversationId, 1, "summary", summaryId);
      return conversationId;
    };

    const dm111 = insertDm("111111", "sum_dm_111111", "private dm 111111 summary");
    const dm222 = insertDm("222222", "sum_dm_222222", "private dm 222222 summary");

    regenerateStaleRoots(rootStore, db, visibility, rootConfig, "UTC");

    expect(rootStore.get("dm:111111")?.sourceConversationIds).toEqual([dm111]);
    expect(rootStore.get("dm:111111")?.content).toContain('id: "DM with 111111"');
    expect(rootStore.get("dm:111111")?.content).not.toContain('222222');
    expect(rootStore.get("dm:222222")?.sourceConversationIds).toEqual([dm222]);
    expect(rootStore.get("dm:222222")?.content).toContain('id: "DM with 222222"');
    expect(rootStore.get("dm:222222")?.content).not.toContain('111111');

    db.close();
  });

  it("does not include a thread when its parent channel audience is narrower than the current root", () => {
    const db = createRootSummaryTestDb();
    const rootStore = new RootSummaryStore(db);

    const insertConversation = (sessionId: string, sessionKey: string, summaryId: string, summary: string) => {
      db.prepare("INSERT INTO conversations (session_id, session_key, created_at) VALUES (?, ?, ?)")
        .run(sessionId, sessionKey, "2026-05-01T00:00:00Z");
      const conversationId = Number((db.prepare("SELECT last_insert_rowid() AS id").get() as any).id);
      db.prepare("INSERT INTO messages (conversation_id, seq, role, content) VALUES (?, ?, ?, ?)")
        .run(conversationId, 1, "user", '{"sender_id":"111111"}\nHello');
      db.prepare("INSERT INTO summaries (summary_id, conversation_id, kind, depth, content, token_count) VALUES (?, ?, ?, ?, ?, ?)")
        .run(summaryId, conversationId, "leaf", 0, summary, 5);
      db.prepare("INSERT INTO context_items (conversation_id, ordinal, item_type, summary_id) VALUES (?, ?, ?, ?)")
        .run(conversationId, 1, "summary", summaryId);
      return conversationId;
    };

    const currentChannelId = insertConversation(
      "current-channel",
      "agent:main:discord:channel:111111111",
      "sum_current_channel",
      "current channel memory",
    );
    const restrictedThreadId = insertConversation(
      "restricted-thread",
      "agent:main:discord:channel:222222222:topic:333333333",
      "sum_restricted_thread",
      "restricted parent thread memory",
    );

    regenerateStaleRoots(rootStore, db, {
      ...visibility,
      channelMembers: {
        "111111111": ["alice", "bob"],
        "222222222": ["alice"],
        "333333333": ["alice", "bob"],
      },
    }, rootConfig, "UTC");

    const currentRoot = rootStore.get("channel:111111111");
    expect(currentRoot?.sourceConversationIds).toEqual([currentChannelId]);
    expect(currentRoot?.sourceConversationIds).not.toContain(restrictedThreadId);
    expect(currentRoot?.content).not.toContain('id: "333333333"');

    const restrictedRoot = rootStore.get("channel:222222222:topic:333333333");
    expect(restrictedRoot?.sourceConversationIds).toEqual([restrictedThreadId]);

    db.close();
  });

  it("keeps private thread root indices isolated from parent channel root indices", () => {
    const db = createRootSummaryTestDb();
    const rootStore = new RootSummaryStore(db);

    const insertConversation = (sessionId: string, sessionKey: string, summaryId: string, summary: string) => {
      db.prepare("INSERT INTO conversations (session_id, session_key, created_at) VALUES (?, ?, ?)")
        .run(sessionId, sessionKey, "2026-05-01T00:00:00Z");
      const conversationId = Number((db.prepare("SELECT last_insert_rowid() AS id").get() as any).id);
      db.prepare("INSERT INTO messages (conversation_id, seq, role, content) VALUES (?, ?, ?, ?)")
        .run(conversationId, 1, "user", '{"sender_id":"111111"}\nHello');
      db.prepare("INSERT INTO summaries (summary_id, conversation_id, kind, depth, content, token_count) VALUES (?, ?, ?, ?, ?, ?)")
        .run(summaryId, conversationId, "leaf", 0, summary, 5);
      db.prepare("INSERT INTO context_items (conversation_id, ordinal, item_type, summary_id) VALUES (?, ?, ?, ?)")
        .run(conversationId, 1, "summary", summaryId);
      return conversationId;
    };

    const channelId = insertConversation(
      "channel-session",
      "agent:main:discord:channel:123456789",
      "sum_channel_isolated",
      "parent channel summary",
    );
    const threadId = insertConversation(
      "thread-session",
      "agent:main:discord:channel:123456789:topic:987654321",
      "sum_thread_isolated",
      "private thread summary",
    );

    regenerateStaleRoots(rootStore, db, {
      ...visibility,
      channelMembers: {
        "123456789": ["111111", "222222"],
        "987654321": ["111111"],
      },
    }, rootConfig, "UTC");

    const channelRoot = rootStore.get("channel:123456789");
    expect(channelRoot?.content).toContain('id: "123456789"');
    expect(channelRoot?.content).not.toContain('id: "987654321"');
    expect(channelRoot?.sourceConversationIds).toEqual([channelId]);

    const threadRoot = rootStore.get("channel:123456789:topic:987654321");
    expect(threadRoot?.content).toContain('id: "123456789"');
    expect(threadRoot?.content).toContain('id: "987654321"');
    expect(threadRoot?.sourceConversationIds).toEqual([threadId]);

    db.close();
  });

  it("deletes legacy numeric per-user root indices instead of regenerating cross-channel aggregates", () => {
    const db = createRootSummaryTestDb();
    const rootStore = new RootSummaryStore(db);

    db.prepare("INSERT INTO conversations (session_id, session_key, created_at) VALUES (?, ?, ?)")
      .run("legacy-channel", "agent:main:discord:channel:123456789", "2026-05-01T00:00:00Z");
    db.prepare("INSERT INTO messages (conversation_id, seq, role, content, created_at) VALUES ((SELECT conversation_id FROM conversations WHERE session_id = ?), ?, ?, ?, ?)")
      .run("legacy-channel", 1, "user", "hello", "2026-05-01T00:00:00Z");
    const conversationId = Number((db.prepare("SELECT last_insert_rowid() AS id").get() as any).id);
    db.prepare("INSERT INTO summaries (summary_id, conversation_id, kind, depth, content, token_count) VALUES (?, ?, ?, ?, ?, ?)")
      .run("sum_legacy", conversationId, "leaf", 0, "scoped only", 5);
    db.prepare("INSERT INTO context_items (conversation_id, ordinal, item_type, summary_id) VALUES (?, ?, ?, ?)")
      .run(conversationId, 1, "summary", "sum_legacy");

    rootStore.upsert({
      rootKey: "111111",
      content: "contaminated legacy root index",
      tokenCount: 5,
      sourceConversationIds: [999],
    });
    rootStore.markStale("111111");

    regenerateStaleRoots(rootStore, db, visibility, rootConfig, "UTC");

    expect(rootStore.get("111111")).toBeNull();
    expect(rootStore.get("channel:123456789")?.content).toContain('id: "123456789"');
    expect(rootStore.get("channel:123456789")?.content).not.toContain("scoped only");

    db.close();
  });

  it("does not generate root indices for channels without explicit membership discovery", () => {
    const db = createRootSummaryTestDb();
    const rootStore = new RootSummaryStore(db);

    db.prepare("INSERT INTO conversations (session_id, session_key, created_at) VALUES (?, ?, ?)")
      .run("unknown-channel", "agent:main:discord:channel:555555555", "2026-05-01T00:00:00Z");
    const conversationId = Number((db.prepare("SELECT last_insert_rowid() AS id").get() as any).id);
    db.prepare("INSERT INTO summaries (summary_id, conversation_id, kind, depth, content, token_count) VALUES (?, ?, ?, ?, ?, ?)")
      .run("sum_unknown_channel", conversationId, "leaf", 0, "must not leak", 5);
    db.prepare("INSERT INTO context_items (conversation_id, ordinal, item_type, summary_id) VALUES (?, ?, ?, ?)")
      .run(conversationId, 1, "summary", "sum_unknown_channel");

    regenerateStaleRoots(rootStore, db, {
      ...visibility,
      channelMembers: {},
    }, rootConfig, "UTC");

    expect(rootStore.get("channel:555555555")).toBeNull();

    db.close();
  });

  it("excludes restricted channels with no known members from root indices", () => {
    const db = createRootSummaryTestDb();
    const rootStore = new RootSummaryStore(db);

    // Current channel: Alice+Carol restricted
    db.prepare("INSERT INTO conversations (session_id, session_key, created_at) VALUES (?, ?, ?)")
      .run("current-channel", "agent:main:discord:channel:111111111", "2026-05-01T00:00:00Z");
    const currentId = Number((db.prepare("SELECT last_insert_rowid() AS id").get() as any).id);
    db.prepare("INSERT INTO messages (conversation_id, seq, role, content) VALUES (?, ?, ?, ?)")
      .run(currentId, 1, "user", '{"sender_id":"111111"}\nHello');
    db.prepare("INSERT INTO summaries (summary_id, conversation_id, kind, depth, content, token_count) VALUES (?, ?, ?, ?, ?, ?)")
      .run("sum_current", currentId, "leaf", 0, "current channel summary", 5);
    db.prepare("INSERT INTO context_items (conversation_id, ordinal, item_type, summary_id) VALUES (?, ?, ?, ?)")
      .run(currentId, 1, "summary", "sum_current");

    // Restricted channel with no known members (is_open=0, member_ids=[])
    db.prepare("INSERT INTO conversations (session_id, session_key, created_at) VALUES (?, ?, ?)")
      .run("restricted-empty", "agent:main:discord:channel:222222222", "2026-05-01T00:00:00Z");
    const restrictedEmptyId = Number((db.prepare("SELECT last_insert_rowid() AS id").get() as any).id);
    db.prepare("INSERT INTO messages (conversation_id, seq, role, content) VALUES (?, ?, ?, ?)")
      .run(restrictedEmptyId, 1, "user", '{"sender_id":"111111"}\nHello');
    db.prepare("INSERT INTO summaries (summary_id, conversation_id, kind, depth, content, token_count) VALUES (?, ?, ?, ?, ?, ?)")
      .run("sum_restricted_empty", restrictedEmptyId, "leaf", 0, "restricted empty must not leak", 5);
    db.prepare("INSERT INTO context_items (conversation_id, ordinal, item_type, summary_id) VALUES (?, ?, ?, ?)")
      .run(restrictedEmptyId, 1, "summary", "sum_restricted_empty");

    // Open channel (is_open=1, should be visible)
    db.prepare("INSERT INTO conversations (session_id, session_key, created_at) VALUES (?, ?, ?)")
      .run("open-channel", "agent:main:discord:channel:333333333", "2026-05-01T00:00:00Z");
    const openId = Number((db.prepare("SELECT last_insert_rowid() AS id").get() as any).id);
    db.prepare("INSERT INTO messages (conversation_id, seq, role, content) VALUES (?, ?, ?, ?)")
      .run(openId, 1, "user", '{"sender_id":"111111"}\nHello');
    db.prepare("INSERT INTO summaries (summary_id, conversation_id, kind, depth, content, token_count) VALUES (?, ?, ?, ?, ?, ?)")
      .run("sum_open", openId, "leaf", 0, "open channel summary", 5);
    db.prepare("INSERT INTO context_items (conversation_id, ordinal, item_type, summary_id) VALUES (?, ?, ?, ?)")
      .run(openId, 1, "summary", "sum_open");

    regenerateStaleRoots(rootStore, db, {
      ...visibility,
      channelMembers: {
        "111111111": ["111111", "222222"],  // restricted: Alice+Carol
        "222222222": [],                      // restricted, no known members → deny
        "333333333": null,                    // open (is_open=1)
      },
    }, rootConfig, "UTC");

    const root = rootStore.get("channel:111111111");
    // Current session only; broader open channels do not belong in this root.
    expect(root?.sourceConversationIds).toContain(currentId);
    expect(root?.sourceConversationIds).not.toContain(openId);
    // Restricted-empty channel must NOT leak
    expect(root?.sourceConversationIds).not.toContain(restrictedEmptyId);
    expect(root?.content).not.toContain("restricted empty must not leak");
    expect(root?.content).not.toContain("open channel summary");

    // The restricted-empty channel should not even get its own root index
    expect(rootStore.get("channel:222222222")).toBeNull();

    db.close();
  });

  it("includes open channels but not narrower-audience channels in root index", () => {
    const db = createRootSummaryTestDb();
    const rootStore = new RootSummaryStore(db);

    // Root: open channel (is_open=1) → audience = null (everyone)
    // Should see: other open channels + nothing restricted
    // Should NOT see: any restricted channel (superset rule: open can only see open)

    const insertConversation = (sessionId: string, sessionKey: string, summaryId: string, summary: string) => {
      db.prepare("INSERT INTO conversations (session_id, session_key, created_at) VALUES (?, ?, ?)")
        .run(sessionId, sessionKey, "2026-05-01T00:00:00Z");
      const conversationId = Number((db.prepare("SELECT last_insert_rowid() AS id").get() as any).id);
      db.prepare("INSERT INTO messages (conversation_id, seq, role, content) VALUES (?, ?, ?, ?)")
        .run(conversationId, 1, "user", '{"sender_id":"111111"}\nHello');
      db.prepare("INSERT INTO summaries (summary_id, conversation_id, kind, depth, content, token_count) VALUES (?, ?, ?, ?, ?, ?)")
        .run(summaryId, conversationId, "leaf", 0, summary, 5);
      db.prepare("INSERT INTO context_items (conversation_id, ordinal, item_type, summary_id) VALUES (?, ?, ?, ?)")
        .run(conversationId, 1, "summary", summaryId);
      return conversationId;
    };

    const openId1 = insertConversation(
      "open-1", "agent:main:discord:channel:111111111", "sum_open1", "open channel 1"
    );
    const openId2 = insertConversation(
      "open-2", "agent:main:discord:channel:333333333", "sum_open2", "open channel 2"
    );
    const restrictedId = insertConversation(
      "restricted", "agent:main:discord:channel:222222222", "sum_restricted", "restricted summary"
    );

    regenerateStaleRoots(rootStore, db, {
      ...visibility,
      channelMembers: {
        "111111111": null,            // open
        "222222222": ["111111"],     // restricted: Alice only
        "333333333": null,            // open
      },
    }, rootConfig, "UTC");

    const root = rootStore.get("channel:111111111");
    // Root indices are session-scoped, not broad open-channel directories.
    expect(root?.sourceConversationIds).toContain(openId1);
    expect(root?.sourceConversationIds).not.toContain(openId2);
    // Open root should NOT include restricted channels
    expect(root?.sourceConversationIds).not.toContain(restrictedId);

    db.close();
  });

  it("does not generate thread root indices until thread membership is explicitly discovered", () => {
    const db = createRootSummaryTestDb();
    const rootStore = new RootSummaryStore(db);

    db.prepare("INSERT INTO conversations (session_id, session_key, created_at) VALUES (?, ?, ?)")
      .run("unknown-thread", "agent:main:discord:channel:123456789:topic:555555555", "2026-05-01T00:00:00Z");
    const conversationId = Number((db.prepare("SELECT last_insert_rowid() AS id").get() as any).id);
    db.prepare("INSERT INTO summaries (summary_id, conversation_id, kind, depth, content, token_count) VALUES (?, ?, ?, ?, ?, ?)")
      .run("sum_unknown_thread", conversationId, "leaf", 0, "private thread must not leak", 5);
    db.prepare("INSERT INTO context_items (conversation_id, ordinal, item_type, summary_id) VALUES (?, ?, ?, ?)")
      .run(conversationId, 1, "summary", "sum_unknown_thread");

    regenerateStaleRoots(rootStore, db, {
      ...visibility,
      channelMembers: {
        "123456789": ["111111"],
      },
    }, rootConfig, "UTC");

    expect(rootStore.get("channel:123456789:topic:555555555")).toBeNull();
    expect(rootStore.get("channel:123456789")?.content ?? "").not.toContain("private thread must not leak");

    db.close();
  });

  it("lists visible discovered channels without LCM history separately", () => {
    const db = createRootSummaryTestDb();
    const rootStore = new RootSummaryStore(db);

    db.prepare("INSERT INTO conversations (session_id, session_key, created_at) VALUES (?, ?, ?)")
      .run("real", "agent:main:discord:channel:111111111", "2026-05-01T00:00:00Z");
    const conversationId = Number((db.prepare("SELECT last_insert_rowid() AS id").get() as any).id);
    db.prepare("INSERT INTO messages (conversation_id, seq, role, content) VALUES (?, ?, ?, ?)")
      .run(conversationId, 1, "user", "hello");
    db.prepare("INSERT INTO summaries (summary_id, conversation_id, kind, depth, content, token_count) VALUES (?, ?, ?, ?, ?, ?)")
      .run("sum_real", conversationId, "leaf", 0, "real context", 5);
    db.prepare("INSERT INTO context_items (conversation_id, ordinal, item_type, summary_id) VALUES (?, ?, ?, ?)")
      .run(conversationId, 1, "summary", "sum_real");
    db.prepare("INSERT INTO channel_membership (channel_id, is_open, member_ids, channel_name, guild_id) VALUES (?, ?, ?, ?, ?)")
      .run("111111111", 1, "[]", "current", "guild-1");
    db.prepare("INSERT INTO channel_membership (channel_id, is_open, member_ids, channel_name, guild_id) VALUES (?, ?, ?, ?, ?)")
      .run("222222222", 1, "[]", "visible-empty", "guild-1");

    regenerateStaleRoots(rootStore, db, {
      ...visibility,
      channelMembers: {
        "111111111": null,
        "222222222": null,
      },
    }, rootConfig, "UTC");

    const root = rootStore.get("channel:111111111");
    expect(root?.content).toContain("visible_without_lcm_history:");
    expect(root?.content).toContain('id: "222222222"');
    expect(root?.content).toContain('title: "visible-empty"');
    expect(root?.sourceConversationIds).toEqual([conversationId]);

    db.close();
  });

  it("does not list visible channels without LCM history from another guild", () => {
    const db = createRootSummaryTestDb();
    const rootStore = new RootSummaryStore(db);

    db.prepare("INSERT INTO conversations (session_id, session_key, created_at) VALUES (?, ?, ?)")
      .run("real", "agent:main:discord:channel:111111111", "2026-05-01T00:00:00Z");
    const conversationId = Number((db.prepare("SELECT last_insert_rowid() AS id").get() as any).id);
    db.prepare("INSERT INTO messages (conversation_id, seq, role, content) VALUES (?, ?, ?, ?)")
      .run(conversationId, 1, "user", "hello");
    db.prepare("INSERT INTO summaries (summary_id, conversation_id, kind, depth, content, token_count) VALUES (?, ?, ?, ?, ?, ?)")
      .run("sum_real", conversationId, "leaf", 0, "real context", 5);
    db.prepare("INSERT INTO context_items (conversation_id, ordinal, item_type, summary_id) VALUES (?, ?, ?, ?)")
      .run(conversationId, 1, "summary", "sum_real");
    db.prepare("INSERT INTO channel_membership (channel_id, is_open, member_ids, channel_name, guild_id) VALUES (?, ?, ?, ?, ?)")
      .run("111111111", 1, "[]", "current", "guild-1");
    db.prepare("INSERT INTO channel_membership (channel_id, is_open, member_ids, channel_name, guild_id) VALUES (?, ?, ?, ?, ?)")
      .run("222222222", 1, "[]", "other-guild-visible-empty", "guild-2");

    regenerateStaleRoots(rootStore, db, {
      ...visibility,
      channelMembers: {
        "111111111": null,
        "222222222": null,
      },
    }, rootConfig, "UTC");

    const root = rootStore.get("channel:111111111");
    expect(root?.content).not.toContain("visible_without_lcm_history:");
    expect(root?.content).not.toContain('id: "222222222"');
    expect(root?.sourceConversationIds).toEqual([conversationId]);

    db.close();
  });

  it("includes same-guild broader/equal audience channels but excludes narrower and cross-guild channels", () => {
    const db = createRootSummaryTestDb();
    const rootStore = new RootSummaryStore(db);

    const insertConversation = (sessionId: string, sessionKey: string, summaryId: string, summary: string) => {
      db.prepare("INSERT INTO conversations (session_id, session_key, created_at) VALUES (?, ?, ?)")
        .run(sessionId, sessionKey, "2026-05-01T00:00:00Z");
      const conversationId = Number((db.prepare("SELECT last_insert_rowid() AS id").get() as any).id);
      db.prepare("INSERT INTO messages (conversation_id, seq, role, content) VALUES (?, ?, ?, ?)")
        .run(conversationId, 1, "user", "hello");
      db.prepare("INSERT INTO summaries (summary_id, conversation_id, kind, depth, content, token_count) VALUES (?, ?, ?, ?, ?, ?)")
        .run(summaryId, conversationId, "leaf", 0, summary, 5);
      db.prepare("INSERT INTO context_items (conversation_id, ordinal, item_type, summary_id) VALUES (?, ?, ?, ?)")
        .run(conversationId, 1, "summary", summaryId);
      return conversationId;
    };

    const restrictedRootId = insertConversation(
      "restricted-root", "agent:main:discord:channel:111111111", "sum_restricted_root", "restricted root context"
    );
    const sameAudienceId = insertConversation(
      "same-audience", "agent:main:discord:channel:222222222", "sum_same_audience", "same restricted audience context"
    );
    const openSameGuildId = insertConversation(
      "open-same-guild", "agent:main:discord:channel:333333333", "sum_open_same_guild", "broad open same-guild context"
    );
    const narrowerId = insertConversation(
      "narrower", "agent:main:discord:channel:444444444", "sum_narrower", "narrower channel must not appear"
    );
    const openOtherGuildId = insertConversation(
      "open-other-guild", "agent:main:discord:channel:555555555", "sum_open_other_guild", "other guild open channel must not appear"
    );

    for (const [channelId, isOpen, memberIds, name, guildId] of [
      ["111111111", 0, JSON.stringify(["111111", "222222"]), "current", "guild-1"],
      ["222222222", 0, JSON.stringify(["111111", "222222"]), "same-audience", "guild-1"],
      ["333333333", 1, "[]", "open-same-guild", "guild-1"],
      ["444444444", 0, JSON.stringify(["111111"]), "narrower", "guild-1"],
      ["555555555", 1, "[]", "open-other-guild", "guild-2"],
    ] as const) {
      db.prepare("INSERT INTO channel_membership (channel_id, is_open, member_ids, channel_name, guild_id) VALUES (?, ?, ?, ?, ?)")
        .run(channelId, isOpen, memberIds, name, guildId);
    }

    regenerateStaleRoots(rootStore, db, {
      ...visibility,
      channelMembers: {
        "111111111": ["111111", "222222"],
        "222222222": ["222222", "111111"],
        "333333333": null,
        "444444444": ["111111"],
        "555555555": null,
      },
    }, rootConfig, "UTC");

    const root = rootStore.get("channel:111111111");
    expect(root?.sourceConversationIds).toContain(restrictedRootId);
    expect(root?.sourceConversationIds).toContain(sameAudienceId);
    expect(root?.sourceConversationIds).toContain(openSameGuildId);
    expect(root?.sourceConversationIds).not.toContain(narrowerId);
    expect(root?.sourceConversationIds).not.toContain(openOtherGuildId);
    expect(root?.content).toContain('id: "222222222"');
    expect(root?.content).toContain('id: "333333333"');
    expect(root?.content).not.toContain('id: "444444444"');
    expect(root?.content).not.toContain('id: "555555555"');

    db.close();
  });

  it("fails closed for cross-channel root entries when guild id is unknown", () => {
    const db = createRootSummaryTestDb();
    const rootStore = new RootSummaryStore(db);

    const insertConversation = (sessionId: string, sessionKey: string, summaryId: string, summary: string) => {
      db.prepare("INSERT INTO conversations (session_id, session_key, created_at) VALUES (?, ?, ?)")
        .run(sessionId, sessionKey, "2026-05-01T00:00:00Z");
      const conversationId = Number((db.prepare("SELECT last_insert_rowid() AS id").get() as any).id);
      db.prepare("INSERT INTO messages (conversation_id, seq, role, content) VALUES (?, ?, ?, ?)")
        .run(conversationId, 1, "user", "hello");
      db.prepare("INSERT INTO summaries (summary_id, conversation_id, kind, depth, content, token_count) VALUES (?, ?, ?, ?, ?, ?)")
        .run(summaryId, conversationId, "leaf", 0, summary, 5);
      db.prepare("INSERT INTO context_items (conversation_id, ordinal, item_type, summary_id) VALUES (?, ?, ?, ?)")
        .run(conversationId, 1, "summary", summaryId);
      return conversationId;
    };

    const currentId = insertConversation(
      "current", "agent:main:discord:channel:111111111", "sum_current_unknown_guild", "current channel context"
    );
    const sameAudienceUnknownGuildId = insertConversation(
      "unknown-guild", "agent:main:discord:channel:222222222", "sum_unknown_guild", "unknown guild channel must not appear"
    );

    for (const [channelId, memberIds, name] of [
      ["111111111", JSON.stringify(["111111", "222222"]), "current"],
      ["222222222", JSON.stringify(["111111", "222222"]), "unknown-guild"],
    ] as const) {
      db.prepare("INSERT INTO channel_membership (channel_id, is_open, member_ids, channel_name, guild_id) VALUES (?, ?, ?, ?, ?)")
        .run(channelId, 0, memberIds, name, null);
    }

    regenerateStaleRoots(rootStore, db, {
      ...visibility,
      channelMembers: {
        "111111111": ["111111", "222222"],
        "222222222": ["111111", "222222"],
      },
    }, rootConfig, "UTC");

    const root = rootStore.get("channel:111111111");
    expect(root?.sourceConversationIds).toEqual([currentId]);
    expect(root?.sourceConversationIds).not.toContain(sameAudienceUnknownGuildId);
    expect(root?.content).not.toContain('id: "222222222"');
    expect(root?.content).not.toContain("unknown guild channel must not appear");

    db.close();
  });

  it("excludes empty lifecycle rows from root index sources", () => {
    const db = createRootSummaryTestDb();
    const rootStore = new RootSummaryStore(db);

    const insertConversation = (sessionId: string, sessionKey: string, summaryId?: string, summary?: string) => {
      db.prepare("INSERT INTO conversations (session_id, session_key, created_at) VALUES (?, ?, ?)")
        .run(sessionId, sessionKey, "2026-05-01T00:00:00Z");
      const conversationId = Number((db.prepare("SELECT last_insert_rowid() AS id").get() as any).id);
      if (summaryId && summary) {
        db.prepare("INSERT INTO messages (conversation_id, seq, role, content) VALUES (?, ?, ?, ?)")
          .run(conversationId, 1, "user", "hello");
        db.prepare("INSERT INTO summaries (summary_id, conversation_id, kind, depth, content, token_count) VALUES (?, ?, ?, ?, ?, ?)")
          .run(summaryId, conversationId, "leaf", 0, summary, 5);
        db.prepare("INSERT INTO context_items (conversation_id, ordinal, item_type, summary_id) VALUES (?, ?, ?, ?)")
          .run(conversationId, 1, "summary", summaryId);
      }
      return conversationId;
    };

    const realId = insertConversation("real", "agent:main:discord:channel:111111111", "sum_real", "real context");
    const emptyId = insertConversation("empty", "agent:main:discord:channel:222222222");

    regenerateStaleRoots(rootStore, db, {
      ...visibility,
      channelMembers: {
        "111111111": null,
        "222222222": null,
      },
    }, rootConfig, "UTC");

    const root = rootStore.get("channel:111111111");
    expect(root?.sourceConversationIds).toContain(realId);
    expect(root?.sourceConversationIds).not.toContain(emptyId);
    expect(root?.content).not.toContain("222222222");

    db.close();
  });
});
