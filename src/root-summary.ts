/**
 * Root Index generation and regeneration logic.
 *
 * Terminology:
 * - A root summary is the root node of one conversation/session summary DAG.
 * - A root index is the visibility-scoped "book of abstracts" assembled from
 *   the current root/frontier summaries of the conversations visible from a
 *   channel/thread/DM scope. This module currently persists those root indices
 *   in the legacy `root_summaries` table/config surface for compatibility.
 */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { RootSummaryConfig } from "./db/config.js";
import type { LcmSummarizeFn } from "./summarize.js";
import type { RootSummaryStore } from "./store/root-summary-store.js";
import type { SessionRootSummaryStore } from "./store/session-root-summary-store.js";
import type { VisibilityConfig } from "./visibility.js";
import { audienceForSessionKey, buildChannelMembersMap, ChannelMembersMap, isConversationVisibleToAudience, loadChannelMembersFromDB, parseSessionKey, type VisibilityAudience } from "./visibility.js";

/**
 * Build human-readable root-index text from conversation overviews.
 */
export function buildRootSummaryText(
  overviews: Array<ConversationOverview>,
  currentTime: Date,
  timezone: string,
  customInstructions = "",
  scopeLabel = "Cross-Session Memory Root Index",
  visibleDiscordWithoutLcm: Array<{ channelId: string; channelName: string; guildId?: string | null }> = [],
  channelNames: Map<string, string> = new Map(),
): string {
  const lines: string[] = [];
  void currentTime;
  void timezone;
  lines.push("root_index:");
  lines.push(`  scope: ${yamlQuote(scopeLabel)}`);

  const summarized = overviews.filter((ov) => ov.deepestSummary && ov.messageCount > 0);
  const groups = groupConversationOverviews(summarized);

  lines.push("  channels:");
  if (groups.length === 0) {
    lines.push("    []");
  }

  for (const group of groups) {
    if (group.kind === "channel") {
      const channelMessages = group.channelOverviews.reduce((sum, ov) => sum + ov.messageCount, 0);
      const channelDepth = maxOverviewDepth(group.channelOverviews);
      const channelKeywords = mergeOverviewKeywords(group.channelOverviews);
      lines.push("    - id: " + yamlQuote(group.channelId));
      lines.push("      title: " + yamlQuote(channelNames.get(group.channelId) ?? ""));
      if (channelMessages > 0) {
        void channelDepth;
        appendYamlKeywords(lines, channelKeywords, 6);
      }
      if (group.threads.length > 0) {
        lines.push("      threads:");
        for (const thread of group.threads) {
          lines.push("        - id: " + yamlQuote(thread.topicId));
          lines.push("          title: " + yamlQuote(channelNames.get(thread.topicId) ?? ""));
          appendYamlKeywords(lines, overviewKeywords(thread.overview), 10);
        }
      }
      continue;
    }

    lines.push("    - id: " + yamlQuote(parseSessionKeyLabel(group.overview.sessionKey).label));
    lines.push("      title: " + yamlQuote(group.overview.title ?? ""));
    appendYamlKeywords(lines, overviewKeywords(group.overview), 6);
  }

  if (visibleDiscordWithoutLcm.length > 0) {
    lines.push("  visible_without_lcm_history:");
    for (const channel of visibleDiscordWithoutLcm) {
      lines.push("    - id: " + yamlQuote(channel.channelId));
      lines.push("      title: " + yamlQuote(channel.channelName));
      if (channel.guildId) lines.push("      guild_id: " + yamlQuote(channel.guildId));
    }
  }

  return lines.join("\n");
}

function yamlQuote(value: string): string {
  return JSON.stringify(value);
}

function appendYamlBlock(lines: string[], content: string, indent: number): void {
  const prefix = " ".repeat(indent);
  const text = content.trimEnd();
  if (!text) {
    lines.push(`${prefix}`);
    return;
  }
  for (const line of text.split("\n")) {
    lines.push(`${prefix}${line}`);
  }
}

function appendYamlKeywords(lines: string[], keywords: string[], indent: number): void {
  const prefix = " ".repeat(indent);
  if (keywords.length === 0) return;
  lines.push(`${prefix}keywords: [${keywords.map(yamlQuote).join(", ")}]`);
}

function maxOverviewDepth(overviews: ConversationOverview[]): number {
  return Math.max(0, ...overviews.map((ov) => ov.deepestSummary?.depth ?? 0));
}

function mergeOverviewKeywords(overviews: ConversationOverview[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const overview of overviews) {
    for (const keyword of overviewKeywords(overview)) {
      const key = keyword.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(keyword);
      if (result.length >= 8) return result;
    }
  }
  return result;
}

function overviewKeywords(ov: ConversationOverview): string[] {
  if (ov.keywords && ov.keywords.length > 0) return ov.keywords;
  return extractKeywords(ov.deepestSummary?.content ?? "");
}

