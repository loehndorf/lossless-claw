import type { LcmContextEngine } from "../engine.js";
import type { LcmDependencies } from "../types.js";

export type LcmConversationScope = {
  conversationId?: number;
  allConversations: boolean;
};

type ConversationScopeStore = ReturnType<LcmContextEngine["getConversationStore"]> & {
  getConversationForSession?: (input: {
    sessionId?: string;
    sessionKey?: string;
  }) => Promise<{ conversationId: number } | null>;
  getConversationBySessionKey?: (sessionKey: string) => Promise<{ conversationId: number } | null>;
};

function resolveToolScopeSessionKey(input: {
  lcm: LcmContextEngine;
  sessionKey?: string;
}): {
  originalSessionKey?: string;
  lookupSessionKey?: string;
  canonicalized: boolean;
} {
  const originalSessionKey = input.sessionKey?.trim();
  if (!originalSessionKey) {
    return { canonicalized: false };
  }

  const lookupSessionKey =
    input.lcm.resolveCanonicalSessionKeyForLookup(originalSessionKey)?.trim() || originalSessionKey;
  return {
    originalSessionKey,
    lookupSessionKey,
    canonicalized: lookupSessionKey !== originalSessionKey,
  };
}

async function lookupConversationForSession(input: {
  lcm: LcmContextEngine;
  sessionId?: string;
  sessionKey?: string;
}): Promise<{ conversationId: number } | null> {
  const store = input.lcm.getConversationStore() as ConversationScopeStore;
  const scopeKey = resolveToolScopeSessionKey({
    lcm: input.lcm,
    sessionKey: input.sessionKey,
  });

  if (scopeKey.lookupSessionKey && typeof store.getConversationBySessionKey === "function") {
    const byKey = await store.getConversationBySessionKey(scopeKey.lookupSessionKey);
    if (byKey) {
      return byKey;
    }
  }

  if (scopeKey.canonicalized) {
    return null;
  }

  if (typeof store.getConversationForSession === "function") {
    return store.getConversationForSession({
      sessionId: input.sessionId,
      sessionKey: scopeKey.lookupSessionKey,
    });
  }

  const normalizedSessionId = input.sessionId?.trim();
  if (!normalizedSessionId) {
    return null;
  }

  return store.getConversationBySessionId(normalizedSessionId);
}

/**
 * Parse an ISO-8601 timestamp tool parameter into a Date.
 *
 * Throws when the value is not a parseable timestamp string.
 */
export function parseIsoTimestampParam(
  params: Record<string, unknown>,
  key: string,
): Date | undefined {
  const raw = params[key];
  if (typeof raw !== "string") {
    return undefined;
  }
  const value = raw.trim();
  if (!value) {
    return undefined;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${key} must be a valid ISO timestamp.`);
  }
  return parsed;
}

/**
 * Resolve LCM conversation scope for tool calls.
 *
 * Priority:
 * 1. Explicit conversationId parameter
 * 2. allConversations=true (cross-conversation mode)
 * 3. Current session's LCM conversation
 */
export async function resolveLcmConversationScope(input: {
  lcm: LcmContextEngine;
  params: Record<string, unknown>;
  sessionId?: string;
  sessionKey?: string;
  deps?: Pick<LcmDependencies, "resolveSessionIdFromSessionKey">;
}): Promise<LcmConversationScope> {
  const { lcm, params } = input;

  const explicitConversationId =
    typeof params.conversationId === "number" && Number.isFinite(params.conversationId)
      ? Math.trunc(params.conversationId)
      : undefined;
  if (explicitConversationId != null) {
    return { conversationId: explicitConversationId, allConversations: false };
  }

  if (params.allConversations === true) {
    return { conversationId: undefined, allConversations: true };
  }

  const scopeKey = resolveToolScopeSessionKey({
    lcm,
    sessionKey: input.sessionKey,
  });
  if (scopeKey.lookupSessionKey) {
    const bySessionKey =
      await lcm.getConversationStore().getConversationBySessionKey(scopeKey.lookupSessionKey);
    if (bySessionKey) {
      return { conversationId: bySessionKey.conversationId, allConversations: false };
    }
  }

  let normalizedSessionId = input.sessionId?.trim();
  if (!normalizedSessionId && scopeKey.originalSessionKey && input.deps) {
    normalizedSessionId = await input.deps.resolveSessionIdFromSessionKey(scopeKey.originalSessionKey);
  }
  if (!normalizedSessionId && !scopeKey.originalSessionKey) {
    return { conversationId: undefined, allConversations: false };
  }

  if (scopeKey.canonicalized) {
    return { conversationId: undefined, allConversations: false };
  }

  const conversation = await lookupConversationForSession({
    lcm,
    sessionId: normalizedSessionId,
    // We already tried the exact sessionKey above. If that failed but we can
    // resolve the runtime session id, fall back by session id rather than
    // passing the non-matching raw channel key again. This keeps current-thread
    // tool calls working when OpenClaw's tool ctx only exposes the raw channel
    // key while LCM stores the topic-enhanced key.
    sessionKey: undefined,
  });
  if (!conversation) {
    return { conversationId: undefined, allConversations: false };
  }

  return { conversationId: conversation.conversationId, allConversations: false };
}
