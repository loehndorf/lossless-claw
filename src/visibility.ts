/**
 * Visibility filtering for cross-conversation LCM access.
 *
 * Session keys encode the channel/user context:
 *   agent:main:discord:direct:<user_id>        → DM (only that user can see)
 *   agent:main:discord:channel:<channel_id>     → Group channel (members can see)
 *   agent:main:discord:channel:<channel_id>:topic:<topic_id> → Thread/topic (topic membership first)
 *   agent:main:discord:channel:<channel_id>:active-memory:<hash> → inherits parent channel visibility
 *
 * Visibility rules are deterministic:
 *   - DMs: only the DM participant can see their own DMs (derived from session key)
 *   - Channels: only known members can see channel content
 *   - Unknown sessions: denied by default
 *
 * Channel membership is not inferred from chat transcripts. The plugin can
 * create closed placeholder rows for known channels; real membership/open-state
 * must come from the host integration, permission discovery, or explicit config.
 *
 * ## channelMembersMap semantics
 *
 * `Map<string, string[] | null>` where:
 * - **Missing key** → no membership data → deny by default
 * - **`null` value** → open channel (everyone can see, backed by is_open=1)
 * - **`[]` value** → restricted channel with no known members → deny
 * - **`["u1", "u2"]`** → restricted to these members
 */

/** A single visibility rule mapping a session key pattern to allowed user IDs. */
export interface VisibilityRule {
  /** Glob pattern matched against session_key. Supports * (non-colon) and ** (any). */
  sessionPattern: string;
  /** Discord user IDs that can see this conversation. Empty = everyone. */
  allowedUsers: string[];
  /** Human-readable label for debugging. */
  label?: string;
}

export interface VisibilityConfig {
  /** Enable visibility filtering. When false, all conversations are visible to everyone. */
  enabled: boolean;
  /**
   * Path to a JSON file containing the visibility rules.
   * If not set, rules are read from config only.
   */
  rulesFile?: string;
  /** Inline visibility rules (supplement rulesFile). */
  rules?: VisibilityRule[];
  /**
   * Default visibility when no rule matches.
   * "owner-only" = only the DM participant can see DMs; channels require membership.
   * "open" = everyone can see everything (no filtering).
   */
  defaultPolicy: "owner-only" | "open";
  /**
   * Channel membership map: channel_id → members.
   * - null = open (everyone can see)
   * - [] = restricted but no known members (deny)
   * - ["u1", "u2"] = restricted to these members
   */
  channelMembers?: Record<string, string[] | null>;
}

export const DEFAULT_VISIBILITY_CONFIG: VisibilityConfig = {
  enabled: true,
  defaultPolicy: "owner-only",
};

/** Visibility audience for a conversation. null means open to every guild member. */
export type VisibilityAudience = Set<string> | null;

/**
 * Channel membership map type.
 *
 * - Missing key → no data → deny
 * - null → open (is_open=1)
 * - [] → restricted with no known members → deny
 * - ["u1"] → restricted to these members
 */
export type ChannelMembersMap = Map<string, string[] | null>;

/**
 * Build the complete channelMembers map.
 * Merges cached membership from LCM DB with config overrides.
 * Config overrides take precedence (for non-Discord or special cases).
 *
 * Discovery sources (in priority order):
 * 1. Config overrides (channelMembers in plugin config)
 * 2. Cached channel_membership DB table entries populated by the host or tools
 * 3. Closed placeholders for channels whose membership is still unknown
 */
export function buildChannelMembersMap(
  discoveredMembers?: ChannelMembersMap,
  configMembers?: Record<string, string[] | null>,
): ChannelMembersMap {
  const result: ChannelMembersMap = new Map();

  // Start with cached membership
  if (discoveredMembers) {
    for (const [channelId, members] of discoveredMembers) {
      result.set(channelId, members);
    }
  }

  // Config overrides take precedence
  if (configMembers) {
    for (const [channelId, members] of Object.entries(configMembers)) {
      result.set(channelId, members ?? null);
    }
  }

  return result;
}