function extractKeywords(content: string): string[] {
  const text = content.toLowerCase();
  const scored = new Map<string, number>();
  const add = (keyword: string, score: number) => {
    scored.set(keyword, (scored.get(keyword) ?? 0) + score);
  };

  const phrasePatterns: Array<[string, RegExp, number]> = [
    ["root-index", /\broot\s+(?:summary|index|indices|summaries)\b/g, 5],
    ["visibility", /\bvisibility|visible|scop(?:e|ing)|leak(?:age)?|privacy\b/g, 5],
    ["compaction", /\bcompaction|compact(?:ed|ion)?|summary\s+dag|frontier\b/g, 4],
    ["session-identity", /\bsession[-_ ]?key|conversation[_ ]id|discord\s+(?:channel|thread)|thread\s+membership\b/g, 4],
    ["lcm-db", /\blcm\s*(?:db|database)|sqlite|fts5\b/g, 4],
    ["rewind", /\brewind|source\s+(?:delete|deleted|update|replacement)|surgical\b/g, 4],
    ["memory", /\bmemory|MEMORY\.md|long[- ]term\b/g, 3],
    ["clawbank", /\bclawbank|#clawbank\b/g, 5],
    ["crypto-research", /\bcrypto|token|dexscreener|research\b/g, 3],
    ["tests", /\btest(?:s|ing)?|vitest|build|suite\b/g, 2],
  ];
  for (const [keyword, pattern, score] of phrasePatterns) {
    const matches = text.match(pattern);
    if (matches) add(keyword, score * matches.length);
  }

  const codeTerms = Array.from(content.matchAll(/`([A-Za-z][A-Za-z0-9_.:-]{2,60})`/g)).map((match) => match[1]!);
  for (const term of codeTerms) {
    if (/^(summary|session|conversation|channel|thread)$/i.test(term)) continue;
    add(term, 2);
  }

  return [...scored.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([keyword]) => keyword);
}

function formatDiscordChannelHeading(channelId: string, channelNames: Map<string, string>): string {
  const name = channelNames.get(channelId);
  return name ? `<#${channelId}> #${name}` : `<#${channelId}>`;
}

function formatDiscordThreadHeading(channelId: string, topicId: string, channelNames: Map<string, string>): string {
  const channelName = channelNames.get(channelId);
  const threadName = channelNames.get(topicId);
  const parent = channelName ? `<#${channelId}> #${channelName}` : `<#${channelId}>`;
  const thread = threadName ? `<#${topicId}> ${threadName}` : `<#${topicId}>`;
  return `${parent} › ${thread}`;
}

type ConversationOverview = {
  conversationId: number;
  sessionKey: string;
  title?: string;
  /** True when this row belongs to the exact channel/thread/DM scope of the current root index. */
  isRootSession?: boolean;
  deepestSummary?: {
    summaryId: string;
    content: string;
    depth: number;
    earliestAt: Date | null;
    latestAt: Date | null;
  };
  messageCount: number;
  lastActivity: Date | null;
  keywords?: string[];
};

type SummaryIndexRow = {
  summary_id: string;
  content: string;
  depth: number;
  earliest_at: string | null;
  latest_at: string | null;
  created_at?: string | null;
  ordinal?: number | null;
};

/**
 * Heuristic guardrail for root-index abstracts.
 *
 * The Root Index is a Book of Abstracts, not a dump of whatever happened to be
 * on the compaction frontier.  When a frontier entry is a raw tool/code/log
 * fallback, injecting it into every visible bootstrap makes the model know
 * neither what it knows nor what it does not know.  Keep technical summaries,
 * but reject obvious raw-transcript/fallback/code dumps.
 */
export function isLowQualityRootIndexSummary(content: string): boolean {
  const text = content.trim();
  if (!text) return true;
  if (text.includes("LCM fallback summary; truncated") || text.includes("[truncated for context management]")) return true;
  if (/^\[toolCall\]/.test(text)) return true;
  if (/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2} GMT[+-]\d+\]/.test(text) && text.length > 1200) return true;

  const lines = text.split("\n");
  const codeishLines = lines.filter((line) =>
    /^\s*(?:import\s|export\s|const\s|let\s|var\s|function\s|async\s|class\s|interface\s|type\s|SELECT\s|INSERT\s|UPDATE\s|CREATE\s+TABLE\b|[}\])];?\s*$|\d+:\s*)/.test(line)
  ).length;
  if (lines.length >= 12 && codeishLines / lines.length > 0.35) return true;

  const toolNoise = (text.match(/\b(?:exec\(|sqlite3\b|node:internal|ERR_MODULE_NOT_FOUND|Command still running|Process exited with code|Successfully replaced \d+ block)/g) ?? []).length;
  return toolNoise >= 3 && text.length > 800;
}

function parseOptionalDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function chooseRootIndexSummary(input: {
  frontierRows: SummaryIndexRow[];
  allRows: SummaryIndexRow[];
}): { rows: SummaryIndexRow[]; quality: "frontier" | "session-abstract" | "best-available" | "missing" } {
  const usableAll = input.allRows.filter((row) => !isLowQualityRootIndexSummary(row.content));
  const usableFrontier = input.frontierRows.filter((row) => !isLowQualityRootIndexSummary(row.content));

  if (usableFrontier.length === 1) {
    return { rows: usableFrontier, quality: "frontier" };
  }
  if (usableFrontier.length > 1 && usableFrontier.length === input.frontierRows.length) {
    return { rows: usableFrontier, quality: "frontier" };
  }

  const sessionAbstracts = usableAll
    .filter((row) => /^\*\*Session Summary\b/i.test(row.content.trim()) || /^Session Summary\b/i.test(row.content.trim()))
    .sort(compareSummaryIndexRowsNewestFirst);
  if (sessionAbstracts[0]) {
    return { rows: [sessionAbstracts[0]], quality: "session-abstract" };
  }

  const condensed = usableAll
    .filter((row) => row.depth > 0)
    .sort((a, b) => (b.depth - a.depth) || compareSummaryIndexRowsNewestFirst(a, b));
  if (condensed[0]) {
    return { rows: [condensed[0]], quality: "best-available" };
  }

  const latestUsable = usableAll.sort(compareSummaryIndexRowsNewestFirst)[0];
  if (latestUsable) {
    return { rows: [latestUsable], quality: "best-available" };
  }

  return { rows: [], quality: "missing" };
}

function compareSummaryIndexRowsNewestFirst(a: SummaryIndexRow, b: SummaryIndexRow): number {
  const aDate = parseOptionalDate(a.latest_at)?.getTime() ?? parseOptionalDate(a.created_at)?.getTime() ?? 0;
  const bDate = parseOptionalDate(b.latest_at)?.getTime() ?? parseOptionalDate(b.created_at)?.getTime() ?? 0;
  return bDate - aDate;
}

function appendOverviewSummary(lines: string[], ov: ConversationOverview, includeTimeRange = true): void {
  if (includeTimeRange) {
    const timeRange = formatTimeRange(
      ov.deepestSummary?.earliestAt,
      ov.deepestSummary?.latestAt,
      ov.lastActivity,
    );
    lines.push(`Range: ${timeRange}`);
  }
  if (!ov.deepestSummary) return;
  const content = ov.deepestSummary.content;
  const maxContentLen = 600;
  lines.push(content.length > maxContentLen ? content.substring(0, maxContentLen) + "..." : content);
}

function parseDiscordChannelThread(sessionKey: string): { channelId: string; topicId?: string } | null {
  const match = sessionKey.match(/^agent:[^:]+:discord:channel:(\d+)(?::topic:(\d+))?$/);
  if (!match) return null;
  return { channelId: match[1]!, topicId: match[2] };
}

function groupConversationOverviews(overviews: ConversationOverview[]): Array<
  | { kind: "channel"; channelId: string; channelOverviews: ConversationOverview[]; threads: Array<{ topicId: string; overview: ConversationOverview }> }
  | { kind: "other"; overview: ConversationOverview }
