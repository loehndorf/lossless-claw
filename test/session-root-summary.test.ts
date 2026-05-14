import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { runLcmMigrations } from "../src/db/migration.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { SummaryStore } from "../src/store/summary-store.js";
import { SessionRootSummaryStore } from "../src/store/session-root-summary-store.js";
import { ensureSessionRootSummary } from "../src/session-abstract.js";
import type { LcmSummarizeFn } from "../src/summarize.js";

function createDb(): {
  db: DatabaseSync;
  conversationStore: ConversationStore;
  summaryStore: SummaryStore;
  sessionRootSummaryStore: SessionRootSummaryStore;
} {
  const db = new DatabaseSync(":memory:");
  runLcmMigrations(db, { fts5Available: false });
  return {
    db,
    conversationStore: new ConversationStore(db, { fts5Available: false }),
    summaryStore: new SummaryStore(db, { fts5Available: false }),
    sessionRootSummaryStore: new SessionRootSummaryStore(db),
  };
}

describe("session root summaries", () => {
  it("materializes a separate root summary for a short uncompacted session", async () => {
    const { db, conversationStore, summaryStore, sessionRootSummaryStore } = createDb();
    const conversation = await conversationStore.getOrCreateConversation("session-short", {
      sessionKey: "agent:main:discord:channel:123456789",
    });
    const message = await conversationStore.createMessage({
      conversationId: conversation.conversationId,
      seq: 1,
      role: "user",
      content: '{"sender_id":"111111"}\nNeed a plan for Tokyo rail passes, Kyoto lodging, and onsen etiquette.',
      tokenCount: 20,
    });
    await summaryStore.appendContextMessage(conversation.conversationId, message.messageId);

    const prompts: string[] = [];
    const summarize: LcmSummarizeFn = async (prompt) => {
      prompts.push(prompt);
      if (prompt.startsWith("Create a session root summary")) {
        expect(prompt).toContain("Tokyo rail passes");
        expect(prompt).toContain("unsummarized live tail");
        return "**Root Summary**\n\nThis session captures travel planning for Tokyo rail passes, Kyoto lodging, and onsen etiquette.";
      }
      return JSON.stringify([
        "tokyo-rail-passes",
        "kyoto-lodging",
        "onsen-etiquette",
        "travel-planning",
      ]);
    };

    const result = await ensureSessionRootSummary({
      db,
      conversationStore,
      summaryStore,
      sessionRootSummaryStore,
      conversationId: conversation.conversationId,
      summarize,
      timezone: "UTC",
      targetTokens: 200,
      summaryModel: "test-model",
      trigger: "nightly-summary",
    });

    expect(result).toMatchObject({ created: true, updated: false, refreshed: true, changed: true });
    const root = sessionRootSummaryStore.get(conversation.conversationId);
    expect(root?.content).toContain("Tokyo rail passes");
    expect(root?.keywords).toEqual([
      "tokyo-rail-passes",
      "kyoto-lodging",
      "onsen-etiquette",
      "travel-planning",
    ]);
    expect(root?.sourceMessageIds).toEqual([message.messageId]);
    expect(root?.sourceSummaryIds).toEqual([]);
    expect(root?.model).toBe("test-model");
    expect((db.prepare("SELECT COUNT(*) AS count FROM summaries").get() as any).count).toBe(0);

    const unchanged = await ensureSessionRootSummary({
      db,
      conversationStore,
      summaryStore,
      sessionRootSummaryStore,
      conversationId: conversation.conversationId,
      summarize,
      timezone: "UTC",
      targetTokens: 200,
      summaryModel: "test-model",
      trigger: "nightly-summary",
    });

    expect(unchanged).toMatchObject({ created: false, updated: false, refreshed: false, changed: false });
    expect(prompts.filter((prompt) => prompt.startsWith("Create a session root summary"))).toHaveLength(1);

    db.close();
  });
});
