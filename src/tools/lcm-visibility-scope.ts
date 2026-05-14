import { audienceForSessionKey, buildChannelMembersMap, isConversationVisible, isConversationVisibleToAudience, loadChannelMembersFromDB } from "../visibility.js";
import type { LcmContextEngine } from "../engine.js";
import type { LcmConfig } from "../db/config.js";
import type { LcmDependencies } from "../types.js";
import { resolveLcmConversationScope } from "./lcm-conversation-scope.js";

export type LcmVisibilityScope = {
  conversationId?: number;
  allConversations: boolean;
  allowedConversationIds?: number[];
  error?: string;
};

function normalizeConversationId(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : undefined;
}

export function resolveCurrentUserIdForVisibility(input: {
  sessionKey?: string;
  senderId?: string;
  userIdSource?: "session-key" | "sender-id";
  sessionUserIds?: Map<string, string>;
}): string | undefined {
  const sessionKey = input.sessionKey?.trim();
  if (sessionKey && input.sessionUserIds) {
    const mapped = input.sessionUserIds.get(sessionKey);
    if (mapped) return mapped;
  }
  if (sessionKey) {
    const dmMatch = sessionKey.match(/^agent:[^:]+:discord:direct:(\d+)$/);
    if (dmMatch) return dmMatch[1];
  }
  if ((input.userIdSource ?? "sender-id") === "sender-id") {
    return input.senderId;
  }
  return undefined;
}

export async function resolveVisibilityScopedConversations(input: {
  lcm: LcmContextEngine;
  deps: LcmDependencies;
  sessionId?: string;
  sessionKey?: string;
  params: Record<string, unknown>;
  senderId?: string;
  getSessionUserIds?: () => Map<string, string> | undefined;
}): Promise<LcmVisibilityScope> {
  const conversationScope = await resolveLcmConversationScope({
    lcm: input.lcm,
    deps: input.deps,
    sessionId: input.sessionId,
    sessionKey: input.sessionKey,
    params: input.params,
  });

  const lcmConfig = (input.lcm as any).config as LcmConfig | undefined;
  if (!lcmConfig?.visibility?.enabled) {
    return {
      conversationId: conversationScope.conversationId,
      allConversations: conversationScope.allConversations,
      allowedConversationIds:
        !conversationScope.allConversations && typeof conversationScope.conversationId === "number"
          ? [conversationScope.conversationId]
          : undefined,
    };
  }

  const db = (input.lcm as any).db as import("node:sqlite").DatabaseSync | undefined;
  if (!db) {
    return {
      conversationId: conversationScope.conversationId,
      allConversations: conversationScope.allConversations,
      allowedConversationIds: [],
      error: "Visibility is enabled, but the LCM database is unavailable. Refusing cross-conversation lookup.",
    };
  }

  const currentUserId = resolveCurrentUserIdForVisibility({
    sessionKey: input.sessionKey,
    senderId: input.senderId,
    userIdSource: lcmConfig.visibility.userIdSource,
    sessionUserIds: input.getSessionUserIds?.(),
  });
  if (!currentUserId) {
    return {
      conversationId: conversationScope.conversationId,
      allConversations: conversationScope.allConversations,
      allowedConversationIds: [],
      error: "Visibility is enabled, but the current user could not be resolved. Refusing cross-conversation lookup.",
    };
  }

  const channelMembers = buildChannelMembersMap(
    loadChannelMembersFromDB(db),
    lcmConfig.visibility.channelMembers,
  );
  const currentAudience = input.sessionKey
    ? audienceForSessionKey(
        input.sessionKey,
        lcmConfig.visibility.rules ?? [],
        lcmConfig.visibility.defaultPolicy ?? "owner-only",
        channelMembers,
      )
    : undefined;
  if (input.sessionKey && currentAudience === undefined) {
    return {
      conversationId: conversationScope.conversationId,
      allConversations: conversationScope.allConversations,
      allowedConversationIds: [],
      error: "Visibility is enabled, but the current channel/thread audience could not be resolved. Refusing cross-conversation lookup.",
    };
  }
  const rows = db
    .prepare("SELECT conversation_id, session_key FROM conversations WHERE session_key IS NOT NULL")
    .all() as Array<{ conversation_id: number; session_key: string }>;
  const allowedConversationIds = rows
    .filter((row) => {
      if (currentAudience !== undefined) {
        return isConversationVisibleToAudience(
          row.session_key,
          currentAudience,
          lcmConfig.visibility.rules ?? [],
          lcmConfig.visibility.defaultPolicy ?? "owner-only",
          channelMembers,
        );
      }
      return isConversationVisible(
        row.session_key,
        currentUserId,
        lcmConfig.visibility.rules ?? [],
        lcmConfig.visibility.defaultPolicy ?? "owner-only",
        channelMembers,
      );
    })
    .map((row) => row.conversation_id);

  if (!conversationScope.allConversations) {
    const conversationId =
      conversationScope.conversationId ?? normalizeConversationId(input.params.conversationId);
    return {
      conversationId,
      allConversations: false,
      allowedConversationIds:
        typeof conversationId === "number" && allowedConversationIds.includes(conversationId)
          ? [conversationId]
          : [],
    };
  }

  return {
    allConversations: true,
    allowedConversationIds,
  };
}
