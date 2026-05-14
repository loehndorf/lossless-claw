import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { runAutoDiscovery, ensureChannelMembershipTable, upsertChannelMembership, diagnoseChannelMembershipCoverage } from "../src/auto-discovery.js";

function createTestDB(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA journal_mode = wal");
  db.exec(`
    CREATE TABLE conversations (
      conversation_id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      session_key TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`
    CREATE TABLE messages (
      message_id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      token_count INTEGER NOT NULL DEFAULT 0,
      identity_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(conversation_id, seq)
    )
  `);
  return db;
}

describe("auto-discovery", () => {
  it("creates the channel_membership table", () => {
    const db = createTestDB();
    ensureChannelMembershipTable(db);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='channel_membership'").all();
    expect(tables).toHaveLength(1);
    const columns = db.prepare("PRAGMA table_info(channel_membership)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "channel_id",
      "is_open",
      "member_ids",
      "discovered_at",
      "updated_at",
      "source",
      "channel_name",
      "guild_id",
    ]));
    db.close();
  });

  it("creates closed placeholders for channel conversations without inferring members from messages", () => {
    const db = createTestDB();
    ensureChannelMembershipTable(db);

    // Insert a channel conversation
    db.prepare("INSERT INTO conversations (session_id, session_key) VALUES (?, ?)").run(
      "test-session-1",
      "agent:main:discord:channel:123456789",
    );
    const convId = Number(db.prepare("SELECT last_insert_rowid() as id").get().id);

    // Insert messages with sender_id embedded in content (like Discord metadata)
    db.prepare("INSERT INTO messages (conversation_id, seq, role, content, identity_hash) VALUES (?, ?, ?, ?, ?)")
      .run(convId, 1, "user", '{"sender_id":"111111"}\nHello from user A', "hash1");
    db.prepare("INSERT INTO messages (conversation_id, seq, role, content, identity_hash) VALUES (?, ?, ?, ?, ?)")
      .run(convId, 2, "user", '{"sender_id":"222222"}\nHello from user B', "hash2");
    db.prepare("INSERT INTO messages (conversation_id, seq, role, content, identity_hash) VALUES (?, ?, ?, ?, ?)")
      .run(convId, 3, "assistant", "Response", "hash3");

    const result = runAutoDiscovery(db);

    expect(result.channelsDiscovered).toBe(1);
    expect(result.entriesUpserted).toBe(1);
    expect(result.channelIds).toContain("123456789");

    // Verify the placeholder is closed and does not infer membership from sender_id.
    const row = db.prepare("SELECT channel_id, is_open, member_ids, source FROM channel_membership WHERE channel_id = ?").get("123456789") as any;
    expect(row).toBeDefined();
    expect(row.is_open).toBe(0);
    expect(JSON.parse(row.member_ids)).toEqual([]);
    expect(row.source).toBe("auto");

    db.close();
  });

  it("diagnoses channel conversations that will fail closed without membership data", () => {
    const db = createTestDB();
    ensureChannelMembershipTable(db);

    db.prepare("INSERT INTO conversations (session_id, session_key) VALUES (?, ?)").run(
      "test-session-1",
      "agent:main:discord:channel:123456789",
    );

    runAutoDiscovery(db);
    const coverage = diagnoseChannelMembershipCoverage(db);

    expect(coverage.channelScopeCount).toBe(1);
    expect(coverage.configuredChannelCount).toBe(0);
    expect(coverage.cachedMembershipCount).toBe(0);
    expect(coverage.missingMembershipCount).toBe(1);
    expect(coverage.missingMembershipChannelIds).toEqual(["123456789"]);

    db.close();
  });

  it("treats configured channel membership as covered", () => {
    const db = createTestDB();
    ensureChannelMembershipTable(db);

    db.prepare("INSERT INTO conversations (session_id, session_key) VALUES (?, ?)").run(
      "test-session-1",
      "agent:main:discord:channel:123456789",
    );

    runAutoDiscovery(db);
    const coverage = diagnoseChannelMembershipCoverage(db, {
      "123456789": ["111111"],
    });

    expect(coverage.configuredChannelCount).toBe(1);
    expect(coverage.cachedMembershipCount).toBe(0);
    expect(coverage.missingMembershipCount).toBe(0);

    db.close();
  });

  it("treats trusted cached channel membership as covered", () => {
    const db = createTestDB();
    ensureChannelMembershipTable(db);

    upsertChannelMembership(db, "123456789", false, ["111111"], "auto");
    db.prepare("INSERT INTO conversations (session_id, session_key) VALUES (?, ?)").run(
      "test-session-1",
      "agent:main:discord:channel:123456789",
    );

    runAutoDiscovery(db);
    const coverage = diagnoseChannelMembershipCoverage(db);

    expect(coverage.configuredChannelCount).toBe(0);
    expect(coverage.cachedMembershipCount).toBe(1);
    expect(coverage.missingMembershipCount).toBe(0);

    db.close();
  });

  it("discovers topic membership separately from parent channel membership", () => {
    const db = createTestDB();
    ensureChannelMembershipTable(db);

    db.prepare("INSERT INTO conversations (session_id, session_key) VALUES (?, ?)").run(
      "topic-session-1",
      "agent:main:discord:channel:123456789:topic:987654321",
    );
    const convId = Number(db.prepare("SELECT last_insert_rowid() as id").get().id);

    db.prepare("INSERT INTO messages (conversation_id, seq, role, content, identity_hash) VALUES (?, ?, ?, ?, ?)")
      .run(convId, 1, "user", '{"sender_id":"111111","topic_id":"987654321"}\nHello from thread user', "hash1");

    const result = runAutoDiscovery(db);

    expect(result.channelIds).toContain("987654321");

    const topicRow = db.prepare("SELECT is_open, member_ids FROM channel_membership WHERE channel_id = ?").get("987654321") as any;
    expect(topicRow.is_open).toBe(0);
    expect(JSON.parse(topicRow.member_ids)).toEqual([]);

    db.close();
  });

  it("inherits known parent channel visibility for public thread placeholders", () => {
    const db = createTestDB();
    ensureChannelMembershipTable(db);
    upsertChannelMembership(db, "123456789", false, ["111111", "222222"], "auto");

    db.prepare("INSERT INTO conversations (session_id, session_key) VALUES (?, ?)").run(
      "topic-session-1",
      "agent:main:discord:channel:123456789:topic:987654321",
    );

    const result = runAutoDiscovery(db);
    expect(result.channelIds).toContain("987654321");

    const topicRow = db.prepare("SELECT is_open, member_ids FROM channel_membership WHERE channel_id = ?").get("987654321") as any;
    expect(topicRow.is_open).toBe(0);
    expect(JSON.parse(topicRow.member_ids)).toEqual(["111111", "222222"]);

    db.close();
  });

  it("discovers DMs but does not add them to channel_membership", () => {
    const db = createTestDB();
    ensureChannelMembershipTable(db);

    // Insert a DM conversation
    db.prepare("INSERT INTO conversations (session_id, session_key) VALUES (?, ?)").run(
      "dm-session-1",
      "agent:main:discord:direct:999999",
    );

    const result = runAutoDiscovery(db);
    expect(result.channelsDiscovered).toBe(0);
    expect(result.entriesUpserted).toBe(0);

    db.close();
  });

  it("does not overwrite existing or manually curated entries", () => {
    const db = createTestDB();
    ensureChannelMembershipTable(db);

    // Insert a manual entry first
    upsertChannelMembership(db, "123456789", false, ["manual-user"], "manual");

    // Insert a channel conversation with auto data
    db.prepare("INSERT INTO conversations (session_id, session_key) VALUES (?, ?)").run(
      "test-session-1",
      "agent:main:discord:channel:123456789",
    );
    const convId = Number(db.prepare("SELECT last_insert_rowid() as id").get().id);
    db.prepare("INSERT INTO messages (conversation_id, seq, role, content, identity_hash) VALUES (?, ?, ?, ?, ?)")
      .run(convId, 1, "user", '{"sender_id":"auto-user"}\nAuto message', "hash1");

    runAutoDiscovery(db);

    // Manual entry should be preserved
    const row = db.prepare("SELECT member_ids, source FROM channel_membership WHERE channel_id = ?").get("123456789") as any;
    const members = JSON.parse(row.member_ids);
    expect(members).toEqual(["manual-user"]);
    expect(row.source).toBe("manual");

    db.close();
  });

  it("does not overwrite existing auto entries created from trusted permission discovery", () => {
    const db = createTestDB();
    ensureChannelMembershipTable(db);

    upsertChannelMembership(db, "123456789", false, ["trusted-user"], "auto");

    db.prepare("INSERT INTO conversations (session_id, session_key) VALUES (?, ?)").run(
      "test-session-1",
      "agent:main:discord:channel:123456789",
    );
    const convId = Number(db.prepare("SELECT last_insert_rowid() as id").get().id);
    db.prepare("INSERT INTO messages (conversation_id, seq, role, content, identity_hash) VALUES (?, ?, ?, ?, ?)")
      .run(convId, 1, "user", '{"sender_id":"injected-user"}\nAuto message', "hash1");

    runAutoDiscovery(db);

    const row = db.prepare("SELECT member_ids, source FROM channel_membership WHERE channel_id = ?").get("123456789") as any;
    expect(JSON.parse(row.member_ids)).toEqual(["trusted-user"]);
    expect(row.source).toBe("auto");

    db.close();
  });

  it("handles empty database gracefully", () => {
    const db = createTestDB();
    ensureChannelMembershipTable(db);

    const result = runAutoDiscovery(db);
    expect(result.channelsDiscovered).toBe(0);
    expect(result.entriesUpserted).toBe(0);
    expect(result.channelIds).toEqual([]);

    db.close();
  });

  it("upsertChannelMembership works for manual entries", () => {
    const db = createTestDB();
    ensureChannelMembershipTable(db);

    upsertChannelMembership(db, "999", true, [], "manual");

    const row = db.prepare("SELECT channel_id, is_open, member_ids, source FROM channel_membership WHERE channel_id = ?").get("999") as any;
    expect(row.is_open).toBe(1);
    expect(JSON.parse(row.member_ids)).toEqual([]);
    expect(row.source).toBe("manual");

    db.close();
  });
});
