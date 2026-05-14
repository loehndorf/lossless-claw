import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { resolveLcmConfig } from "../src/db/config.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { computeNextNightlyCompactAt, runNightlyCompaction } from "../src/nightly-compaction.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { RootSummaryStore } from "../src/store/root-summary-store.js";
import { SessionRootSummaryStore } from "../src/store/session-root-summary-store.js";
import { SummaryStore } from "../src/store/summary-store.js";
import type { LcmContextEngine } from "../src/engine.js";

describe("nightly compaction scheduler", () => {
  it("clamps nightlyCompactHour to 0–23 in config", () => {
    const under = resolveLcmConfig({ LCM_NIGHTLY_COMPACT_HOUR: "-5" } as NodeJS.ProcessEnv, {});
    expect(under.nightlyCompactHour).toBe(0);

    const over = resolveLcmConfig({ LCM_NIGHTLY_COMPACT_HOUR: "99" } as NodeJS.ProcessEnv, {});
    expect(over.nightlyCompactHour).toBe(23);
  });

  it("defaults nightlyCompactHour to 4", () => {
    const config = resolveLcmConfig({}, {});
    expect(config.nightlyCompactHour).toBe(4);
  });

  it("uses config.summaryModel and config.summaryProvider instead of hardcoded values", () => {
    const config = resolveLcmConfig(
      {
        LCM_SUMMARY_MODEL: "openrouter/custom-model",
        LCM_SUMMARY_PROVIDER: "openrouter",
      } as NodeJS.ProcessEnv,
      {},
    );
    expect(config.summaryModel).toBe("openrouter/custom-model");
    expect(config.summaryProvider).toBe("openrouter");
  });

  it("falls back to deepseek/deepseek-v4-flash when no summaryModel is configured", () => {
    const config = resolveLcmConfig({}, {});
    const effectiveModel = config.summaryModel || "deepseek/deepseek-v4-flash";
    expect(effectiveModel).toBe("deepseek/deepseek-v4-flash");
  });

  it("computeNextNightlyCompactAt targets the configured local hour", () => {
    const hour = 4;
    const now = new Date("2026-05-03T14:00:00Z");
    const target = computeNextNightlyCompactAt(now, hour);
    expect(target.getDate()).toBe(now.getDate() + 1);
    expect(target.getHours()).toBe(4);

    const early = new Date("2026-05-03T00:00:00Z");
    const targetEarly = computeNextNightlyCompactAt(early, hour);
    expect(targetEarly.getDate()).toBe(early.getDate());
    expect(targetEarly.getHours()).toBe(4);
  });

  it("exposes nightlyCompaction and rootSummary user scope in plugin schema", () => {
    const plugin = JSON.parse(readFileSync("openclaw.plugin.json", "utf8"));
    expect(plugin.configSchema.properties.nightlyCompaction.properties.enabled).toMatchObject({
      type: "boolean",
    });
    expect(plugin.configSchema.properties.nightlyCompaction.properties.hour).toMatchObject({
      type: "integer",
      minimum: 0,
      maximum: 23,
    });
    expect(plugin.configSchema.properties.nightlyCompaction.properties.forceFreshTail).toMatchObject({
      type: "boolean",
    });
    expect(plugin.configSchema.properties.rootSummary.properties.scope.enum).toEqual(["user"]);
    expect(plugin.configSchema.properties.visibility.properties.channelMembers.additionalProperties.anyOf)
      .toEqual([
        { type: "array", items: { type: "string" } },
        { type: "null" },
      ]);
  });

  it("refreshes standalone session root summaries for short visible sessions", async () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });
    const conversationStore = new ConversationStore(db, { fts5Available: false });
    const summaryStore = new SummaryStore(db, { fts5Available: false });
    const rootSummaryStore = new RootSummaryStore(db);
    const sessionRootSummaryStore = new SessionRootSummaryStore(db);

    const conversation = await conversationStore.getOrCreateConversation("nightly-short", {
      sessionKey: "agent:main:discord:channel:123456789",
    });
    const message = await conversationStore.createMessage({
      conversationId: conversation.conversationId,
      seq: 1,
      role: "user",
      content: '{"sender_id":"111111"}\nShort session about Alpine permits and hut reservations.',
      tokenCount: 18,
    });
    await summaryStore.appendContextMessage(conversation.conversationId, message.messageId);

    const summarize = async (prompt: string): Promise<string> => {
      if (prompt.startsWith("Create a session root summary")) {
        return "**Root Summary**\n\nThis session tracks Alpine permit requirements and hut reservation constraints.";
      }
      return JSON.stringify(["alpine-permits", "hut-reservations"]);
    };
    const engine = {
      db,
      getConversationStore: () => conversationStore,
      getSummaryStore: () => summaryStore,
      getRootSummaryStore: () => rootSummaryStore,
      getSessionRootSummaryStore: () => sessionRootSummaryStore,
      compact: async () => ({ ok: true, compacted: false }),
      resolveSummarize: async () => ({ summarize, summaryModel: "test-model" }),
    } as unknown as LcmContextEngine;

    const warnings: string[] = [];
    const result = await runNightlyCompaction({
      engine,
      config: {
        summaryModel: "test-model",
        summaryProvider: "test",
        timezone: "UTC",
        rootSummary: {
          enabled: true,
          maxTokens: 2000,
          scope: "user",
          minAgeMinutes: 0,
        },
        visibility: {
          enabled: true,
          rules: [],
          defaultPolicy: "owner-only",
          channelMembers: {
            "123456789": ["111111"],
          },
        },
      },
      log: {
        info: () => {},
        warn: (message) => { warnings.push(message); },
        error: () => {},
      },
    });

    expect(result).toMatchObject({ total: 1, compacted: 0, summarized: 1, errors: 0 });
    expect(warnings).toEqual([]);
    expect(sessionRootSummaryStore.get(conversation.conversationId)?.keywords)
      .toEqual(["alpine-permits", "hut-reservations"]);
    expect((db.prepare("SELECT COUNT(*) AS count FROM summaries").get() as any).count).toBe(0);
    const roots = rootSummaryStore.list();
    expect(roots.map((root) => root.rootKey)).toContain("channel:123456789");
    expect(rootSummaryStore.get("channel:123456789")?.content).toContain("alpine-permits");

    db.close();
  });
});