> {
  const channelGroups = new Map<string, { channelOverviews: ConversationOverview[]; threads: Array<{ topicId: string; overview: ConversationOverview }> }>();
  const others: ConversationOverview[] = [];

  for (const ov of overviews) {
    const parsed = parseDiscordChannelThread(ov.sessionKey);
    if (!parsed) {
      others.push(ov);
      continue;
    }
    const group = channelGroups.get(parsed.channelId) ?? { channelOverviews: [], threads: [] };
    if (parsed.topicId) {
      if (parsed.topicId === parsed.channelId) {
        group.channelOverviews.push(ov);
      } else {
        group.threads.push({ topicId: parsed.topicId, overview: ov });
      }
    } else {
      group.channelOverviews.push(ov);
    }
    channelGroups.set(parsed.channelId, group);
  }

  const channelResults = [...channelGroups.entries()]
    .map(([channelId, group]) => ({
      kind: "channel" as const,
      channelId,
      channelOverviews: group.channelOverviews,
      threads: dedupeThreadOverviews(group.threads).sort((a, b) => a.topicId.localeCompare(b.topicId)),
    }))
    .filter((group) => group.channelOverviews.length > 0 || group.threads.length > 0)
    .sort((a, b) => a.channelId.localeCompare(b.channelId));

  return [
    ...channelResults,
    ...others.map((overview) => ({ kind: "other" as const, overview })),
  ];
}

function dedupeThreadOverviews(
  threads: Array<{ topicId: string; overview: ConversationOverview }>,
): Array<{ topicId: string; overview: ConversationOverview }> {
  const byTopic = new Map<string, { topicId: string; overview: ConversationOverview }>();
  for (const thread of threads) {
    const existing = byTopic.get(thread.topicId);
    if (!existing || thread.overview.messageCount > existing.overview.messageCount) {
      byTopic.set(thread.topicId, thread);
    }
  }
  return [...byTopic.values()];
}

/**
 * Parse a session key into a human-readable label.
 */
function parseSessionKeyLabel(sessionKey: string): {
  label: string;
  type: string;
} {
  // DM sessions
  const dmMatch = sessionKey.match(
    /^agent:[^:]+:discord:direct:(\d+)$/,
  );
  if (dmMatch) {
    return {
      label: `DM with ${dmMatch[1]}`,
      type: "dm",
    };
  }

  // Active-memory thread
  const amMatch = sessionKey.match(
    /^agent:[^:]+:discord:channel:(\d+):active-memory:([a-f0-9]+)$/,
  );
  if (amMatch) {
    return { label: `Channel ${amMatch[1]} (active-memory ${amMatch[2]})`, type: "channel" };
  }

  // Channel (with optional topic/thread)
  const chMatch = sessionKey.match(
    /^agent:[^:]+:discord:channel:(\d+)(?::topic:(\d+))?$/,
  );
  if (chMatch) {
    const channelId = chMatch[1]!;
    const topicId = chMatch[2];
    const baseName = `Channel ${channelId}`;
    return topicId
      ? { label: `${baseName} (topic ${topicId})`, type: "channel" }
      : { label: baseName, type: "channel" };
  }

  return { label: sessionKey, type: "unknown" };
}

/**
 * Format a time range for display.
 */
function formatTimeRange(
  earliest: Date | null | undefined,
  latest: Date | null | undefined,
  fallback: Date | null | undefined,
): string {
  const start = earliest ?? fallback;
  const end = latest ?? fallback;
  if (!start && !end) return "no activity";

  const fmt = (d: Date) => d.toISOString().split("T")[0];
  if (
    start &&
    end &&
    start.getTime() !== end.getTime()
  ) {
    return `${fmt(start)} — ${fmt(end)}`;
  }
  return fmt((start ?? end)!);
}

/**
 * Regenerate stale root indices for all known visibility scopes.
 *
 * This builds a visibility-scoped root index by:
 * 1. Finding all visible conversations for the user
 * 2. Taking the current context_items summary frontier from each
 * 3. Combining them into a single text block
 * 4. Upserting into the root_summaries table
 */
export function rootKeyForSessionVisibility(sessionKey: string): string | undefined {
  const parsed = parseSessionKey(sessionKey);
  if (parsed.type === "dm") return `dm:${parsed.identifier}`;
  if (parsed.type === "channel") {
    return parsed.topicId
      ? `channel:${parsed.channelId}:topic:${parsed.topicId}`
      : `channel:${parsed.channelId}`;
  }
  return undefined;
}

export function isScopedRootIndexKey(rootKey: string): boolean {
  return rootKey.startsWith("channel:") || rootKey.startsWith("dm:");
}

function parseVisibilityRootKey(rootKey: string): { type: "dm" | "channel"; identifier: string; channelId?: string; topicId?: string } | null {
  const dmMatch = rootKey.match(/^dm:(\d+)$/);
  if (dmMatch) return { type: "dm", identifier: dmMatch[1]! };

  const topicMatch = rootKey.match(/^channel:(\d+):topic:(\d+)$/);
  if (topicMatch) {
    return {
      type: "channel",
      identifier: topicMatch[2]!,
      channelId: topicMatch[1]!,
      topicId: topicMatch[2]!,
    };
  }

  const channelMatch = rootKey.match(/^channel:(\d+)$/);
  if (channelMatch) {
    return { type: "channel", identifier: channelMatch[1]!, channelId: channelMatch[1]! };
  }

  return null;
}

type ChannelMembershipInfo = { guildId: string | null; channelName?: string | null };

function loadChannelMembershipInfoFromDB(db: DatabaseSync): Map<string, ChannelMembershipInfo> {
  const info = new Map<string, ChannelMembershipInfo>();
  try {
    const rows = db
      .prepare("SELECT channel_id, guild_id, channel_name FROM channel_membership")
      .all() as Array<{ channel_id?: string; guild_id?: string | null; channel_name?: string | null }>;
    for (const row of rows) {
      const id = row.channel_id?.trim();
      if (!id) continue;
      info.set(id, { guildId: row.guild_id ?? null, channelName: row.channel_name ?? null });
    }
  } catch {
    // Optional discovery table may not exist yet.
  }
  return info;
}

function usersForScopedRootKey(rootKey: string, channelMembersMap: ChannelMembersMap): string[] | null {
  const root = parseVisibilityRootKey(rootKey);
  if (!root) return [];

  if (root.type === "dm") return [root.identifier];

  if (!root.channelId || !channelMembersMap.has(root.channelId)) {
    // Unknown channel visibility is not open. It must not get a root index.
    return [];
  }

  const parentMembers = channelMembersMap.get(root.channelId)!;
  // Restricted channel with no known members → deny root generation.
  if (parentMembers !== null && parentMembers.length === 0) return [];

  if (root.topicId) {
    if (!channelMembersMap.has(root.topicId)) {
      // Unknown thread visibility is not parent-inherited. Private threads can
      // be narrower than their parent; deny root generation until discovered.
      return [];
    }
    const threadMembers = channelMembersMap.get(root.topicId)!;
    // Restricted thread with no known members → deny.
    if (threadMembers !== null && threadMembers.length === 0) return [];
    // Both open → open
    if (parentMembers === null && threadMembers === null) return null;
    // Parent open, thread restricted → thread members
    if (parentMembers === null) return threadMembers!;
    // Thread open, parent restricted → parent members
    if (threadMembers === null) return parentMembers;
    // Both restricted → intersection
    return threadMembers.filter((userId) => parentMembers.includes(userId));
  }

  // null means open to every guild member. That is safe only when backed by an
  // explicit open membership entry (is_open=1), not by a missing DB row or
  // restricted-empty member_ids.
  return parentMembers;
}

