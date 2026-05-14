import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveLcmConfig } from "../src/db/config.js";
import { closeLcmConnection, createLcmDatabaseConnection } from "../src/db/connection.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { LcmContextEngine } from "../src/engine.js";
import { resetStartupBannerLogsForTests } from "../src/startup-banner-log.js";
import type { LcmDependencies } from "../src/types.js";

const tempDirs: string[] = [];

afterEach(() => {
  resetStartupBannerLogsForTests();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function parseAgentSessionKey(sessionKey: string): { agentId: string; suffix: string } | null {
  const parts = sessionKey.trim().split(":");
  if (parts[0] !== "agent" || parts.length < 3) {
    return null;
  }
  return {
    agentId: parts[1] ?? "main",
    suffix: parts.slice(2).join(":"),
  };
}

function createDeps(config: ReturnType<typeof resolveLcmConfig>, warn: ReturnType<typeof vi.fn>): LcmDependencies {
  return {
    config,
    complete: vi.fn(async () => ({ content: [{ type: "text", text: "summary output" }] })),
    callGateway: vi.fn(async () => ({})),
    resolveModel: vi.fn(() => ({ provider: "anthropic", model: "claude-opus-4-5" })),
    getApiKey: vi.fn(async () => "test-api-key"),
    requireApiKey: vi.fn(async () => "test-api-key"),
    parseAgentSessionKey,
    isSubagentSessionKey: (sessionKey: string) => sessionKey.includes(":subagent:"),
    normalizeAgentId: (id?: string) => (id?.trim() ? id : "main"),
    buildSubagentSystemPrompt: () => "subagent prompt",
    readLatestAssistantReply: () => undefined,
    resolveAgentDir: () => tmpdir(),
    resolveSessionIdFromSessionKey: async () => undefined,
    resolveSessionTranscriptFile: async () => undefined,
    agentLaneSubagent: "subagent",
    log: {
      info: vi.fn(),
      warn,
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
}

describe("visibility startup diagnostics", () => {
  it("warns when default-on multi-session visibility has channel sessions but no membership data", () => {
    resetStartupBannerLogsForTests();
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-visibility-diagnostic-"));
    tempDirs.push(tempDir);
    const config = resolveLcmConfig({}, {
      databasePath: join(tempDir, "lcm.db"),
      largeFilesDir: join(tempDir, "lcm-files"),
    });
    const db = createLcmDatabaseConnection(config.databasePath);
    try {
      runLcmMigrations(db, { fts5Available: false });
      db.prepare("INSERT INTO conversations (session_id, session_key) VALUES (?, ?)").run(
        "channel-session",
        "agent:main:discord:channel:123456789",
      );

      const warn = vi.fn();
      new LcmContextEngine(createDeps(config, warn), db);

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("channel membership is unknown for 1/1 Discord channel/thread scope(s)"),
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("will fail closed until OpenClaw supplies channel_membership data"),
      );
    } finally {
      closeLcmConnection(db);
    }
  });

  it("does not warn when channel membership is configured", () => {
    resetStartupBannerLogsForTests();
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-visibility-diagnostic-"));
    tempDirs.push(tempDir);
    const config = resolveLcmConfig({}, {
      databasePath: join(tempDir, "lcm.db"),
      largeFilesDir: join(tempDir, "lcm-files"),
      visibility: {
        channelMembers: {
          "123456789": ["111111"],
        },
      },
    });
    const db = createLcmDatabaseConnection(config.databasePath);
    try {
      runLcmMigrations(db, { fts5Available: false });
      db.prepare("INSERT INTO conversations (session_id, session_key) VALUES (?, ?)").run(
        "channel-session",
        "agent:main:discord:channel:123456789",
      );

      const warn = vi.fn();
      new LcmContextEngine(createDeps(config, warn), db);

      expect(warn).not.toHaveBeenCalledWith(
        expect.stringContaining("channel membership is unknown"),
      );
    } finally {
      closeLcmConnection(db);
    }
  });
});
