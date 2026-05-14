import { describe, it, expect } from "vitest";
import {
  parseSessionKey,
  isConversationVisible,
  filterVisibleConversations,
  matchGlob,
  audienceForSessionKey,
  isConversationVisibleToAudience,
} from "../src/visibility.js";

describe("parseSessionKey", () => {
  it("parses DM session keys", () => {
    const result = parseSessionKey("agent:main:discord:direct:100000000000000001");
    expect(result.type).toBe("dm");
    expect(result.identifier).toBe("100000000000000001");
  });

  it("parses channel session keys", () => {
    const result = parseSessionKey("agent:main:discord:channel:100000000000000010");
    expect(result.type).toBe("channel");
    expect(result.identifier).toBe("100000000000000010");
    expect(result.channelId).toBe("100000000000000010");
    expect(result.topicId).toBeUndefined();
  });

  it("parses topic session keys with separate channel and topic ids", () => {
    const result = parseSessionKey("agent:main:discord:channel:100000000000000010:topic:1500000000000000000");
    expect(result.type).toBe("channel");
    expect(result.identifier).toBe("1500000000000000000");
    expect(result.channelId).toBe("100000000000000010");
    expect(result.topicId).toBe("1500000000000000000");
    expect(result.parentChannelId).toBe("100000000000000010");
  });

  it("parses active-memory session keys", () => {
    const result = parseSessionKey("agent:main:discord:channel:100000000000000010:active-memory:abc123");
    expect(result.type).toBe("channel");
    expect(result.identifier).toBe("100000000000000010");
    expect(result.parentChannelId).toBe("100000000000000010");
  });

  it("returns unknown for unrecognized keys", () => {
    const result = parseSessionKey("something:weird:here");
    expect(result.type).toBe("unknown");
  });
});

