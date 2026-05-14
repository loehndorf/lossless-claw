import type {
  ConversationStore,
  MessageRecord,
  MessageSearchResult,
} from "./store/conversation-store.js";
import type {
  SummaryStore,
  SummaryRecord,
  SummarySearchResult,
  LargeFileRecord,
} from "./store/summary-store.js";
import type { SearchSort } from "./store/full-text-sort.js";
import { estimateTokens } from "./estimate-tokens.js";
import type { VectorSearchConfig } from "./db/config.js";
import type { EmbeddingProvider } from "./embeddings.js";
import { EmbeddingStore } from "./embeddings.js";

// ── Public interfaces ────────────────────────────────────────────────────────

export interface DescribeResult {
  id: string;
  type: "summary" | "file";
  /** Summary-specific fields */
  summary?: {
    conversationId: number;
    kind: "leaf" | "condensed";
    content: string;
    depth: number;
    tokenCount: number;
    descendantCount: number;
    descendantTokenCount: number;
    sourceMessageTokenCount: number;
    fileIds: string[];
    parentIds: string[];
    childIds: string[];
    messageIds: number[];
    earliestAt: Date | null;
    latestAt: Date | null;
    subtree: Array<{
      summaryId: string;
      parentSummaryId: string | null;
      depthFromRoot: number;
      kind: "leaf" | "condensed";
      depth: number;
      tokenCount: number;
      descendantCount: number;
      descendantTokenCount: number;
      sourceMessageTokenCount: number;
      earliestAt: Date | null;
      latestAt: Date | null;
      childCount: number;
      path: string;
    }>;
    createdAt: Date;
  };
  /** File-specific fields */
  file?: {
    conversationId: number;
    fileName: string | null;
    mimeType: string | null;
    byteSize: number | null;
    storageUri: string;
    explorationSummary: string | null;
    createdAt: Date;
  };
}

export interface GrepInput {
  query: string;
  mode: "regex" | "full_text" | "semantic";
  scope: "messages" | "summaries" | "both";
  conversationId?: number;
  since?: Date;
  before?: Date;
  limit?: number;
  /** Sort order for results. Default "recency" (newest first).
   *  "relevance" sorts by FTS5 BM25 rank (full_text mode only).
   *  "hybrid" blends relevance with recency. */
  sort?: SearchSort;
  allowedConversationIds?: number[];
  includeDeletedScopes?: boolean;
}

export interface GrepResult {
  messages: MessageSearchResult[];
  summaries: SummarySearchResult[];
  totalMatches: number;
}

export interface ExpandInput {
  summaryId: string;
  /** Max traversal depth (default 1) */
  depth?: number;
  /** Include raw source messages at leaf level */
  includeMessages?: boolean;
  /** Max tokens to return before truncating */
  tokenCap?: number;
  /** Restrict expansion to this conversation. */
  conversationId?: number;
  /** Restrict expansion to this set of conversations. Empty means no access. */
  allowedConversationIds?: number[];
}

export interface ExpandResult {
  /** Child summaries found */
  children: Array<{
    summaryId: string;
    kind: "leaf" | "condensed";
    content: string;
    tokenCount: number;
  }>;
  /** Source messages (only if includeMessages=true and hitting leaf summaries) */
  messages: Array<{
    messageId: number;
    role: string;
    content: string;
    tokenCount: number;
  }>;
  /** Total estimated tokens in result */
  estimatedTokens: number;
  /** Whether result was truncated due to tokenCap */
  truncated: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────────────


// ── RetrievalEngine ──────────────────────────────────────────────────────────

export class RetrievalEngine {
  constructor(
    private conversationStore: ConversationStore,
    private summaryStore: SummaryStore,
    private vectorSearch?: {
      config: VectorSearchConfig;
      store: EmbeddingStore;
      provider: EmbeddingProvider;
    },
  ) {}

  // ── describe ─────────────────────────────────────────────────────────────

  /**
   * Describe an LCM item by ID.
   *
   * - IDs starting with "sum_" are looked up as summaries (with lineage).
   * - IDs starting with "file_" are looked up as large files.
   * - Returns null if the item is not found.
   */
  async describe(id: string, allowedConversationIds?: number[]): Promise<DescribeResult | null> {
    if (id.startsWith("sum_")) {
      return this.describeSummary(id, allowedConversationIds);
    }
    if (id.startsWith("file_")) {
      return this.describeFile(id, allowedConversationIds);
    }
    return null;
  }

