import { join } from "node:path";
import { homedir } from "node:os";
import type { LcmContextEngine } from "./engine.js";
import { describeLogError } from "./lcm-log.js";
import type { DatabaseSync } from "node:sqlite";
import type { LcmConfig } from "./db/config.js";
import { ensureSessionRootSummary } from "./session-abstract.js";

export type NightlyCompactionLogger = {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
};

export type NightlyCompactionScheduler = {
  stop(): void;
};

export type NightlyCompactionResult = {
  total: number;
  compacted: number;
  summarized: number;
  keywords: number;
  errors: number;
};

type NightlyCompactionConfigSubset = Pick<LcmConfig, "summaryModel" | "summaryProvider" | "rootSummary" | "visibility" | "timezone"> & {
  nightlyCompaction?: { forceFreshTail?: boolean };
};

export function computeNextNightlyCompactAt(now: Date, hour: number): Date {
  const clampedHour = Math.min(23, Math.max(0, Math.trunc(hour)));
  const target = new Date(now);
  target.setHours(clampedHour, 0, 0, 0);
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  return target;
}

export function buildNightlyCompactionLegacyParams(config: Pick<LcmConfig, "summaryModel" | "summaryProvider">): Record<string, unknown> {
  const summaryModel = config.summaryModel || "deepseek/deepseek-v4-flash";
  const summaryProvider = config.summaryProvider || (summaryModel.includes("/") ? summaryModel.split("/")[0] : undefined);
  return {
    agentDir: join(homedir(), ".openclaw", "agents", "main"),
    model: summaryModel,
    ...(summaryProvider ? { provider: summaryProvider } : {}),
  };
}

export async function runNightlyCompaction(params: {
  engine: LcmContextEngine;
  config: NightlyCompactionConfigSubset;
  log: NightlyCompactionLogger;
  stopped?: () => boolean;
}): Promise<NightlyCompactionResult> {
  const conversationStore = params.engine.getConversationStore();
  const summaryStore = params.engine.getSummaryStore();
  const rootSummaryStore = params.engine.getRootSummaryStore();
  const sessionRootSummaryStore = params.engine.getSessionRootSummaryStore();
  const db = (params.engine as unknown as { db?: DatabaseSync }).db;
  if (!db) {
    params.log.warn("[lcm] nightly-compaction: cannot access DB");
    return { total: 0, compacted: 0, summarized: 0, keywords: 0, errors: 1 };
  }

  const rows = db.prepare("SELECT conversation_id FROM conversations WHERE active = 1").all();
  const convIds = rows.map((row) => Math.trunc(row.conversation_id as number));
  params.log.info(`[lcm] nightly-compaction: starting for ${convIds.length} conversations`);

  const legacyParams = buildNightlyCompactionLegacyParams(params.config);
  let compacted = 0;
  let summarized = 0;
  let keywords = 0;
  let errors = 0;

  for (const convId of convIds) {
    if (params.stopped?.()) break;
    try {
      const convInfo = await conversationStore.getConversation(convId);
      if (!convInfo) continue;
      const sessionKey = (convInfo as Record<string, unknown>).sessionKey as string | undefined;
      const result = await params.engine.compact({
        sessionId: `nightly-${convId}`,
        sessionKey: sessionKey || undefined,
        sessionFile: "",
        force: true,
        tokenBudget: 128000,
        legacyParams: {
          ...legacyParams,
          manualCompaction: false,
          compactionTrigger: "nightly",
        },
      });
      if (result.compacted) compacted++;
    } catch (error) {
      errors++;
      params.log.warn(`[lcm] nightly-compaction: error for conv ${convId}: ${describeLogError(error)}`);
    }
  }

  try {
    rootSummaryStore.markAllStale();
    if (params.config.rootSummary?.enabled && params.config.visibility?.enabled) {
      const { materializeRootIndexKeywordsForVisibleConversations, regenerateStaleRoots, rootKeyForSessionVisibility } = await import("./root-summary.js");
      const summarizer = await params.engine.resolveSummarize({
        legacyParams,
        breakerScope: "nightly-root-index-keywords",
      });
      for (const convId of convIds) {
        if (params.stopped?.()) break;
        try {
          const convInfo = await conversationStore.getConversation(convId);
          const sessionKey = convInfo?.sessionKey ?? undefined;
          if (!sessionKey || !rootKeyForSessionVisibility(sessionKey)) continue;
          const result = await ensureSessionRootSummary({
            db,
            conversationStore,
            summaryStore,
            sessionRootSummaryStore,
            conversationId: convId,
            summarize: summarizer.summarize,
            timezone: params.config.timezone ?? "UTC",
            targetTokens: Math.min(900, Math.max(160, Math.floor((params.config.rootSummary.maxTokens ?? 2000) / 8))),
            summaryModel: summarizer.summaryModel,
            trigger: "nightly-summary",
          });
          if (result.refreshed) summarized++;
        } catch (error) {
          errors++;
          params.log.warn(`[lcm] nightly-compaction: session root summary error for conv ${convId}: ${describeLogError(error)}`);
        }
      }
      keywords = await materializeRootIndexKeywordsForVisibleConversations({
        db,
        visibilityConfig: params.config.visibility,
        summarize: summarizer.summarize,
        sessionRootSummaryStore,
      });
      regenerateStaleRoots(
        rootSummaryStore,
        db,
        params.config.visibility,
        params.config.rootSummary,
        params.config.timezone ?? "UTC",
        { sessionRootSummaryStore },
      );
      params.log.info(`[lcm] nightly-compaction: root indices marked stale and regenerated; sessionRootSummariesRefreshed=${summarized} keywordSets=${keywords}`);
    } else {
      params.log.info("[lcm] nightly-compaction: root indices marked stale");
    }
  } catch (error) {
    params.log.warn(`[lcm] nightly-compaction: failed to refresh root indices: ${describeLogError(error)}`);
  }

  params.log.info(`[lcm] nightly-compaction: done. compacted=${compacted}, summarized=${summarized}, keywords=${keywords}, errors=${errors}, total=${convIds.length}`);
  return { total: convIds.length, compacted, summarized, keywords, errors };
}

