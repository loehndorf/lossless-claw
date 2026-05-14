import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { getLcmDbFeatures } from "../src/db/features.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { ConversationStore } from "../src/store/conversation-store.js";

function createStoreFixture() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const { fts5Available } = getLcmDbFeatures(db);
  runLcmMigrations(db, { fts5Available });
  return {
    db,
    store: new ConversationStore(db, { fts5Available }),
  };
}

describe("ConversationStore source reconciliation", () => {
  it("stores and resolves provider message source identities", async () => {
    const { db, store } = createStoreFixture();

    try {
      const conversation = await store.createConversation({
        sessionId: "source-session",
        sessionKey: "agent:main:discord:channel:111:topic:222",
      });
      const first = await store.createMessage({
        conversationId: conversation.conversationId,
        seq: 1,
        role: "user",
        content: '{"message_id":"333"}\nhello',
        tokenCount: 3,
        source: {
          provider: "discord",
          channelId: "111",
          threadId: "222",
          messageId: "333",
        },
      });
      await store.createMessage({
        conversationId: conversation.conversationId,
        seq: 2,
        role: "assistant",
        content: "reply",
        tokenCount: 1,
      });

      const matches = await store.findMessagesBySource({
        provider: "discord",
        channelId: "111",
        threadId: "222",
        messageId: "333",
      });

      expect(matches.map((message) => message.messageId)).toEqual([first.messageId]);
      expect(matches[0]?.sourceMessageId).toBe("333");
      expect(matches[0]?.sourceProvider).toBe("discord");
      await expect(store.listMessagesAfterSeq(conversation.conversationId, 1)).resolves.toHaveLength(2);
    } finally {
      db.close();
    }
  });

  it("supports fallback content lookup and source-scope archiving", async () => {
    const { db, store } = createStoreFixture();

    try {
      const sourceConversation = await store.createConversation({
        sessionId: "source-session",
        sessionKey: "agent:main:discord:channel:111:topic:222",
      });
      const siblingConversation = await store.createConversation({
        sessionId: "sibling-session",
        sessionKey: "agent:main:discord:channel:111",
      });
      await store.createMessage({
        conversationId: sourceConversation.conversationId,
        seq: 1,
        role: "user",
        content: "metadata mentions message 444",
        tokenCount: 4,
        source: {
          provider: "discord",
          channelId: "111",
          threadId: "222",
          messageId: "444",
        },
      });
      await store.createMessage({
        conversationId: siblingConversation.conversationId,
        seq: 1,
        role: "user",
        content: "sibling",
        tokenCount: 1,
      });

      const contentMatches = await store.findMessagesContainingSourceMessageId({
        messageId: "444",
      });
      expect(contentMatches.map((message) => message.conversationId)).toEqual([
        sourceConversation.conversationId,
      ]);

      await store.recordSourceScopeDeletion({
        provider: "discord",
        channelId: "111",
        scopeType: "channel",
        reason: "test",
      });
      const affected = await store.listConversationIdsInSourceScope({
        provider: "discord",
        channelId: "111",
        scopeType: "channel",
      });

      expect(affected).toEqual([
        sourceConversation.conversationId,
        siblingConversation.conversationId,
      ]);
      await expect(store.archiveConversations(affected)).resolves.toBe(2);
      await expect(store.getConversation(sourceConversation.conversationId)).resolves.toMatchObject({
        active: false,
      });
    } finally {
      db.close();
    }
  });
});