/**
 * Load channel membership from the LCM database cache table.
 * The plugin only trusts this table as cached visibility data:
 * - Host integrations or explicit tools may write real membership/open-state
 * - Startup auto-discovery writes closed placeholders for unknown channels
 * - This function reads them back for visibility checks
 *
 * Returns a ChannelMembersMap where:
 * - is_open=1 → null (open channel, everyone can see)
 * - is_open=0 with member_ids → member list (restricted)
 * - is_open=0 without member_ids → [] (restricted, no known members → deny)
 */
export function loadChannelMembersFromDB(db: any): ChannelMembersMap {
  const result: ChannelMembersMap = new Map();
  try {
    const rows = db.prepare(
      "SELECT channel_id, is_open, member_ids FROM channel_membership"
    ).all();
    for (const row of rows) {
      const channelId = row.channel_id as string;
      if (row.is_open) {
        // Open channels: null = everyone can see
        result.set(channelId, null);
      } else {
        // Restricted channels: parse member_ids JSON
        try {
          const members = JSON.parse(row.member_ids as string) as string[];
          // Empty member_ids on a restricted channel = no known members → deny.
          // Do NOT treat as open (that would leak metadata).
          result.set(channelId, members);
        } catch {
          // Malformed entry → restricted with no known members
          result.set(channelId, []);
        }
      }
    }
  } catch {
    // Table might not exist yet — that's fine
  }
  return result;
}

/**
 * Parse a Discord permission_overwrites array to determine who can view a channel.
 * Returns user IDs that have explicit VIEW_CHANNEL allow, or empty array if @everyone can view.
 *
 * Logic:
 * - If @everyone role is denied VIEW_CHANNEL, only explicitly allowed users/members can see
 * - If no deny on @everyone, the channel is open to all guild members
 */
export function parseChannelVisibility(
  permissionOverwrites: Array<{
    id: string;
    type: number; // 0 = role, 1 = member
    allow: number | string;
    deny: number | string;
  }>,
  everyoneRoleId: string,
): { isOpen: boolean; allowedUserIds: string[] } {
  const VIEW_CHANNEL_BIT = 1n << 10n; // 1024

  // Check if @everyone is denied VIEW_CHANNEL
  const everyoneOverwrite = permissionOverwrites.find(
    (o) => o.id === everyoneRoleId && o.type === 0,
  );

  if (!everyoneOverwrite) {
    // No @everyone override → channel is open
    return { isOpen: true, allowedUserIds: [] };
  }

  const deny = BigInt(everyoneOverwrite.deny);
  const isDeniedForEveryone = (deny & VIEW_CHANNEL_BIT) !== 0n;

  if (!isDeniedForEveryone) {
    // @everyone can view → channel is open
    return { isOpen: true, allowedUserIds: [] };
  }

  // Channel is restricted → collect explicitly allowed member IDs
  const allowedUserIds: string[] = [];
  for (const overwrite of permissionOverwrites) {
    if (overwrite.type === 1) {
      // Member-level override
      const allow = BigInt(overwrite.allow);
      if ((allow & VIEW_CHANNEL_BIT) !== 0n) {
        allowedUserIds.push(overwrite.id);
      }
    }
  }

  return { isOpen: false, allowedUserIds };
}

/** Parse a session key to extract its type and identifier. */
export function parseSessionKey(sessionKey: string): {
  type: "dm" | "channel" | "unknown";
  identifier: string; // user_id for DMs, topic_id for thread channels, channel_id for base channels
  channelId?: string;
  topicId?: string;
  parentChannelId?: string; // for active-memory sub-sessions
} {
  const dmMatch = sessionKey.match(/^agent:[^:]+:discord:direct:(\d+)$/);
  if (dmMatch) {
    return { type: "dm", identifier: dmMatch[1] };
  }

  const activeMemoryMatch = sessionKey.match(
    /^agent:[^:]+:discord:channel:(\d+):active-memory:[a-f0-9]+$/,
  );
  if (activeMemoryMatch) {
    return {
      type: "channel",
      identifier: activeMemoryMatch[1],
      channelId: activeMemoryMatch[1],
      parentChannelId: activeMemoryMatch[1],
    };
  }

  const topicMatch = sessionKey.match(/^agent:[^:]+:discord:channel:(\d+):topic:(\d+)$/);
  if (topicMatch) {
    return {
      type: "channel",
      identifier: topicMatch[2],
      channelId: topicMatch[1],
      topicId: topicMatch[2],
      parentChannelId: topicMatch[1],
    };
  }

  const channelMatch = sessionKey.match(/^agent:[^:]+:discord:channel:(\d+)$/);
  if (channelMatch) {
    return { type: "channel", identifier: channelMatch[1], channelId: channelMatch[1] };
  }

  return { type: "unknown", identifier: sessionKey };
}