function currentAudienceForRootKey(rootKey: string, channelMembersMap: ChannelMembersMap): string[] | null {
  return usersForScopedRootKey(rootKey, channelMembersMap);
}

function guildIdForRootKey(rootKey: string, channelMembers: Map<string, ChannelMembershipInfo>): string | null | undefined {
  const root = parseVisibilityRootKey(rootKey);
  if (!root || root.type !== "channel") return undefined;
  const topicGuild = root.topicId ? channelMembers.get(root.topicId)?.guildId : undefined;
  const parentGuild = root.channelId ? channelMembers.get(root.channelId)?.guildId : undefined;
  return topicGuild ?? parentGuild;
}

function guildIdForSessionKey(sessionKey: string, channelMembers: Map<string, ChannelMembershipInfo>): string | null | undefined {
  const parsed = parseSessionKey(sessionKey);
  if (parsed.type !== "channel") return undefined;
  const topicGuild = parsed.topicId ? channelMembers.get(parsed.topicId)?.guildId : undefined;
  const parentGuild = parsed.channelId ? channelMembers.get(parsed.channelId)?.guildId : undefined;
  return topicGuild ?? parentGuild;
}

function sameOrCompatibleGuild(rootGuildId: string | null | undefined, targetGuildId: string | null | undefined): boolean {
  if (!rootGuildId || !targetGuildId) return false;
  return rootGuildId === targetGuildId;
}

function isAudienceSupersetOfCurrent(currentAudience: VisibilityAudience, targetAudience: VisibilityAudience | undefined): boolean {
  if (targetAudience === undefined) return false;
  if (currentAudience === null) return targetAudience === null;
  if (targetAudience === null) return true;
  for (const userId of currentAudience) {
    if (!targetAudience.has(userId)) return false;
  }
  return true;
}

function rootCanIndexConversation(
  sourceSessionKey: string,
  rootKey: string,
  rootAudience: VisibilityAudience,
  channelMembersMap: ChannelMembersMap,
  channelMembershipInfo: Map<string, ChannelMembershipInfo>,
  rules: VisibilityConfig["rules"],
  defaultPolicy: VisibilityConfig["defaultPolicy"],
): boolean {
  const sourceRootKey = rootKeyForSessionVisibility(sourceSessionKey);
  if (sourceRootKey === rootKey) return true;

  // Historical Discord thread rows briefly used the thread id as the parent
  // channel id (channel:<topic>:topic:<topic>) before canonical parent+topic
  // keys were fixed. Treat those as the same session root when topic id matches.
  const source = parseVisibilityRootKey(sourceRootKey ?? "");
  const current = parseVisibilityRootKey(rootKey);
  if (
    source?.type === "channel" &&
    current?.type === "channel" &&
    source.topicId &&
    current.topicId &&
    source.topicId === current.topicId
  ) {
    return true;
  }

  // Cross-session index entries are allowed only inside a known same Discord
  // guild and only when the target audience is a superset of the current root
  // audience. Unknown guild ids fail closed; otherwise open channels from
  // unrelated servers can look compatible just because both rows lack guild
  // metadata.
  const rootGuild = guildIdForRootKey(rootKey, channelMembershipInfo);
  const targetGuild = guildIdForSessionKey(sourceSessionKey, channelMembershipInfo);
  if (!sameOrCompatibleGuild(rootGuild, targetGuild)) return false;
  const targetAudience = audienceForSessionKey(
    sourceSessionKey,
    rules ?? [],
    defaultPolicy ?? "owner-only",
    channelMembersMap,
  );
  return isAudienceSupersetOfCurrent(rootAudience, targetAudience);
}

function resolveRootIndexKeywords(params: {
  db: DatabaseSync;
  conversationId: number;
  title?: string;
  selectedSummaryContent: string;
  summarizeKeywords?: LcmSummarizeFn;
}): string[] {
  const cached = getCachedRootIndexKeywords(
    params.db,
    params.conversationId,
    params.selectedSummaryContent,
  );
  if (cached.length > 0) return cached;

  // Do not synthesize root-index keywords synchronously from weak heuristics.
  // Missing model-reviewed keywords are less harmful than misleading generic tags.
  return [];
}

export async function materializeRootIndexKeywords(params: {
  db: DatabaseSync;
  conversationId: number;
  title?: string;
  content: string;
  summarize: LcmSummarizeFn;
  minKeywords?: number;
  maxKeywords?: number;
}): Promise<string[]> {
  const cached = getCachedRootIndexKeywords(
    params.db,
    params.conversationId,
    params.content,
  );
  if (cached.length > 0) return cached;

  const minKeywords = Math.max(1, Math.floor(params.minKeywords ?? 3));
  const maxKeywords = Math.max(minKeywords, Math.floor(params.maxKeywords ?? 10));
  const clippedContent = params.content.length > 12_000
    ? `${params.content.slice(0, 12_000).trimEnd()}\n...[truncated]`
    : params.content;
  const prompt = `Extract high-quality semantic keywords for a compact cross-session memory index.\n\nRules:\n- Return ONLY a JSON array of strings.\n- ${minKeywords}-${maxKeywords} keywords.\n- lowercase kebab-case.\n- Prefer stable topics/projects/concepts, not people, dates, generic metadata, or vague words.\n- Avoid: root, summary, session, message, conversation, channel, thread unless part of a specific technical concept like root-index or session-identity.\n- If the text is mostly technical work, capture the actual engineering themes.\n\nTitle: ${params.title ?? ""}\n\nText:\n${clippedContent}`;

  let modelKeywords: string[] = [];
  try {
    const output = await params.summarize(prompt, false, { trigger: "nightly-summary" });
    modelKeywords = sanitizeKeywordList(parseKeywordJsonArray(output), maxKeywords);
  } catch {
    modelKeywords = [];
  }

  const reviewed = await reviewKeywordQualityWithModel({
    keywords: modelKeywords,
    minKeywords,
    maxKeywords,
    title: params.title,
    content: clippedContent,
    summarize: params.summarize,
  });
  setCachedRootIndexKeywords(params.db, params.conversationId, params.content, reviewed);
  return reviewed;
}