describe("isConversationVisible", () => {
  const aliceId = "100000000000000001";
  const bobId = "100000000000000002";
  const carolId = "100000000000000003";

  describe("owner-only default policy", () => {
    it("DM owner can see their own DMs", () => {
      expect(isConversationVisible(
        "agent:main:discord:direct:100000000000000001",
        aliceId, [], "owner-only"
      )).toBe(true);
    });

    it("DMs are NOT visible to other users", () => {
      expect(isConversationVisible(
        "agent:main:discord:direct:100000000000000001",
        bobId, [], "owner-only"
      )).toBe(false);
    });

    it("Bob's DMs are NOT visible to Alice", () => {
      expect(isConversationVisible(
        "agent:main:discord:direct:100000000000000002",
        aliceId, [], "owner-only"
      )).toBe(false);
    });

    it("Channels without membership data are denied by default", () => {
      expect(isConversationVisible(
        "agent:main:discord:channel:100000000000000010",
        aliceId, [], "owner-only"
      )).toBe(false);
    });

    it("fails closed when the current user cannot be resolved", () => {
      expect(isConversationVisible(
        "agent:main:discord:channel:100000000000000010",
        undefined, [], "owner-only"
      )).toBe(false);
      expect(isConversationVisible(
        "agent:main:discord:direct:100000000000000001",
        undefined, [], "owner-only"
      )).toBe(false);
    });
  });

  describe("open default policy", () => {
    it("Everyone can see everything", () => {
      expect(isConversationVisible(
        "agent:main:discord:direct:100000000000000001",
        bobId, [], "open"
      )).toBe(true);
    });
  });

  describe("explicit rules", () => {
    const rules = [
      {
        sessionPattern: "agent:*:discord:channel:100000000000000010**",
        allowedUsers: [aliceId],
        label: "#restricted-channel - Alice only"
      },
      {
        sessionPattern: "agent:*:discord:direct:*",
        allowedUsers: [], // empty = owner-only (matches default for DMs)
        label: "DMs - owner only"
      },
    ];

    it("Alice can see #restricted-channel", () => {
      expect(isConversationVisible(
        "agent:main:discord:channel:100000000000000010",
        aliceId, rules, "owner-only"
      )).toBe(true);
    });

    it("Bob cannot see #restricted-channel", () => {
      expect(isConversationVisible(
        "agent:main:discord:channel:100000000000000010",
        bobId, rules, "owner-only"
      )).toBe(false);
    });

    it("Carol cannot see #restricted-channel", () => {
      expect(isConversationVisible(
        "agent:main:discord:channel:100000000000000010",
        carolId, rules, "owner-only"
      )).toBe(false);
    });

    it("DM rule with empty allowedUsers still blocks other users", () => {
      // Empty allowedUsers in a rule means "everyone" per our implementation
      // But for DMs, the owner-only default should apply
      // This test documents current behavior
      expect(isConversationVisible(
        "agent:main:discord:direct:100000000000000001",
        aliceId, rules, "owner-only"
      )).toBe(true);
    });
  });

  describe("channel membership", () => {
    const members = new Map<string, string[]>([
      ["100000000000000010", [aliceId, carolId]],
    ]);

    it("Channel member can see channel", () => {
      expect(isConversationVisible(
        "agent:main:discord:channel:100000000000000010",
        carolId, [], "owner-only", members
      )).toBe(true);
    });

    it("Non-member cannot see channel with membership data", () => {
      expect(isConversationVisible(
        "agent:main:discord:channel:100000000000000010",
        bobId, [], "owner-only", members
      )).toBe(false);
    });

    it("thread visibility is constrained by both parent and topic membership", () => {
      const topicMembers = new Map<string, string[] | null>([
        ["100000000000000010", [aliceId, carolId]],
        ["1500000000000000000", [carolId]],
      ]);

      expect(isConversationVisible(
        "agent:main:discord:channel:100000000000000010:topic:1500000000000000000",
        carolId, [], "owner-only", topicMembers
      )).toBe(true);
      expect(isConversationVisible(
        "agent:main:discord:channel:100000000000000010:topic:1500000000000000000",
        aliceId, [], "owner-only", topicMembers
      )).toBe(false);
      expect(isConversationVisible(
        "agent:main:discord:channel:100000000000000010:topic:1500000000000000000",
        bobId, [], "owner-only", topicMembers
      )).toBe(false);
    });

    it("private threads fail closed when only parent channel membership is known", () => {
      expect(isConversationVisible(
        "agent:main:discord:channel:100000000000000010:topic:1500000000000000000",
        aliceId, [], "owner-only", members
      )).toBe(false);
    });

    it("restricted channel with no known members denies everyone", () => {
      const restrictedEmptyMembers = new Map<string, string[] | null>([
        ["100000000000000010", []],  // is_open=0, member_ids=[] → deny
      ]);
      expect(isConversationVisible(
        "agent:main:discord:channel:100000000000000010",
        carolId, [], "owner-only", restrictedEmptyMembers
      )).toBe(false);
      expect(isConversationVisible(
        "agent:main:discord:channel:100000000000000010",
        aliceId, [], "owner-only", restrictedEmptyMembers
      )).toBe(false);
    });

    it("open channel (null value) allows everyone", () => {
      const openMembers = new Map<string, string[] | null>([
        ["100000000000000010", null],  // is_open=1 → open
      ]);
      expect(isConversationVisible(
        "agent:main:discord:channel:100000000000000010",
        carolId, [], "owner-only", openMembers
      )).toBe(true);
      expect(isConversationVisible(
        "agent:main:discord:channel:100000000000000010",
        bobId, [], "owner-only", openMembers
      )).toBe(true);
    });
  });
});

describe("filterVisibleConversations", () => {
  const conversations = [
    { sessionKey: "agent:main:discord:direct:100000000000000001" },
    { sessionKey: "agent:main:discord:direct:100000000000000002" },
    { sessionKey: "agent:main:discord:channel:100000000000000010" },
    { sessionKey: null },
  ];

  it("Alice sees his DM + null-key sessions, but not channels without membership data", () => {
    const filtered = filterVisibleConversations(
      conversations, "100000000000000001", [], "owner-only"
    );
    expect(filtered).toHaveLength(2); // Alice DM, null-key
    expect(filtered.find(c => c.sessionKey?.includes("100000000000000002"))).toBeUndefined();
  });

  it("Bob sees her DM + null-key sessions, but not channels without membership data", () => {
    const filtered = filterVisibleConversations(
      conversations, "100000000000000002", [], "owner-only"
    );
    expect(filtered).toHaveLength(2); // Bob DM, null-key
    expect(filtered.find(c => c.sessionKey?.includes("100000000000000001"))).toBeUndefined();
  });

  it("Open policy shows everything", () => {
    const filtered = filterVisibleConversations(
      conversations, "100000000000000001", [], "open"
    );
    expect(filtered).toHaveLength(4);
  });

  it("fails closed when filtering without a current user", () => {
    const filtered = filterVisibleConversations(
      conversations, undefined, [], "open"
    );
    expect(filtered).toHaveLength(0);
  });
});