/**
 * Combine parent channel and thread membership into a single audience.
 *
 * For threads: the effective audience is the INTERSECTION of parent and thread
 * members. Both must allow access. Open (null) on either side means the other
 * side's restriction applies.
 */
function combineParentAndThreadAudience(parentMembers: string[] | null, threadMembers: string[] | null): VisibilityAudience {
  const parentAudience: VisibilityAudience = parentMembers === null ? null : (parentMembers.length === 0 ? undefined as any : new Set(parentMembers));
  const threadAudience: VisibilityAudience = threadMembers === null ? null : (threadMembers.length === 0 ? undefined as any : new Set(threadMembers));

  // [] (restricted, no known members) → deny (undefined mapped to empty set = no one)
  if (parentMembers !== null && parentMembers.length === 0) return new Set<string>();
  if (threadMembers !== null && threadMembers.length === 0) return new Set<string>();

  if (parentAudience === null) return threadAudience;
  if (threadAudience === null) return parentAudience;
  const intersection = new Set<string>();
  for (const userId of threadAudience) {
    if (parentAudience.has(userId)) intersection.add(userId);
  }
  return intersection;
}

/**
 * Determine if a conversation is visible to the current user.
 *
 * @param sessionKey The conversation's session key
 * @param currentUserId The Discord user ID of the person asking
 * @param rules Visibility rules from config (overrides)
 * @param defaultPolicy What to do when no rule matches
 * @param channelMembers Channel membership map (cached + config overrides)
 */
export function isConversationVisible(
  sessionKey: string,
  currentUserId: string | undefined,
  rules: VisibilityRule[],
  defaultPolicy: "owner-only" | "open",
  channelMembers?: ChannelMembersMap,
): boolean {
  if (!currentUserId?.trim()) {
    return false;
  }

  const parsed = parseSessionKey(sessionKey);

  // Check explicit config rules first (overrides)
  for (const rule of rules) {
    if (matchGlob(sessionKey, rule.sessionPattern)) {
      if (rule.allowedUsers.length === 0) return true; // everyone
      return rule.allowedUsers.includes(currentUserId);
    }
  }

  // No explicit rule matched — apply deterministic policy
  if (defaultPolicy === "open") return true;

  // owner-only policy
  switch (parsed.type) {
    case "dm":
      // Only the DM participant can see their own DMs
      return parsed.identifier === currentUserId;

    case "channel":
      // Thread visibility is constrained by BOTH the parent channel and the
      // thread/topic membership.
      if (parsed.topicId) {
        if (!channelMembers?.has(parsed.channelId ?? "") || !channelMembers.has(parsed.topicId)) return false;
        const parentMembers = channelMembers.get(parsed.channelId ?? "")!;
        const threadMembers = channelMembers.get(parsed.topicId)!;
        // If either parent or thread is restricted with no known members → deny
        if (parentMembers !== null && parentMembers.length === 0) return false;
        if (threadMembers !== null && threadMembers.length === 0) return false;
        const audience = combineParentAndThreadAudience(parentMembers, threadMembers);
        if (audience === null) return true;
        return audience.has(currentUserId);
      }

      // Check channel membership (cached + config overrides)
      if (channelMembers && channelMembers.has(parsed.identifier)) {
        const members = channelMembers.get(parsed.identifier)!;
        // null = open channel (everyone can see)
        if (members === null) return true;
        // [] = restricted with no known members → deny
        if (members.length === 0) return false;
        return members.includes(currentUserId);
      }
      // SECURITY: No membership data for this channel — DENY by default.
      return false;

    case "unknown":
      return false;

    default:
      return false;
  }
}

