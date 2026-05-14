import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import manifest from "../openclaw.plugin.json" with { type: "json" };
import packageJson from "../package.json" with { type: "json" };
import lcmPlugin from "../index.js";
import type { OpenClawPluginApi } from "../src/openclaw-bridge.js";
import { closeLcmConnection } from "../src/db/connection.js";
import { clearAllSharedInit } from "../src/plugin/shared-init.js";
import { resetStartupBannerLogsForTests } from "../src/startup-banner-log.js";

type HookHandler = (event?: unknown, context?: unknown) => unknown;

function buildInstallSmokeApi(pluginConfig: Record<string, unknown>): {
  api: OpenClawPluginApi;
  hooks: Map<string, HookHandler[]>;
  dbPath: string;
  tempDir: string;
} {
  const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-plugin-smoke-"));
  const dbPath = join(tempDir, "lcm.db");
  const hooks = new Map<string, HookHandler[]>();

  const api = {
    id: "lossless-claw",
    name: "Lossless Context Management",
    source: tempDir,
    config: {},
    pluginConfig: {
      ...pluginConfig,
      databasePath: dbPath,
    },
    runtime: {
      subagent: {
        run: vi.fn(),
        waitForRun: vi.fn(),
        getSession: vi.fn(),
        deleteSession: vi.fn(),
      },
      config: {
        loadConfig: vi.fn(() => ({})),
      },
      logging: {
        getChildLogger: vi.fn(() => ({
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        })),
      },
      channel: {
        session: {
          resolveStorePath: vi.fn(() => join(tempDir, "missing-session-store.json")),
        },
      },
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    registerContextEngine: vi.fn(),
    registerTool: vi.fn(),
    registerHook: vi.fn(),
    registerHttpHandler: vi.fn(),
    registerHttpRoute: vi.fn(),
    registerChannel: vi.fn(),
    registerGatewayMethod: vi.fn(),
    registerCli: vi.fn(),
    registerService: vi.fn(),
    registerProvider: vi.fn(),
    registerCommand: vi.fn(),
    resolvePath: vi.fn(() => tempDir),
    on: vi.fn((hookName: string, handler: HookHandler) => {
      const existing = hooks.get(hookName) ?? [];
      existing.push(handler);
      hooks.set(hookName, existing);
    }),
  } as unknown as OpenClawPluginApi;

  return { api, hooks, dbPath, tempDir };
}

describe("plugin install smoke", () => {
  const tempDirs = new Set<string>();
  const dbPaths = new Set<string>();

  afterEach(async () => {
    for (const dbPath of dbPaths) {
      closeLcmConnection(dbPath);
    }
    dbPaths.clear();
    clearAllSharedInit();
    resetStartupBannerLogsForTests();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.clear();
  });

  it("keeps package entrypoints aligned with OpenClaw plugin installation", () => {
    expect(packageJson.main).toBe("dist/index.js");
    expect(packageJson.scripts.prepack).toBe("npm run build");
    expect(packageJson.files).toEqual(expect.arrayContaining([
      "dist/",
      "skills/",
      "openclaw.plugin.json",
      "docs/",
    ]));
    expect(packageJson.openclaw.extensions).toEqual(["./dist/index.js"]);
    expect(manifest.id).toBe("lossless-claw");
    expect(manifest.kind).toBe("context-engine");
    expect(manifest.configSchema.properties.visibility.properties.channelMembers).toBeDefined();
    expect(manifest.configSchema.properties.visibility.properties.enabled.default).toBe(true);
    expect(manifest.configSchema.properties.rootSummary).toBeDefined();
    expect(manifest.configSchema.properties.rootSummary.properties.enabled.default).toBe(true);
    expect(manifest.configSchema.properties.nightlyCompaction).toBeDefined();
    expect(manifest.configSchema.properties.nightlyCompaction.properties.enabled.default).toBe(true);
    expect(manifest.configSchema.properties.nightlyCompaction.properties.forceFreshTail.default).toBe(true);
  });

  it("registers the packaged plugin surface with multi-session config enabled", async () => {
    const { api, hooks, dbPath, tempDir } = buildInstallSmokeApi({
      enabled: true,
      visibility: {
        enabled: true,
        defaultPolicy: "owner-only",
        userIdSource: "sender-id",
        channelMembers: {
          "100000000000000010": ["100000000000000001"],
        },
      },
      rootSummary: {
        enabled: true,
        maxTokens: 2000,
        minAgeMinutes: 0,
      },
      nightlyCompaction: {
        enabled: true,
        hour: 4,
        forceFreshTail: true,
      },
    });
    tempDirs.add(tempDir);
    dbPaths.add(dbPath);

    lcmPlugin.register(api);

    expect(api.registerContextEngine).toHaveBeenCalledWith("lossless-claw", expect.any(Function));
    expect(api.registerTool).toHaveBeenCalledTimes(4);
    expect(api.registerCommand).toHaveBeenCalledWith(expect.objectContaining({ name: "lcm" }));
    expect(hooks.has("before_prompt_build")).toBe(true);
    expect(hooks.has("session_end")).toBe(true);
    expect(hooks.has("gateway_start")).toBe(true);
    expect(hooks.has("gateway_stop")).toBe(true);

    const engineFactory = vi.mocked(api.registerContextEngine).mock.calls[0]?.[1];
    expect(engineFactory).toBeTypeOf("function");
    const engine = await engineFactory?.();
    expect(engine).toMatchObject({
      info: expect.objectContaining({ id: "lossless-claw" }),
      config: expect.objectContaining({
        databasePath: dbPath,
        visibility: expect.objectContaining({
          enabled: true,
          defaultPolicy: "owner-only",
          userIdSource: "sender-id",
          channelMembers: {
            "100000000000000010": ["100000000000000001"],
          },
        }),
        rootSummary: expect.objectContaining({
          enabled: true,
          maxTokens: 2000,
        }),
        nightlyCompaction: expect.objectContaining({
          enabled: true,
          hour: 4,
          forceFreshTail: true,
        }),
      }),
    });
  });

  it("loads the built distribution bundle when present", async () => {
    const distEntry = join(process.cwd(), "dist", "index.js");
    if (!existsSync(distEntry)) {
      expect(packageJson.scripts.prepack).toBe("npm run build");
      return;
    }

    const mod = await import(`${pathToFileURL(distEntry).href}?smoke=${Date.now()}`);
    expect(mod.default).toMatchObject({
      id: "lossless-claw",
      register: expect.any(Function),
    });
  });
});