  private isConversationAllowed(
    conversationId: number | null | undefined,
    allowedConversationIds?: number[],
  ): boolean {
    if (typeof conversationId !== "number") {
      return false;
    }
    if (!allowedConversationIds) {
      return true;
    }
    return allowedConversationIds.includes(conversationId);
  }

  private async describeSummary(id: string, allowedConversationIds?: number[]): Promise<DescribeResult | null> {
    const summary = await this.summaryStore.getSummary(id);
    if (!summary || !this.isConversationAllowed(summary.conversationId, allowedConversationIds)) {
      return null;
    }

    // Fetch lineage in parallel
    const [rawParents, rawChildren, messageIds, subtree] = await Promise.all([
      this.summaryStore.getSummaryParents(id),
      this.summaryStore.getSummaryChildren(id),
      this.summaryStore.getSummaryMessages(id),
      this.summaryStore.getSummarySubtree(id),
    ]);
    const parents = rawParents.filter((p) => this.isConversationAllowed(p.conversationId, allowedConversationIds));
    const children = rawChildren.filter((c) => this.isConversationAllowed(c.conversationId, allowedConversationIds));

    return {
      id,
      type: "summary",
      summary: {
        conversationId: summary.conversationId,
        kind: summary.kind,
        content: summary.content,
        depth: summary.depth,
        tokenCount: summary.tokenCount,
        descendantCount: summary.descendantCount,
        descendantTokenCount: summary.descendantTokenCount,
        sourceMessageTokenCount: summary.sourceMessageTokenCount,
        fileIds: summary.fileIds,
        parentIds: parents.map((p) => p.summaryId),
        childIds: children.map((c) => c.summaryId),
        messageIds,
        earliestAt: summary.earliestAt,
        latestAt: summary.latestAt,
        subtree: subtree
          .filter((node) => this.isConversationAllowed(node.conversationId, allowedConversationIds))
          .map((node) => ({
            summaryId: node.summaryId,
            parentSummaryId: node.parentSummaryId,
            depthFromRoot: node.depthFromRoot,
            kind: node.kind,
            depth: node.depth,
            tokenCount: node.tokenCount,
            descendantCount: node.descendantCount,
            descendantTokenCount: node.descendantTokenCount,
            sourceMessageTokenCount: node.sourceMessageTokenCount,
            earliestAt: node.earliestAt,
            latestAt: node.latestAt,
            childCount: node.childCount,
            path: node.path,
          })),
        createdAt: summary.createdAt,
      },
    };
  }

  private async describeFile(id: string, allowedConversationIds?: number[]): Promise<DescribeResult | null> {
    const file = await this.summaryStore.getLargeFile(id);
    if (!file || !this.isConversationAllowed(file.conversationId, allowedConversationIds)) {
      return null;
    }

    return {
      id,
      type: "file",
      file: {
        conversationId: file.conversationId,
        fileName: file.fileName,
        mimeType: file.mimeType,
        byteSize: file.byteSize,
        storageUri: file.storageUri,
        explorationSummary: file.explorationSummary,
        createdAt: file.createdAt,
      },
    };
  }

  // ── grep ─────────────────────────────────────────────────────────────────

  /**
   * Search compacted history using regex or full-text search.
   *
   * Depending on `scope`, searches messages, summaries, or both (in parallel).
   */
  async grep(input: GrepInput): Promise<GrepResult> {
    const { query, mode, scope, conversationId, since, before, limit, sort, allowedConversationIds, includeDeletedScopes } = input;

    if (mode === "semantic") {
      return this.semanticGrep({
        query,
        scope,
        conversationId,
        since,
        before,
        limit,
        allowedConversationIds,
        includeDeletedScopes,
      });
    }

    const searchInput = { query, mode, conversationId, since, before, limit, sort, allowedConversationIds, includeDeletedScopes };

    let messages: MessageSearchResult[] = [];
    let summaries: SummarySearchResult[] = [];

    if (scope === "messages") {
      messages = await this.conversationStore.searchMessages(searchInput);
    } else if (scope === "summaries") {
      summaries = await this.summaryStore.searchSummaries(searchInput);
    } else {
      // scope === "both" — run in parallel
      [messages, summaries] = await Promise.all([
        this.conversationStore.searchMessages(searchInput),
        this.summaryStore.searchSummaries(searchInput),
      ]);
    }

    return {
      messages,
      summaries,
      totalMatches: messages.length + summaries.length,
    };
  }