/**
 * Resolve the exact audience that can see a conversation.
 *
 * - null = open/every guild member
 * - Set(userIds) = restricted to those members
 * - undefined = unknown/denied
 */
export function audienceForSessionKey(
  sessionKey: string,
  rules: VisibilityRule[],
  defaultPolicy: "owner-only" | "open",
  channelMembers?: ChannelMembersMap,
): VisibilityAudience | undefined {
  const parsed = parseSessionKey(sessionKey);

  for (const rule of rules) {
    if (matchGlob(sessionKey, rule.sessionPattern)) {
      return rule.allowedUsers.length === 0 ? null : new Set(rule.allowedUsers);
    }
  }

  if (defaultPolicy === "open") return null;

  switch (parsed.type) {
    case "dm":
      return new Set([parsed.identifier]);
    case "channel": {
      if (parsed.topicId) {
        if (!channelMembers?.has(parsed.channelId ?? "") || !channelMembers.has(parsed.topicId)) return undefined;
        const parentMembers = channelMembers.get(parsed.channelId ?? "")!;
        const threadMembers = channelMembers.get(parsed.topicId)!;
        // If either is restricted with no known members → deny
        if (parentMembers !== null && parentMembers.length === 0) return undefined;
        if (threadMembers !== null && threadMembers.length === 0) return undefined;
        return combineParentAndThreadAudience(parentMembers, threadMembers);
      }
      if (!channelMembers?.has(parsed.identifier)) return undefined;
      const members = channelMembers.get(parsed.identifier)!;
      // null = open
      if (members === null) return null;
      // [] = restricted with no known members → deny
      if (members.length === 0) return undefined;
      return new Set(members);
    }
    case "unknown":
    default:
      return undefined;
  }
}

/**
 * Audience-subset visibility rule for cross-conversation recall.
 *
 * A lookup from current audience A may read target conversation B iff A ⊆ B:
 * every member who can see the current channel/thread must also be able to see
 * the target channel/thread. This prevents private/restricted target content
 * leaking into a broader current audience while still allowing narrower current
 * audiences to recall broader/open channels.
 */
export function isConversationVisibleToAudience(
  targetSessionKey: string,
  currentAudience: VisibilityAudience,
  rules: VisibilityRule[],
  defaultPolicy: "owner-only" | "open",
  channelMembers?: ChannelMembersMap,
): boolean {
  const targetAudience = audienceForSessionKey(targetSessionKey, rules, defaultPolicy, channelMembers);
  if (targetAudience === undefined) return false;

  // Current open/everyone audience can only read target conversations that are
  // also open/everyone. A restricted target is not a superset of everyone.
  if (currentAudience === null) return targetAudience === null;

  // Open target is a superset of every restricted current audience.
  if (targetAudience === null) return true;

  for (const userId of currentAudience) {
    if (!targetAudience.has(userId)) return false;
  }
  return true;
}

/**
 * Filter a list of conversation records by visibility.
 */
export function filterVisibleConversations<T extends { sessionKey: string | null }>(
  conversations: T[],
  currentUserId: string | undefined,
  rules: VisibilityRule[],
  defaultPolicy: "owner-only" | "open",
  channelMembers?: ChannelMembersMap,
): T[] {
  if (!currentUserId?.trim()) return [];
  if (!rules.length && defaultPolicy === "open") return conversations;

  return conversations.filter((conv) => {
    if (!conv.sessionKey) return true;
    return isConversationVisible(conv.sessionKey, currentUserId, rules, defaultPolicy, channelMembers);
  });
}

/** Simple glob matcher supporting * (non-colon) and ** (any). */
export function matchGlob(str: string, pattern: string): boolean {
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "⟪⟫")
    .replace(/\*/g, "[^:]*")
    .replace(/⟪⟫/g, ".*");
  return new RegExp(`^${regexStr}$`).test(str);
}
