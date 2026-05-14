import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { estimateTokens, truncateTextToEstimatedTokens } from "./estimate-tokens.js";
import { extractFileIdsFromContent } from "./large-files.js";
import { formatTimestamp, type CompactionTriggerLabel } from "./compaction.js";
import type { ConversationStore } from "./store/conversation-store.js";
import type { SummaryStore } from "./store/summary-store.js";
import type { SessionRootSummaryStore } from "./store/session-root-summary-store.js";
import type { LcmSummarizeFn } from "./summarize.js";
import { materializeRootIndexKeywords } from "./root-summary.js";

function generateSessionAbstractSummaryId(conversationId: number, content: string): string {
  return (
    "sum_" +
    createHash("sha256")
      .update(`session-abstract:${conversationId}:${content}:${Date.now()}`)
      .digest("hex")
      .slice(0, 16)
  );
}

export async function ensureSessionAbstractSummary(params: {
  db: DatabaseSync;
  conversationStore: ConversationStore;
  summaryStore: SummaryStore;
  conversationId: number;
  summarize: LcmSummarizeFn;
  timezone: string;
  targetTokens: number;
  summaryModel?: string;
  trigger?: CompactionTriggerLabel;
}): Promise<{ summaryId?: string; created: boolean; reason?: string }> {
  const existing = params.db
    .prepare(
      `SELECT 1
       FROM summaries s
       WHERE s.conversation_id = ?
         AND s.kind = 'leaf'
         AND EXISTS (
           SELECT 1 FROM summary_messages sm WHERE sm.summary_id = s.summary_id
         )
       LIMIT 1`,
    )
    .get(params.conversationId) as unknown;
  if (existing) {
    return { created: false, reason: "summary already exists" };
  }

  const contextItems = await params.summaryStore.getContextItems(params.conversationId);
  const messageIds = contextItems
    .filter((item) => item.itemType === "message" && item.messageId != null)
    .map((item) => item.messageId!)
    .filter((id, index, arr) => arr.indexOf(id) === index);
  if (messageIds.length === 0) {
    return { created: false, reason: "no messages" };
  }

  const messages = [] as Array<{ messageId: number; content: string; createdAt: Date; tokenCount: number }>;
  for (const messageId of messageIds) {
    const msg = await params.conversationStore.getMessageById(messageId);
    if (!msg) continue;
    const text = typeof msg.content === "string" ? msg.content.trim() : "";
    if (!text) continue;
    messages.push({
      messageId: msg.messageId,
      content: text,
      createdAt: msg.createdAt,
      tokenCount: typeof msg.tokenCount === "number" && Number.isFinite(msg.tokenCount) && msg.tokenCount > 0
        ? Math.floor(msg.tokenCount)
        : estimateTokens(text),
    });
  }
  if (messages.length === 0) {
    return { created: false, reason: "no textual messages" };
  }

  const sourceText = messages
    .map((message) => `[${formatTimestamp(message.createdAt, params.timezone)}]\n${message.content}`)
    .join("\n\n");
  const maxSourceTokens = Math.max(1, params.targetTokens * 4);
  const clippedSourceText = sourceText.length > maxSourceTokens * 4
    ? `${sourceText.slice(0, maxSourceTokens * 4).trimEnd()}\n...[truncated for session abstract]`
    : sourceText;
  const prompt = `Create a concise session abstract for cross-session discovery.\n\nThis summary is an index/abstract only: do not imply the raw chat was compacted or removed. Capture why another session might want to inspect this conversation.\n\nReturn the summary with this exact heading: **Session Summary**\n\nConversation:\n${clippedSourceText}`;
  const content = (await params.summarize(prompt, false, {
    isCondensed: false,
    trigger: params.trigger ?? "nightly-summary",
  })).trim();
  if (!content) {
    return { created: false, reason: "empty summary" };
  }
  if (content.includes("Create a concise session abstract for cross-session discovery") || content.includes("Conversation:\n")) {
    return { created: false, reason: "summarizer returned prompt text" };
  }

  const normalizedContent = /^\*\*Session Summary\*\*/i.test(content) || /^Session Summary\b/i.test(content)
    ? content
    : `**Session Summary**\n\n${content}`;
  if (normalizedContent.includes("Create a concise session abstract for cross-session discovery") || normalizedContent.includes("Conversation:\n")) {
    return { created: false, reason: "summarizer returned prompt text" };
  }

  const summaryId = generateSessionAbstractSummaryId(params.conversationId, normalizedContent);
  const tokenCount = estimateTokens(normalizedContent);
  const fileIds = messages.flatMap((message) => extractFileIdsFromContent(message.content));
  const earliestAt = new Date(Math.min(...messages.map((message) => message.createdAt.getTime())));
  const latestAt = new Date(Math.max(...messages.map((message) => message.createdAt.getTime())));
  const sourceMessageTokenCount = messages.reduce((sum, message) => sum + message.tokenCount, 0);

  await params.summaryStore.withTransaction(async () => {
    await params.summaryStore.insertSummary({
      summaryId,
      conversationId: params.conversationId,
      kind: "leaf",
      depth: 0,
      content: normalizedContent,
      tokenCount,
      fileIds,
      earliestAt,
      latestAt,
      descendantCount: 0,
      descendantTokenCount: 0,
      sourceMessageTokenCount,
      model: params.summaryModel,
    });
    await params.summaryStore.linkSummaryToMessages(summaryId, messages.map((message) => message.messageId));
    await params.summaryStore.appendContextSummary(params.conversationId, summaryId);
  });

  return { summaryId, created: true };
}