export function startNightlyCompactionScheduler(params: {
  enabled: boolean;
  hour: number;
  waitForEngine: () => Promise<LcmContextEngine>;
  config: NightlyCompactionConfigSubset;
  log: NightlyCompactionLogger;
  isStopped?: () => boolean;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  now?: () => Date;
}): NightlyCompactionScheduler {
  const setTimer = params.setTimeoutFn ?? setTimeout;
  const clearTimer = params.clearTimeoutFn ?? clearTimeout;
  const now = params.now ?? (() => new Date());
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const isStopped = () => stopped || params.isStopped?.() === true;

  const scheduleNext = (): void => {
    if (isStopped() || !params.enabled) return;
    const target = computeNextNightlyCompactAt(now(), params.hour);
    const delayMs = target.getTime() - now().getTime();
    params.log.info(`[lcm] nightly-compaction: next run at ${target.toISOString()} (in ${Math.round(delayMs / 60000)}min)`);
    timer = setTimer(() => {
      void runOnce();
    }, delayMs);
    if (timer && typeof timer === "object" && "unref" in timer) {
      timer.unref();
    }
  };

  const runOnce = async (): Promise<void> => {
    if (isStopped() || !params.enabled) return;
    try {
      const engine = await params.waitForEngine();
      await runNightlyCompaction({
        engine,
        config: params.config,
        log: params.log,
        stopped: isStopped,
      });
    } catch (error) {
      params.log.error(`[lcm] nightly-compaction: fatal error: ${describeLogError(error)}`);
    }
    scheduleNext();
  };

  if (!params.enabled) {
    params.log.info("[lcm] nightly-compaction: disabled");
  } else {
    scheduleNext();
  }

  return {
    stop() {
      stopped = true;
      if (timer) {
        clearTimer(timer);
        timer = null;
      }
    },
  };
}