  private async semanticGrep(input: {
    query: string;
    scope: "messages" | "summaries" | "both";
    conversationId?: number;
    since?: Date;
    before?: Date;
    limit?: number;
    allowedConversationIds?: number[];
    includeDeletedScopes?: boolean;
  }): Promise<GrepResult> {
    if (!this.vectorSearch?.config.enabled || input.scope === "messages") {
      return { messages: [], summaries: [], totalMatches: 0 };
    }
    const config = this.vectorSearch.config;
    if (config.scope === "messages") {
      return { messages: [], summaries: [], totalMatches: 0 };
    }
    const [queryVector] = await this.vectorSearch.provider.embed([input.query]);
    if (!queryVector || queryVector.length === 0) {
      return { messages: [], summaries: [], totalMatches: 0 };
    }
    const model = this.vectorSearch.store.ensureModel(config, queryVector.length);
    const summaries = this.vectorSearch.store.searchSummaryEmbeddings({
      embeddingModelId: model.embeddingModelId,
      queryVector,
      limit: input.limit ?? config.maxCandidates,
      conversationId: input.conversationId,
      allowedConversationIds: input.allowedConversationIds,
      since: input.since,
      before: input.before,
    });
    return {
      messages: [],
      summaries,
      totalMatches: summaries.length,
    };
  }

  // ── expand ───────────────────────────────────────────────────────────────

  /**
   * Expand a summary to its children and/or source messages.
   *
   * - Condensed summaries: returns child summaries, recursing up to `depth`.
   * - Leaf summaries with `includeMessages`: fetches the source messages.
   * - Respects `tokenCap` and sets `truncated` when the cap is exceeded.
   */
  async expand(input: ExpandInput): Promise<ExpandResult> {
    const depth = input.depth ?? 1;
    const includeMessages = input.includeMessages ?? false;
    const tokenCap = input.tokenCap ?? Infinity;

    const result: ExpandResult = {
      children: [],
      messages: [],
      estimatedTokens: 0,
      truncated: false,
    };

    const allowedConversationIds = input.allowedConversationIds ??
      (typeof input.conversationId === "number" ? [input.conversationId] : undefined);

    await this.expandRecursive(input.summaryId, depth, includeMessages, tokenCap, result, allowedConversationIds);

    return result;
  }

  private async expandRecursive(
    summaryId: string,
    depth: number,
    includeMessages: boolean,
    tokenCap: number,
    result: ExpandResult,
    allowedConversationIds?: number[],
  ): Promise<void> {
    if (depth <= 0) {
      return;
    }
    if (result.truncated) {
      return;
    }

    const summary = await this.summaryStore.getSummary(summaryId);
    if (!summary || !this.isConversationAllowed(summary.conversationId, allowedConversationIds)) {
      return;
    }

    if (summary.kind === "condensed") {
      // IMPORTANT: a condensed summary is linked to the summaries that were
      // compacted into it via summary_parents(summary_id, parent_summary_id).
      // For expansion/replay we need to walk those source summaries, not newer
      // summaries that may later derive from this node.
      const children = await this.summaryStore.getSummaryParents(summaryId);

      for (const child of children) {
        if (result.truncated) {
          break;
        }

        if (!this.isConversationAllowed(child.conversationId, allowedConversationIds)) {
          continue;
        }

        // Check if adding this child would exceed the token cap
        if (result.estimatedTokens + child.tokenCount > tokenCap) {
          result.truncated = true;
          break;
        }

        result.children.push({
          summaryId: child.summaryId,
          kind: child.kind,
          content: child.content,
          tokenCount: child.tokenCount,
        });
        result.estimatedTokens += child.tokenCount;

        // Recurse into children if depth allows
        if (depth > 1) {
          await this.expandRecursive(child.summaryId, depth - 1, includeMessages, tokenCap, result, allowedConversationIds);
        }
      }
    } else if (summary.kind === "leaf" && includeMessages) {
      // Leaf summary — fetch source messages
      const messageIds = await this.summaryStore.getSummaryMessages(summaryId);

      for (const msgId of messageIds) {
        if (result.truncated) {
          break;
        }

        const msg = await this.conversationStore.getMessageById(msgId);
        if (!msg || !this.isConversationAllowed(msg.conversationId, allowedConversationIds)) {
          continue;
        }

        const tokenCount = msg.tokenCount || estimateTokens(msg.content);

        if (result.estimatedTokens + tokenCount > tokenCap) {
          result.truncated = true;
          break;
        }

        result.messages.push({
          messageId: msg.messageId,
          role: msg.role,
          content: msg.content,
          tokenCount,
        });
        result.estimatedTokens += tokenCount;
      }
    }
  }
}