type SessionRootSummarySource = {
  text: string;
  fingerprint: string;
  summaryIds: string[];
  messageIds: number[];
};

export async function ensureSessionRootSummary(params: {
  db: DatabaseSync;
  conversationStore: ConversationStore;
  summaryStore: SummaryStore;
  sessionRootSummaryStore: SessionRootSummaryStore;
  conversationId: number;
  summarize: LcmSummarizeFn;
  timezone: string;
  targetTokens: number;
  summaryModel?: string;
  trigger?: CompactionTriggerLabel;
}): Promise<{
  created: boolean;
  updated: boolean;
  refreshed: boolean;
  changed: boolean;
  reason?: string;
}> {
  const targetTokens = Math.max(80, Math.floor(params.targetTokens));
  const source = await buildSessionRootSummarySource({
    conversationStore: params.conversationStore,
    summaryStore: params.summaryStore,
    conversationId: params.conversationId,
    timezone: params.timezone,
    maxSourceTokens: Math.max(1200, Math.min(20_000, targetTokens * 10)),
  });
  if (!source) {
    return { created: false, updated: false, refreshed: false, changed: false, reason: "no textual frontier" };
  }

  const existing = params.sessionRootSummaryStore.get(params.conversationId);
  if (existing?.sourceFingerprint === source.fingerprint && !existing.stale) {
    return { created: false, updated: false, refreshed: false, changed: false, reason: "unchanged" };
  }
  if (existing?.sourceFingerprint === source.fingerprint && existing.stale) {
    params.sessionRootSummaryStore.upsert({
      conversationId: params.conversationId,
      content: existing.content,
      keywords: existing.keywords,
      tokenCount: existing.tokenCount,
      sourceFingerprint: existing.sourceFingerprint,
      sourceSummaryIds: existing.sourceSummaryIds,
      sourceMessageIds: existing.sourceMessageIds,
      model: existing.model,
    });
    return { created: false, updated: false, refreshed: true, changed: false, reason: "unchanged" };
  }

  const prompt = `Create a session root summary for cross-session lossless memory discovery.

This is a derived root summary only. Do not imply that raw chat history was deleted, compacted, or unavailable.
It must cover the current session frontier: compacted old context when present, plus unsummarized live tail messages.
Capture what another visible session should know this session is about, what durable facts or decisions it contains, and when to inspect it.

Return concise prose with this exact heading: **Root Summary**

Current frontier:
${source.text}`;
  const rawContent = (await params.summarize(prompt, false, { isCondensed: false })).trim();
  if (!rawContent) {
    return { created: false, updated: false, refreshed: false, changed: false, reason: "empty summary" };
  }
  if (rawContent.includes("Create a session root summary") || rawContent.includes("Current frontier:\n")) {
    return { created: false, updated: false, refreshed: false, changed: false, reason: "summarizer returned prompt text" };
  }

  const normalizedContent = /^\*\*Root Summary\*\*/i.test(rawContent) || /^Root Summary\b/i.test(rawContent)
    ? rawContent
    : `**Root Summary**\n\n${rawContent}`;
  const clippedContent = truncateTextToEstimatedTokens(normalizedContent, targetTokens);
  const content = clippedContent.length < normalizedContent.length
    ? `${clippedContent.trimEnd()}\n...[truncated]`
    : normalizedContent;
  if (content.includes("Create a session root summary") || content.includes("Current frontier:\n")) {
    return { created: false, updated: false, refreshed: false, changed: false, reason: "summarizer returned prompt text" };
  }

  const keywords = await materializeRootIndexKeywords({
    db: params.db,
    conversationId: params.conversationId,
    content,
    summarize: params.summarize,
    minKeywords: 4,
    maxKeywords: 10,
  });

  params.sessionRootSummaryStore.upsert({
    conversationId: params.conversationId,
    content,
    keywords,
    tokenCount: estimateTokens(content),
    sourceFingerprint: source.fingerprint,
    sourceSummaryIds: source.summaryIds,
    sourceMessageIds: source.messageIds,
    model: params.summaryModel,
  });

  return {
    created: !existing,
    updated: Boolean(existing),
    refreshed: true,
    changed: true,
  };
}