async function reviewKeywordQualityWithModel(params: {
  keywords: string[];
  minKeywords: number;
  maxKeywords: number;
  title?: string;
  content: string;
  summarize: LcmSummarizeFn;
}): Promise<string[]> {
  const initial = sanitizeKeywordList(params.keywords, params.maxKeywords);
  if (initial.length === 0) return [];
  const prompt = `Review these root-index keywords for quality.\n\nReturn ONLY a JSON array of ${params.minKeywords}-${params.maxKeywords} lowercase kebab-case strings. Remove vague/generic/meta tags; keep only useful semantic discovery tags. Add better replacements if needed.\n\nTitle: ${params.title ?? ""}\nCurrent keywords: ${JSON.stringify(initial)}\n\nText:\n${params.content}`;
  try {
    const output = await params.summarize(prompt, false, { trigger: "nightly-summary" });
    const reviewed = sanitizeKeywordList(parseKeywordJsonArray(output), params.maxKeywords);
    return reviewed.length >= params.minKeywords ? reviewed : initial;
  } catch {
    return initial;
  }
}

function parseKeywordJsonArray(output: string): string[] {
  const trimmed = output.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim() ?? trimmed;
  try {
    const parsed = JSON.parse(fenced);
    if (Array.isArray(parsed)) return parsed.filter((value): value is string => typeof value === "string");
  } catch {
    // fall through to loose parser
  }
  const bracket = fenced.match(/\[[\s\S]*\]/)?.[0];
  if (bracket) {
    try {
      const parsed = JSON.parse(bracket);
      if (Array.isArray(parsed)) return parsed.filter((value): value is string => typeof value === "string");
    } catch {
      // fall through
    }
  }
  return fenced.split(/[\n,]/).map((part) => part.replace(/^[-*]\s*/, "").trim()).filter(Boolean);
}

export function sanitizeRootIndexKeywordListForTesting(keywords: string[], maxKeywords: number): string[] {
  return sanitizeKeywordList(keywords, maxKeywords);
}

function sanitizeKeywordList(keywords: string[], maxKeywords: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const keyword of keywords) {
    const normalized = normalizeKeyword(keyword);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= maxKeywords) break;
  }
  return result;
}

const BANNED_EXACT_KEYWORDS = new Set([
  "root",
  "summary",
  "summaries",
  "session",
  "sessions",
  "message",
  "messages",
  "conversation",
  "conversations",
  "channel",
  "channels",
  "thread",
  "threads",
  "gmt",
  "todo",
  "files",
  "the",
  "key",
  "maxxxpwr",
  "general",
  "test-suite",
  "tests",
  "testing",
  "visibility",
  "visibility-scoping",
  "context-compaction",
  "compaction",
  "session-identity",
  "memory-architecture",
  "lcm-database",
  "source-rewind",
  // Prompt/schema instruction fragments leaked by failed keyword review calls.
  "rules",
  "title",
  "text",
  "current-keywords",
  "json-array",
  "strings",
  "keywords",
  "lowercase-kebab-case",
  "return-only-a-json-array-of-strings",
  "5-12-keywords",
  "3-10-keywords",
  "prefer-stable-topics-projects-concepts",
  "not-people",
  "dates",
  "generic-metadata",
  "or-vague-words",
  "avoid-root",
  "capture-the-actual-engineering-themes",
]);

const BANNED_KEYWORD_PATTERNS = [
  /^return-only(?:-|$)/,
  /^review-these-root-index-keywords(?:-|$)/,
  /^current-keywords(?:-|$)/,
  /^title(?:-|$)/,
  /^rules(?:-|$)/,
  /^text(?:-|$)/,
  /^\d+-\d+-keywords$/,
  /(?:^|-)json-array(?:-|$)/,
  /(?:^|-)lowercase-kebab-case(?:-|$)/,
  /(?:^|-)generic-metadata(?:-|$)/,
  /(?:^|-)vague-words(?:-|$)/,
  /(?:^|-)stable-topics-projects-concepts(?:-|$)/,
  /(?:^|-)actual-engineering-themes(?:-|$)/,
  /(?:^|-)prefer-stable-topics(?:-|$)/,
  /(?:^|-)not-people(?:-|$)/,
];

function isBannedKeyword(keyword: string): boolean {
  if (BANNED_EXACT_KEYWORDS.has(keyword)) return true;
  if (BANNED_KEYWORD_PATTERNS.some((pattern) => pattern.test(keyword))) return true;
  // Single-token architecture/meta labels from weak fallbacks are too vague for
  // discovery. Keep specific multi-word project/domain tags instead.
  if (/^(memory|database|sqlite|discord|privacy|model|build|config|plugin|gateway)$/.test(keyword)) return true;
  return false;
}

function normalizeKeyword(keyword: string): string | null {
  const normalized = keyword
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  if (normalized.length < 4 || normalized.length > 48) return null;
  if (isBannedKeyword(normalized)) return null;
  return normalized;
}

function ensureRootIndexKeywordCacheTable(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS root_index_keywords (
    conversation_id INTEGER PRIMARY KEY,
    keywords TEXT NOT NULL,
    content_hash TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  try {
    const columns = db.prepare(`PRAGMA table_info(root_index_keywords)`).all() as Array<{ name?: string }>;
    if (!columns.some((column) => column.name === "content_hash")) {
      db.exec(`ALTER TABLE root_index_keywords ADD COLUMN content_hash TEXT`);
    }
  } catch {
    // Keyword cache is best-effort.
  }
}

function rootIndexKeywordContentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 32);
}

function getCachedRootIndexKeywords(db: DatabaseSync, conversationId: number, content: string): string[] {
  try {
    ensureRootIndexKeywordCacheTable(db);
    const row = db.prepare("SELECT keywords, content_hash FROM root_index_keywords WHERE conversation_id = ?").get(conversationId) as { keywords?: string; content_hash?: string | null } | undefined;
    if (!row?.keywords) return [];
    const expectedHash = rootIndexKeywordContentHash(content);
    if (row.content_hash !== expectedHash) return [];
    const parsed = JSON.parse(row.keywords);
    const keywords = Array.isArray(parsed) ? sanitizeKeywordList(parsed.filter((value): value is string => typeof value === "string"), 15) : [];
    if (keywords.length === 0 && row.keywords !== "[]") {
      db.prepare("DELETE FROM root_index_keywords WHERE conversation_id = ?").run(conversationId);
    }
    return keywords;
  } catch {
    return [];
  }
}

function setCachedRootIndexKeywords(db: DatabaseSync, conversationId: number, content: string, keywords: string[]): void {
  try {
    ensureRootIndexKeywordCacheTable(db);
    db.prepare(`INSERT INTO root_index_keywords (conversation_id, keywords, content_hash, updated_at) VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(conversation_id) DO UPDATE SET keywords = excluded.keywords, content_hash = excluded.content_hash, updated_at = excluded.updated_at`)
      .run(conversationId, JSON.stringify(keywords), rootIndexKeywordContentHash(content));
  } catch {
    // Cache is best-effort; root index still has deterministic fallback keywords.
  }
}

