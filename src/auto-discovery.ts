/**
 * Auto-discovery for channel membership.
 *
 * Since the LCM plugin has no direct Discord API access, we discover
 * channel scopes indirectly from data already in the database:
 *
 * 1. Scan all conversation session_keys → extract channel IDs
 * 2. Create closed placeholder rows for those channel IDs
 *
 * This intentionally does NOT infer user membership from message sender_id
 * metadata. Runtime prompts can contain injected recall/memory blocks from
 * other conversations; treating those sender_ids as channel members caused
 * privacy leaks. Real membership/open-state must come from Discord permission
 * discovery or explicit manual/config entries.
 *
 * For a more complete discovery, the agent can run a manual discovery
 * via the `message` tool (channel-info action) and backfill the table.
 */

import type { DatabaseSync } from "node:sqlite";
import { parseSessionKey } from "./visibility.js";

const log = {
  info: (...args: unknown[]) => console.log("[lcm:auto-discovery]", ...args),
  warn: (...args: unknown[]) => console.warn("[lcm:auto-discovery]", ...args),
  debug: (...args: unknown[]) => {},
};

/** Ensure the channel_membership table exists. */
export function ensureChannelMembershipTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS channel_membership (
      channel_id TEXT PRIMARY KEY,
      is_open INTEGER NOT NULL DEFAULT 0,
      member_ids TEXT NOT NULL DEFAULT '[]',
      discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      source TEXT NOT NULL DEFAULT 'auto',
      channel_name TEXT,
      guild_id TEXT
    )
  `);
  const columns = db.prepare(`PRAGMA table_info(channel_membership)`).all() as Array<{ name?: string }>;
  const hasColumn = (name: string) => columns.some((column) => column.name === name);
  if (!hasColumn("updated_at")) {
    db.exec(`ALTER TABLE channel_membership ADD COLUMN updated_at TEXT`);
    db.exec(`UPDATE channel_membership SET updated_at = COALESCE(updated_at, discovered_at, datetime('now'))`);
  }
  if (!hasColumn("channel_name")) {
    db.exec(`ALTER TABLE channel_membership ADD COLUMN channel_name TEXT`);
  }
  if (!hasColumn("guild_id")) {
    db.exec(`ALTER TABLE channel_membership ADD COLUMN guild_id TEXT`);
  }
}

/**
 * Result of auto-discovery.
 */
export interface DiscoveryResult {
  /** Number of channels discovered. */
  channelsDiscovered: number;
  /** Number of new/updated membership entries. */
  entriesUpserted: number;
  /** Channel IDs that were discovered. */
  channelIds: string[];
}

export interface ChannelMembershipCoverage {
  /** Number of unique channel/thread scopes currently known to LCM. */
  channelScopeCount: number;
  /** Channel/thread IDs currently known to LCM. */
  channelIds: string[];
  /** Channel/thread IDs covered by inline plugin config. */
  configuredChannelCount: number;
  /** Channel/thread IDs covered by cached membership/open-state data. */
  cachedMembershipCount: number;
  /** Channel/thread IDs that will fail closed because no membership data is known. */
  missingMembershipCount: number;
  /** Missing channel/thread IDs for tests and diagnostics. */
  missingMembershipChannelIds: string[];
}

function collectChannelConversations(db: DatabaseSync): {
  channelConvs: Map<string, number[]>;
  inheritedThreadParents: Map<string, string>;
} {
  const conversations = db.prepare(
    "SELECT conversation_id, session_key FROM conversations WHERE session_key IS NOT NULL",
  ).all() as Array<{ conversation_id: number; session_key: string }>;

  const channelConvs = new Map<string, number[]>(); // channelId/topicId -> conversationIds
  const inheritedThreadParents = new Map<string, string>(); // topicId -> parent channelId

  for (const conv of conversations) {
    const parsed = parseSessionKey(conv.session_key);
    if (parsed.type === "channel") {
      const channelId = parsed.identifier;
      if (parsed.topicId && parsed.channelId && parsed.topicId !== parsed.channelId) {
        inheritedThreadParents.set(parsed.topicId, parsed.channelId);
      }
      if (!channelConvs.has(channelId)) {
        channelConvs.set(channelId, []);
      }
      channelConvs.get(channelId)!.push(conv.conversation_id);
    }
  }

  return { channelConvs, inheritedThreadParents };
}

function parseMemberIds(value: unknown): string[] {
  if (typeof value !== "string") {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
      : [];
  } catch {
    return [];
  }
}

function rowHasKnownMembership(row: { is_open: number; member_ids: string; source?: string } | undefined): boolean {
  if (!row) {
    return false;
  }
  if (Number(row.is_open) === 1) {
    return true;
  }
  if (parseMemberIds(row.member_ids).length > 0) {
    return true;
  }
  return row.source !== undefined && row.source !== "auto";
}

export function diagnoseChannelMembershipCoverage(
  db: DatabaseSync,
  configuredMembers?: Record<string, string[] | null>,
): ChannelMembershipCoverage {
  ensureChannelMembershipTable(db);

  const { channelConvs } = collectChannelConversations(db);
  const channelIds = Array.from(channelConvs.keys());
  const configuredChannelIds = new Set(
    Object.keys(configuredMembers ?? {}).filter((channelId) => channelConvs.has(channelId)),
  );
  const rows = db.prepare(
    "SELECT channel_id, is_open, member_ids, source FROM channel_membership",
  ).all() as Array<{ channel_id: string; is_open: number; member_ids: string; source?: string }>;
  const rowByChannelId = new Map(rows.map((row) => [row.channel_id, row]));

  let cachedMembershipCount = 0;
  const missingMembershipChannelIds: string[] = [];
  for (const channelId of channelIds) {
    if (configuredChannelIds.has(channelId)) {
      continue;
    }
    const row = rowByChannelId.get(channelId);
    if (rowHasKnownMembership(row)) {
      cachedMembershipCount++;
      continue;
    }
    missingMembershipChannelIds.push(channelId);
  }

  return {
    channelScopeCount: channelIds.length,
    channelIds,
    configuredChannelCount: configuredChannelIds.size,
    cachedMembershipCount,
    missingMembershipCount: missingMembershipChannelIds.length,
    missingMembershipChannelIds,
  };
}

/**
 * Run auto-discovery: scan conversations and create closed channel placeholders.
 *
 * This should be called once at engine startup, before the first visibility check.
 *
 * @param db The LCM database connection
 * @returns Discovery result with stats
 */
export function runAutoDiscovery(db: DatabaseSync): DiscoveryResult {
  ensureChannelMembershipTable(db);

  // Step 1: Find all channel-type conversations
  const { channelConvs, inheritedThreadParents } = collectChannelConversations(db);

  if (channelConvs.size === 0) {
    log.info("No channel conversations found for auto-discovery");
    return { channelsDiscovered: 0, entriesUpserted: 0, channelIds: [] };
  }

  // Step 2: Upsert closed placeholders into channel_membership table. These
  // rows make unknown visibility explicit without granting anybody access.
  const upsertStmt = db.prepare(`
    INSERT INTO channel_membership (channel_id, is_open, member_ids, discovered_at, updated_at, source)
    VALUES (?, ?, ?, datetime('now'), datetime('now'), 'auto')
    ON CONFLICT(channel_id) DO UPDATE SET
      is_open = excluded.is_open,
      member_ids = excluded.member_ids,
      discovered_at = datetime('now'),
      updated_at = datetime('now'),
      source = 'auto'
  `);

  let entriesUpserted = 0;
  const channelIds: string[] = [];

  // Don't overwrite existing membership data or manually curated entries.
  const manualCheckStmt = db.prepare(
    "SELECT source FROM channel_membership WHERE channel_id = ?"
  );

  for (const [channelId] of channelConvs) {
    // Skip if manually curated
    const existing = manualCheckStmt.get(channelId) as { source: string } | undefined;
    if (existing) {
      continue;
    }

    const parentId = inheritedThreadParents.get(channelId);
    const parent = parentId ? manualCheckStmt.get(parentId) as { source: string } | undefined : undefined;
    let isOpen = 0;
    let memberIds = "[]";
    if (parentId && parent) {
      const parentRow = db.prepare("SELECT is_open, member_ids FROM channel_membership WHERE channel_id = ?").get(parentId) as { is_open: number; member_ids: string } | undefined;
      if (parentRow) {
        isOpen = parentRow.is_open;
        memberIds = parentRow.member_ids;
      }
    }

    try {
      upsertStmt.run(channelId, isOpen, memberIds);
      entriesUpserted++;
    } catch (e) {
      log.warn(`Failed to upsert channel_membership for ${channelId}: ${e}`);
    }

    channelIds.push(channelId);
  }

  log.info(
    `Auto-discovery complete: ${channelConvs.size} channels, ${entriesUpserted} entries upserted`,
  );

  return {
    channelsDiscovered: channelConvs.size,
    entriesUpserted,
    channelIds,
  };
}

/**
 * Add a single channel membership entry (for manual or event-driven updates).
 * Preserves entries with source='manual' from being overwritten.
 */
export function upsertChannelMembership(
  db: DatabaseSync,
  channelId: string,
  isOpen: boolean,
  memberIds: string[],
  source: "auto" | "manual" = "auto",
): void {
  ensureChannelMembershipTable(db);

  // Don't overwrite manual entries with event-driven data.
  if (source === "auto") {
    const existing = db.prepare(
      "SELECT source FROM channel_membership WHERE channel_id = ?"
    ).get(channelId) as { source: string } | undefined;
    if (existing && existing.source === "manual") {
      return;
    }
  }

  db.prepare(`
    INSERT INTO channel_membership (channel_id, is_open, member_ids, discovered_at, updated_at, source)
    VALUES (?, ?, ?, datetime('now'), datetime('now'), ?)
    ON CONFLICT(channel_id) DO UPDATE SET
      is_open = excluded.is_open,
      member_ids = excluded.member_ids,
      discovered_at = datetime('now'),
      updated_at = datetime('now'),
      source = excluded.source
  `).run(channelId, isOpen ? 1 : 0, JSON.stringify(memberIds), source);
}