async function buildSessionRootSummarySource(params: {
  conversationStore: ConversationStore;
  summaryStore: SummaryStore;
  conversationId: number;
  timezone: string;
  maxSourceTokens: number;
}): Promise<SessionRootSummarySource | null> {
  const chunks: string[] = [];
  const messageIds: number[] = [];
  const summaryIds: string[] = [];
  const contextItems = await params.summaryStore.getContextItems(params.conversationId);

  for (const item of contextItems) {
    if (item.itemType === "summary" && item.summaryId) {
      const summary = await params.summaryStore.getSummary(item.summaryId);
      const content = summary?.content.trim();
      if (!summary || !content) continue;
      summaryIds.push(summary.summaryId);
      const range = formatSourceRange(summary.earliestAt, summary.latestAt, params.timezone);
      chunks.push(
        `[summary ${summary.summaryId} kind=${summary.kind} depth=${summary.depth} range=${range}]\n${content}`,
      );
      continue;
    }

    if (item.itemType === "message" && item.messageId != null) {
      const message = await params.conversationStore.getMessageById(item.messageId);
      const content = message?.content.trim();
      if (!message || !content) continue;
      messageIds.push(message.messageId);
      chunks.push(
        `[message ${message.messageId} seq=${message.seq} role=${message.role} at=${formatTimestamp(message.createdAt, params.timezone)}]\n${content}`,
      );
    }
  }

  if (chunks.length === 0) {
    const messages = await params.conversationStore.getMessages(params.conversationId);
    for (const message of messages) {
      const content = message.content.trim();
      if (!content) continue;
      messageIds.push(message.messageId);
      chunks.push(
        `[message ${message.messageId} seq=${message.seq} role=${message.role} at=${formatTimestamp(message.createdAt, params.timezone)}]\n${content}`,
      );
    }
  }

  if (chunks.length === 0) return null;

  const sourceText = chunks.join("\n\n");
  const clipped = truncateTextToEstimatedTokens(sourceText, params.maxSourceTokens);
  const text = clipped.length < sourceText.length
    ? `${clipped.trimEnd()}\n...[truncated for session root summary]`
    : sourceText;
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ messageIds, summaryIds }))
    .update("\0")
    .update(sourceText)
    .digest("hex");

  return {
    text,
    fingerprint,
    summaryIds: [...new Set(summaryIds)],
    messageIds: [...new Set(messageIds)],
  };
}

function formatSourceRange(earliestAt: Date | null, latestAt: Date | null, timezone: string): string {
  if (!earliestAt && !latestAt) return "unknown";
  if (!earliestAt) return `until ${formatTimestamp(latestAt!, timezone)}`;
  if (!latestAt) return `from ${formatTimestamp(earliestAt, timezone)}`;
  return `${formatTimestamp(earliestAt, timezone)}..${formatTimestamp(latestAt, timezone)}`;
}