function isConversationInRootScope(sourceSessionKey: string, rootKey: string): boolean {
  return rootKeyForSessionVisibility(sourceSessionKey) === rootKey;
}

function conversationVisibleToRootAudience(
  sourceSessionKey: string,
  rootAudience: string[] | null,
  channelMembersMap: ChannelMembersMap,
  rules: VisibilityConfig["rules"],
  defaultPolicy: VisibilityConfig["defaultPolicy"],
): boolean {
  return isConversationVisibleToAudience(
    sourceSessionKey,
    rootAudience === null ? null : new Set(rootAudience),
    rules ?? [],
    defaultPolicy ?? "owner-only",
    channelMembersMap,
  );
}

export function rootIndexKeysVisibleToConversation(params: {
  db: DatabaseSync;
  rootKeys: string[];
  sourceSessionKey: string;
  visibilityConfig: VisibilityConfig;
}): string[] {
  if (!params.visibilityConfig.enabled) return [];
  const channelMembersMap: ChannelMembersMap = params.visibilityConfig.channelMembers
    ? buildChannelMembersMap(
        loadChannelMembersFromDB(params.db),
        params.visibilityConfig.channelMembers,
      )
    : loadChannelMembersFromDB(params.db);
  const channelMembershipInfo = loadChannelMembershipInfoFromDB(params.db);
  const affected = new Set<string>();
  const sourceRootKey = rootKeyForSessionVisibility(params.sourceSessionKey);
  if (sourceRootKey && isScopedRootIndexKey(sourceRootKey)) {
    affected.add(sourceRootKey);
  }

  for (const rootKey of params.rootKeys) {
    if (!isScopedRootIndexKey(rootKey)) continue;
    const rootAudience = currentAudienceForRootKey(rootKey, channelMembersMap);
    if (rootAudience !== null && rootAudience.length === 0) continue;
    if (rootCanIndexConversation(
      params.sourceSessionKey,
      rootKey,
      rootAudience === null ? null : new Set(rootAudience),
      channelMembersMap,
      channelMembershipInfo,
      params.visibilityConfig.rules,
      params.visibilityConfig.defaultPolicy,
    )) {
      affected.add(rootKey);
    }
  }

  return [...affected];
}

function isConversationStaleForRootIndex(
  row: {
    active: number;
    created_at?: string | null;
    updated_at?: string | null;
    last_message_at?: string | null;
    last_summary_at?: string | null;
  },
  archiveCutoff: Date,
): boolean {
  if (row.active === 1) return false;
  const lastActivity = latestDate(row.last_message_at, row.last_summary_at, row.updated_at, row.created_at);
  return lastActivity !== null && lastActivity.getTime() < archiveCutoff.getTime();
}

function latestDate(...values: Array<string | null | undefined>): Date | null {
  let latest: Date | null = null;
  for (const value of values) {
    const date = parseOptionalDate(value);
    if (!date) continue;
    if (!latest || date.getTime() > latest.getTime()) latest = date;
  }
  return latest;
}

function visibleDiscordChannelsWithoutLcm(input: {
  db: DatabaseSync;
  rootKey: string;
  rootAudience: string[] | null;
  activeSessionKeys: Set<string>;
  channelMembersMap: ChannelMembersMap;
  channelMembershipInfo: Map<string, ChannelMembershipInfo>;
}): Array<{ channelId: string; channelName: string; guildId?: string | null }> {
  let rows: Array<{ channel_id: string; channel_name: string | null; guild_id: string | null }> = [];
  try {
    rows = input.db.prepare(
      `SELECT channel_id, channel_name, guild_id
       FROM channel_membership
       ORDER BY COALESCE(channel_name, channel_id), channel_id`,
    ).all() as Array<{ channel_id: string; channel_name: string | null; guild_id: string | null }>;
  } catch {
    return [];
  }

  const activeTopicIds = new Set<string>();
  const activeParentChannelIdsWithThreadHistory = new Set<string>();
  for (const sessionKey of input.activeSessionKeys) {
    const parsed = parseSessionKey(sessionKey);
    if (parsed.topicId) {
      activeTopicIds.add(parsed.topicId);
      if (parsed.channelId) activeParentChannelIdsWithThreadHistory.add(parsed.channelId);
    }
  }

  return rows
    .filter((row) => {
      const sessionKey = `agent:main:discord:channel:${row.channel_id}`;
      if (input.activeSessionKeys.has(sessionKey)) return false;
      // Discord thread IDs are also channel IDs. If the ID is already known as
      // a topic under a parent channel, do not list it again as a standalone
      // visible channel without LCM history.
      if (activeTopicIds.has(row.channel_id)) return false;
      // Parent channels that only contain thread conversations are still covered
      // by those thread summaries in the grouped root index. Do not label them
      // as having no LCM history just because the parent channel itself has no
      // standalone conversation.
      if (activeParentChannelIdsWithThreadHistory.has(row.channel_id)) return false;
      return rootCanIndexConversation(
        sessionKey,
        input.rootKey,
        input.rootAudience === null ? null : new Set(input.rootAudience),
        input.channelMembersMap,
        input.channelMembershipInfo,
        [],
        "owner-only",
      );
    })
    .map((row) => ({
      channelId: row.channel_id,
      channelName: row.channel_name ?? row.channel_id,
      guildId: row.guild_id,
    }));
}

function loadChannelNamesFromDB(db: DatabaseSync): Map<string, string> {
  const names = new Map<string, string>();
  try {
    const rows = db
      .prepare("SELECT channel_id, channel_name FROM channel_membership WHERE channel_name IS NOT NULL")
      .all() as Array<{ channel_id?: string; channel_name?: string }>;
    for (const row of rows) {
      const id = row.channel_id?.trim();
      const name = row.channel_name?.trim();
      if (id && name) names.set(id, name);
    }
  } catch {
    // Optional auto-discovery table may not exist yet.
  }
  return names;
}