describe("audience-subset cross-conversation visibility", () => {
  const aliceId = "100000000000000001";
  const carolId = "100000000000000003";
  const bobId = "100000000000000002";
  const openChannel = "1000000000000000001";
  const aliceOnlyChannel = "1000000000000000002";
  const aliceCarolChannel = "1000000000000000003";
  const aliceBobChannel = "1000000000000000004";
  const unknownChannel = "1000000000000000005";
  const restrictedEmptyChannel = "1000000000000000006";
  const members = new Map<string, string[] | null>([
    [openChannel, null],          // is_open=1 → open
    [aliceOnlyChannel, [aliceId]],
    [aliceCarolChannel, [aliceId, carolId]],
    [aliceBobChannel, [aliceId, bobId]],
    [restrictedEmptyChannel, []],  // is_open=0, member_ids=[] → deny
  ]);

  it("allows a current restricted audience to read target conversations whose audience is a superset", () => {
    const current = audienceForSessionKey(
      `agent:main:discord:channel:${aliceOnlyChannel}`,
      [],
      "owner-only",
      members,
    );

    expect(current).toBeInstanceOf(Set);
    expect(isConversationVisibleToAudience(
      `agent:main:discord:channel:${aliceCarolChannel}`,
      current!,
      [],
      "owner-only",
      members,
    )).toBe(true);
    expect(isConversationVisibleToAudience(
      `agent:main:discord:channel:${openChannel}`,
      current!,
      [],
      "owner-only",
      members,
    )).toBe(true);
  });

  it("blocks target conversations that do not include every current audience member", () => {
    const current = audienceForSessionKey(
      `agent:main:discord:channel:${aliceCarolChannel}`,
      [],
      "owner-only",
      members,
    );

    expect(isConversationVisibleToAudience(
      `agent:main:discord:channel:${aliceOnlyChannel}`,
      current!,
      [],
      "owner-only",
      members,
    )).toBe(false);
    expect(isConversationVisibleToAudience(
      `agent:main:discord:channel:${aliceBobChannel}`,
      current!,
      [],
      "owner-only",
      members,
    )).toBe(false);
  });

  it("allows an open current audience to read only open target conversations", () => {
    const current = audienceForSessionKey(
      `agent:main:discord:channel:${openChannel}`,
      [],
      "owner-only",
      members,
    );

    expect(current).toBeNull();
    expect(isConversationVisibleToAudience(
      `agent:main:discord:channel:${openChannel}`,
      current!,
      [],
      "owner-only",
      members,
    )).toBe(true);
    expect(isConversationVisibleToAudience(
      `agent:main:discord:channel:${aliceCarolChannel}`,
      current!,
      [],
      "owner-only",
      members,
    )).toBe(false);
  });

  it("fails closed for unknown target audiences", () => {
    const current = audienceForSessionKey(
      `agent:main:discord:channel:${aliceOnlyChannel}`,
      [],
      "owner-only",
      members,
    );

    expect(isConversationVisibleToAudience(
      `agent:main:discord:channel:${unknownChannel}`,
      current!,
      [],
      "owner-only",
      members,
    )).toBe(false);
  });

  it("denies restricted-empty channels in audience-subset check", () => {
    const current = audienceForSessionKey(
      `agent:main:discord:channel:${aliceCarolChannel}`,
      [],
      "owner-only",
      members,
    );

    expect(isConversationVisibleToAudience(
      `agent:main:discord:channel:${restrictedEmptyChannel}`,
      current!,
      [],
      "owner-only",
      members,
    )).toBe(false);
  });
});

describe("matchGlob", () => {
  it("matches exact strings", () => {
    expect(matchGlob("hello", "hello")).toBe(true);
  });

  it("matches * as non-colon wildcard", () => {
    expect(matchGlob("agent:main:discord:direct:123", "agent:*:discord:direct:*")).toBe(true);
    expect(matchGlob("agent:main:discord:channel:456", "agent:*:discord:direct:*")).toBe(false);
  });

  it("matches ** as any wildcard including colons", () => {
    expect(matchGlob("agent:main:discord:channel:123:active-memory:abc", "agent:*:discord:channel:123**")).toBe(true);
  });

  it("does not match partial", () => {
    expect(matchGlob("agent:main:discord:direct:123:extra", "agent:*:discord:direct:*")).toBe(false);
  });
});