export async function materializeRootIndexKeywordsForVisibleConversations(params: {
  db: DatabaseSync;
  visibilityConfig: VisibilityConfig;
  summarize: LcmSummarizeFn;
  sessionRootSummaryStore?: SessionRootSummaryStore;
}): Promise<number> {
  if (!params.visibilityConfig.enabled) return 0;
  const channelMembersMap: ChannelMembersMap = params.visibilityConfig.channelMembers
    ? buildChannelMembersMap(
        loadChannelMembersFromDB(params.db),
        params.visibilityConfig.channelMembers,
      )
    : loadChannelMembersFromDB(params.db);
  const rows = params.db
    .prepare(`SELECT c.conversation_id, c.session_key, c.title
      FROM conversations c
      WHERE c.session_key IS NOT NULL`)
    .all() as Array<{ conversation_id: number; session_key: string; title: string | null }>;
  let materialized = 0;
  for (const row of rows) {
    const rootKey = rootKeyForSessionVisibility(row.session_key);
    if (!rootKey || !isScopedRootIndexKey(rootKey)) continue;
    const rootAudience = currentAudienceForRootKey(rootKey, channelMembersMap);
    if (rootAudience !== null && rootAudience.length === 0) continue;
    if (!conversationVisibleToRootAudience(
      row.session_key,
      rootAudience,
      channelMembersMap,
      params.visibilityConfig.rules,
      params.visibilityConfig.defaultPolicy,
    )) continue;

    const sessionRoot = params.sessionRootSummaryStore?.get(row.conversation_id);
    const selected = sessionRoot && !sessionRoot.stale && sessionRoot.content.trim()
      ? { content: sessionRoot.content, isThread: Boolean(parseDiscordChannelThread(row.session_key)?.topicId) }
      : selectRootIndexSummaryForConversation(params.db, row.conversation_id);
    if (!selected.content) continue;
    const before = getCachedRootIndexKeywords(
      params.db,
      row.conversation_id,
      selected.content,
    );
    await materializeRootIndexKeywords({
      db: params.db,
      conversationId: row.conversation_id,
      title: row.title ?? undefined,
      content: selected.content,
      summarize: params.summarize,
      minKeywords: selected.isThread ? 3 : 5,
      maxKeywords: selected.isThread ? 8 : 12,
    });
    if (before.length === 0) materialized += 1;
  }
  return materialized;
}

function summariesHaveStaleColumn(db: DatabaseSync): boolean {
  try {
    return (db.prepare(`PRAGMA table_info(summaries)`).all() as Array<{ name?: string }>).some((col) => col.name === "stale");
  } catch {
    return false;
  }
}

function selectRootIndexSummaryForConversation(db: DatabaseSync, conversationId: number): { content: string; isThread: boolean } {
  const session = db.prepare("SELECT session_key FROM conversations WHERE conversation_id = ?").get(conversationId) as { session_key?: string } | undefined;
  const isThread = Boolean(session?.session_key && parseDiscordChannelThread(session.session_key)?.topicId);
  const frontierRows = db
    .prepare(`SELECT s.summary_id, s.content, s.depth, s.earliest_at, s.latest_at, ci.ordinal
       FROM context_items ci
       JOIN summaries s ON s.summary_id = ci.summary_id
       WHERE ci.conversation_id = ? AND ci.item_type = 'summary'
       ORDER BY ci.ordinal ASC`)
    .all(conversationId) as SummaryIndexRow[];
  const hasSummaryStaleColumn = summariesHaveStaleColumn(db);
  const allRows = db
    .prepare(`SELECT summary_id, content, depth, earliest_at, latest_at, created_at
       FROM summaries
       WHERE conversation_id = ?${hasSummaryStaleColumn ? " AND COALESCE(stale, 0) = 0" : ""}
       ORDER BY created_at ASC`)
    .all(conversationId) as SummaryIndexRow[];
  const selected = chooseRootIndexSummary({ frontierRows, allRows });
  return { content: selected.rows.map((row) => row.content).join("\n\n"), isThread };
}

export function regenerateStaleRoots(
  rootStore: RootSummaryStore,
  db: DatabaseSync,
  visibilityConfig: VisibilityConfig,
  maxTokensOrConfig: number | RootSummaryConfig,
  timezone: string,
  options: {
    summarizeKeywords?: LcmSummarizeFn;
    sessionRootSummaryStore?: SessionRootSummaryStore;
  } = {},
): void {
  if (!visibilityConfig.enabled) return;
  const rootConfig = typeof maxTokensOrConfig === "number"
    ? { maxTokens: maxTokensOrConfig, minAgeMinutes: 0, customInstructions: "" }
    : maxTokensOrConfig;
  const maxTokens = Math.max(1, rootConfig.maxTokens ?? 2000);
  const minAgeMinutes = Math.max(0, rootConfig.minAgeMinutes ?? 0);
  const minCreatedAt = minAgeMinutes > 0
    ? new Date(Date.now() - minAgeMinutes * 60_000)
    : null;
  const archiveCutoff = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);

  const channelMembersMap: ChannelMembersMap = visibilityConfig.channelMembers
    ? buildChannelMembersMap(
        loadChannelMembersFromDB(db),
        visibilityConfig.channelMembers,
      )
    : loadChannelMembersFromDB(db);
  const channelMembershipInfo = loadChannelMembershipInfoFromDB(db);
  const hasSummaryStaleColumn = summariesHaveStaleColumn(db);

  const convRows = db
    .prepare(
      `SELECT
         c.conversation_id,
         c.session_key,
         c.title,
         c.active,
         c.created_at,
         c.updated_at,
         MAX(m.created_at) AS last_message_at,
         MAX(s.latest_at) AS last_summary_at
       FROM conversations c
       LEFT JOIN messages m ON m.conversation_id = c.conversation_id
       LEFT JOIN summaries s ON s.conversation_id = c.conversation_id${hasSummaryStaleColumn ? " AND COALESCE(s.stale, 0) = 0" : ""}
       WHERE c.session_key IS NOT NULL
       GROUP BY c.conversation_id`,
    )
    .all() as Array<{
    conversation_id: number;
    session_key: string;
    title: string | null;
    active: number;
    created_at?: string | null;
    updated_at?: string | null;
    last_message_at?: string | null;
    last_summary_at?: string | null;
  }>;

  // Root indices are materialized per visibility scope, but their contents are
  // cross-session for that audience: visible channel/thread conversations are
  // included; DMs are only included in their own DM root. Legacy numeric
  // per-user indices predate scoped keys and can mix unrelated/private data;
  // delete them instead of regenerating contaminated aggregates.
  for (const root of rootStore.list()) {
    if (!isScopedRootIndexKey(root.rootKey)) {
      rootStore.delete(root.rootKey);
    }
  }

  const staleRoots = rootStore.getStale().filter((r) => isScopedRootIndexKey(r.rootKey));
  const staleKeys = new Set(staleRoots.map((r) => r.rootKey));
  const scopeKeys = new Set(
    convRows
      .filter((r) => r.active === 1)
      .map((r) => rootKeyForSessionVisibility(r.session_key))
      .filter((key): key is string => Boolean(key)),
  );
  const rootsToRegenerate = new Set(
    [...staleKeys, ...scopeKeys].filter((key) => {
      const audience = usersForScopedRootKey(key, channelMembersMap);
      if (audience !== null && audience.length === 0) {
        rootStore.delete(key);
        return false;
      }
      return true;
    }),
  );

  if (rootsToRegenerate.size === 0) return;

  for (const rootKey of rootsToRegenerate) {
    if (!isScopedRootIndexKey(rootKey)) continue;
    const rootAudience = currentAudienceForRootKey(rootKey, channelMembersMap);
    if (rootAudience !== null && rootAudience.length === 0) {
      rootStore.delete(rootKey);
      continue;
    }
    // Root indices are a compact visibility-scoped navigation index. Include
    // visible channel/thread sessions for the current audience, but keep threads
    // as independent nested sessions and never fold their messages into parent
    // channel counts.
    const visibleConvs = convRows
      .filter((r) => {
        if (!minCreatedAt || !r.created_at) return true;
        return new Date(r.created_at).getTime() <= minCreatedAt.getTime();
      })
      .filter((r) => !isConversationStaleForRootIndex(r, archiveCutoff))
      .map((r) => ({
        sessionKey: r.session_key,
        conversationId: r.conversation_id,
        title: r.title ?? undefined,
        lastActivity: latestDate(r.last_message_at, r.last_summary_at, r.updated_at, r.created_at),
        isRootSession: isConversationInRootScope(r.session_key, rootKey),
      }))
      .filter((r) => rootCanIndexConversation(
        r.sessionKey,
        rootKey,
        rootAudience === null ? null : new Set(rootAudience),
        channelMembersMap,
        channelMembershipInfo,
        visibilityConfig.rules,
        visibilityConfig.defaultPolicy,
      ));

    // Build overviews for each visible conversation
    const overviews: ConversationOverview[] = [];

    for (const conv of visibleConvs) {
      const frontierRows = db
        .prepare(
          `SELECT s.summary_id, s.content, s.depth, s.earliest_at, s.latest_at, ci.ordinal
           FROM context_items ci
           JOIN summaries s ON s.summary_id = ci.summary_id
           WHERE ci.conversation_id = ? AND ci.item_type = 'summary'
           ORDER BY ci.ordinal ASC`,
        )
        .all(conv.conversationId) as SummaryIndexRow[];

      const allSummaryRows = db
        .prepare(
          `SELECT summary_id, content, depth, earliest_at, latest_at, created_at
           FROM summaries
           WHERE conversation_id = ?${hasSummaryStaleColumn ? " AND COALESCE(stale, 0) = 0" : ""}
           ORDER BY created_at ASC`,
        )
        .all(conv.conversationId) as SummaryIndexRow[];

      const selectedSummary = chooseRootIndexSummary({
        frontierRows,
        allRows: allSummaryRows,
      });
      const sessionRoot = options.sessionRootSummaryStore?.get(conv.conversationId);
      const usableSessionRoot = sessionRoot && !sessionRoot.stale && sessionRoot.content.trim()
        ? sessionRoot
        : null;
      const selectedSummaryContent = selectedSummary.rows.map((row) => row.content).join("\n\n");

      const msgCount = db
        .prepare("SELECT COUNT(*) as cnt FROM messages WHERE conversation_id = ?")
        .get(conv.conversationId) as Record<string, unknown> | undefined;
      const messageCount = (msgCount?.cnt as number) ?? 0;

      // Fresh/empty lifecycle rows have neither raw messages nor summaries.
      // They are useful as transient active placeholders, but a root index is a
      // navigation surface: listing empty rows creates ghost sources and noisy
      // sourceConversationIds without adding recallable context.
      if (!usableSessionRoot && selectedSummary.rows.length === 0 && messageCount === 0) {
        continue;
      }

      overviews.push({
        conversationId: conv.conversationId,
        sessionKey: conv.sessionKey,
        title: conv.title ?? undefined,
        isRootSession: conv.isRootSession,
        deepestSummary: usableSessionRoot
          ? {
              summaryId: `session-root:${conv.conversationId}`,
              content: usableSessionRoot.content,
              depth: Math.max(0, selectedSummary.rows.length > 0
                ? Math.max(...selectedSummary.rows.map((row) => row.depth))
                : 0),
              earliestAt: selectedSummary.rows[0]?.earliest_at
                ? new Date(selectedSummary.rows[0].earliest_at)
                : null,
              latestAt: selectedSummary.rows[selectedSummary.rows.length - 1]?.latest_at
                ? new Date(selectedSummary.rows[selectedSummary.rows.length - 1]!.latest_at as string)
                : usableSessionRoot.updatedAt,
            }
          : selectedSummary.rows.length > 0
          ? {
              summaryId: selectedSummary.rows.map((row) => row.summary_id).join(","),
              content: selectedSummaryContent,
              depth: Math.max(...selectedSummary.rows.map((row) => row.depth)),
              earliestAt: selectedSummary.rows[0]?.earliest_at
                ? new Date(selectedSummary.rows[0].earliest_at)
                : null,
              latestAt: selectedSummary.rows[selectedSummary.rows.length - 1]?.latest_at
                ? new Date(selectedSummary.rows[selectedSummary.rows.length - 1]!.latest_at as string)
                : null,
            }
          : undefined,
        messageCount,
        lastActivity: conv.lastActivity,
        keywords: usableSessionRoot?.keywords.length
          ? usableSessionRoot.keywords
          : resolveRootIndexKeywords({
              db,
              conversationId: conv.conversationId,
              title: conv.title,
              selectedSummaryContent,
              summarizeKeywords: options.summarizeKeywords,
            }),
      });
    }

    const scopeLabel = `Visibility-Scope Memory Root Index (${rootKey})`;
    const activeSessionKeys = new Set(convRows.map((row) => row.session_key));
    const visibleWithoutLcm = visibleDiscordChannelsWithoutLcm({
      db,
      rootKey,
      rootAudience,
      activeSessionKeys,
      channelMembersMap,
      channelMembershipInfo,
    });
    const rawContent = buildRootSummaryText(
      overviews,
      new Date(),
      timezone,
      rootConfig.customInstructions ?? "",
      scopeLabel,
      visibleWithoutLcm,
      loadChannelNamesFromDB(db),
    );
    const maxChars = Math.max(1, maxTokens) * 4;
    const content = rawContent.length > maxChars
      ? rawContent.slice(0, Math.max(0, maxChars - 16)).trimEnd() + "\n...[truncated]"
      : rawContent;
    const tokenCount = Math.ceil(content.length / 4);

    rootStore.upsert({
      rootKey,
      content,
      tokenCount,
      sourceConversationIds: overviews.map((o) => o.conversationId),
    });
  }
}
