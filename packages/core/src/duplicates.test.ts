import { describe, expect, it } from "vitest";
import { findDuplicateGroups } from "./duplicates.js";
import { analysis, item } from "./test-helpers.js";

describe("findDuplicateGroups", () => {
  it("classifies fully identical items as exact while ignoring vault, time, tags and field order", () => {
    const groups = findDuplicateGroups([
      item({
        id: "vault-a:github-1",
        title: "GitHub",
        urls: ["https://github.com/login"],
        usernames: ["alice"],
        tags: ["current"],
        fieldCount: 2,
        hasPassword: true,
        analysis: analysis({
          notesValueHash: "same-notes",
          exactUrlKeys: ["https://github.com/login"],
          similarUrlKeys: ["https://github.com/login"],
          identityValues: ["alice"],
          fieldSignatures: ["password:h1", "username:alice"]
        })
      }),
      item({
        id: "vault-b:github-2",
        onePasswordItemId: "github-2",
        vaultId: "vault-b",
        vaultName: "Work",
        title: "GitHub",
        urls: ["https://www.github.com/login/"],
        usernames: ["alice"],
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:00.000Z",
        tags: ["imported"],
        fieldCount: 2,
        hasPassword: true,
        analysis: analysis({
          notesValueHash: "same-notes",
          exactUrlKeys: ["https://github.com/login"],
          similarUrlKeys: ["https://github.com/login"],
          identityValues: ["alice"],
          fieldSignatures: ["username:alice", "password:h1"]
        })
      })
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      candidateClass: "exact-duplicate",
      confidence: "high"
    });
    expect(groups[0].reasons.map((reason) => reason.rule)).toEqual(["item-fingerprint"]);
  });

  it("creates exact groups for non-login items when their content fingerprint matches", () => {
    const groups = findDuplicateGroups([
      item({
        id: "vault-a:note-1",
        title: "VPN Recovery",
        category: "secure-note",
        fieldCount: 1,
        hasNotes: true,
        analysis: analysis({
          notesValueHash: "vpn-notes",
          fieldSignatures: ["note:vpn"]
        })
      }),
      item({
        id: "vault-b:note-2",
        onePasswordItemId: "note-2",
        vaultId: "vault-b",
        vaultName: "Work",
        title: "VPN Recovery",
        category: "secure-note",
        fieldCount: 1,
        hasNotes: true,
        analysis: analysis({
          notesValueHash: "vpn-notes",
          fieldSignatures: ["note:vpn"]
        })
      })
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].candidateClass).toBe("exact-duplicate");
  });

  it("does not classify items as exact when title, notes, field count, field value, credential type or attachment presence differs", () => {
    const base = item({
      id: "vault-a:github-1",
      title: "GitHub",
      urls: ["https://github.com/login"],
      usernames: ["alice"],
      fieldCount: 2,
      hasPassword: true,
      analysis: analysis({
        notesValueHash: "notes",
        exactUrlKeys: ["https://github.com/login"],
        similarUrlKeys: ["https://github.com/login"],
        identityValues: ["alice"],
        fieldSignatures: ["username:alice", "password:h1"]
      })
    });

    const differingItems = [
      { title: "GitHub Copy" },
      { analysis: analysis({ ...base.analysis, notesValueHash: "notes " }) },
      { category: "secure-note" },
      { fieldCount: 3 },
      { analysis: analysis({ ...base.analysis, fieldSignatures: ["username:alice", "password:h2"] }) },
      { hasTotp: true },
      { hasAttachments: true }
    ].map((overrides, index) => item({
      ...base,
      id: `vault-b:github-${index + 2}`,
      onePasswordItemId: `github-${index + 2}`,
      vaultId: "vault-b",
      vaultName: "Work",
      ...overrides
    }));

    for (const candidate of differingItems) {
      const groups = findDuplicateGroups([base, candidate]);
      expect(groups[0]?.candidateClass).not.toBe("exact-duplicate");
    }
  });

  it("keeps strict URL query variants out of exact groups but allows them as similar login groups", () => {
    const groups = findDuplicateGroups([
      item({
        id: "vault-a:leetcode-root",
        title: "leetcode-cn.com",
        urls: ["https://leetcode-cn.com/"],
        usernames: ["18194005505"],
        comparableFields: [{ label: "password", kind: "secret", normalizedValueHash: "same-secret" }],
        analysis: analysis({
          exactUrlKeys: ["https://leetcode-cn.com/"],
          similarUrlKeys: ["https://leetcode-cn.com/"],
          identityValues: ["18194005505"],
          fieldSignatures: ["password:same-secret"]
        })
      }),
      item({
        id: "vault-b:leetcode-query",
        onePasswordItemId: "leetcode-query",
        vaultId: "vault-b",
        vaultName: "Work",
        title: "leetcode-cn.com",
        urls: ["https://leetcode-cn.com/?utm_source=LCUS"],
        usernames: ["18194005505"],
        comparableFields: [{ label: "password", kind: "secret", normalizedValueHash: "same-secret" }],
        analysis: analysis({
          exactUrlKeys: ["https://leetcode-cn.com/?utm_source=LCUS"],
          similarUrlKeys: ["https://leetcode-cn.com/"],
          identityValues: ["18194005505"],
          fieldSignatures: ["password:same-secret"]
        })
      })
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].candidateClass).toBe("similar-login");
  });

  it("groups similar login items by similar URL and any identical identity without comparing credential hashes", () => {
    const groups = findDuplicateGroups([
      item({
        id: "vault-a:github-1",
        title: "GitHub",
        urls: ["https://github.com/login?from=old"],
        usernames: ["alice@example.com"],
        comparableFields: [{ label: "password", kind: "secret", normalizedValueHash: "old-secret" }],
        analysis: analysis({
          exactUrlKeys: ["https://github.com/login?from=old"],
          similarUrlKeys: ["https://github.com/login"],
          identityValues: ["alice@example.com"],
          fieldSignatures: ["password:old-secret"]
        })
      }),
      item({
        id: "vault-b:github-2",
        onePasswordItemId: "github-2",
        vaultId: "vault-b",
        vaultName: "Work",
        title: "GitHub work",
        urls: ["github.com/login?from=new#frag"],
        usernames: ["alice"],
        comparableFields: [
          { label: "email", kind: "email", normalizedValue: "alice@example.com" },
          { label: "password", kind: "secret", normalizedValueHash: "new-secret" }
        ],
        analysis: analysis({
          exactUrlKeys: ["https://github.com/login?from=new#frag"],
          similarUrlKeys: ["https://github.com/login"],
          identityValues: ["alice", "alice@example.com"],
          fieldSignatures: ["email:alice@example.com", "password:new-secret"]
        })
      })
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      candidateClass: "similar-login",
      confidence: "high"
    });
    expect(groups[0].reasons[0]).toMatchObject({
      rule: "username-url",
      label: "相似 URL + 身份相同：alice@example.com@https://github.com/login"
    });
  });

  it("attaches a credential-bearing login without identity to one established similar group by matching title", () => {
    const groups = findDuplicateGroups([
      item({
        id: "vault-a:gitkraken-account",
        title: "account.gitkraken.com (user@example.com)",
        urls: ["https://account.gitkraken.com/"],
        usernames: ["user@example.com"],
        hasPassword: true,
        analysis: analysis({
          similarUrlKeys: ["https://account.gitkraken.com/"],
          identityValues: ["user@example.com"]
        })
      }),
      item({
        id: "vault-b:gitkraken-login",
        title: "GitKraken",
        urls: ["https://account.gitkraken.com"],
        usernames: ["user@example.com"],
        hasPassword: true,
        analysis: analysis({
          similarUrlKeys: ["https://account.gitkraken.com/"],
          identityValues: ["user@example.com"]
        })
      }),
      item({
        id: "vault-c:gitkraken-passkey",
        title: "GitKraken",
        urls: ["https://gitkraken.dev/login/oauth?code=one-time-code"],
        usernames: [],
        hasPasskey: true,
        analysis: analysis({
          similarUrlKeys: ["https://gitkraken.dev/login/oauth"],
          identityValues: []
        })
      })
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      candidateClass: "similar-login",
      confidence: "medium",
      itemIds: expect.arrayContaining([
        "vault-a:gitkraken-account",
        "vault-b:gitkraken-login",
        "vault-c:gitkraken-passkey"
      ])
    });
    expect(groups[0].reasons).toEqual(expect.arrayContaining([
      expect.objectContaining({
        rule: "title",
        itemIds: expect.arrayContaining(["vault-b:gitkraken-login", "vault-c:gitkraken-passkey"])
      })
    ]));
  });

  it("does not attach an identityless login when the same weak evidence matches multiple account groups", () => {
    const groups = findDuplicateGroups([
      ...["alice", "bob"].flatMap((identity) => ["a", "b"].map((suffix) => item({
        id: `vault-${suffix}:${identity}`,
        title: "GitKraken",
        urls: ["https://account.gitkraken.com/"],
        usernames: [identity],
        hasPassword: true,
        analysis: analysis({
          similarUrlKeys: ["https://account.gitkraken.com/"],
          identityValues: [identity],
          fieldSignatures: [`username:${identity}`, `password:${suffix}`]
        })
      }))),
      item({
        id: "vault-c:unknown-account",
        title: "GitKraken",
        urls: ["https://account.gitkraken.com/"],
        usernames: [],
        hasPasskey: true,
        analysis: analysis({
          similarUrlKeys: ["https://account.gitkraken.com/"],
          identityValues: []
        })
      })
    ]);

    const similarGroups = groups.filter((group) => group.candidateClass === "similar-login");
    expect(similarGroups).toHaveLength(2);
    expect(similarGroups.every((group) => group.itemIds.length === 2)).toBe(true);
    expect(groups.flatMap((group) => group.itemIds)).not.toContain("vault-c:unknown-account");
  });

  it("does not group similar login items by same domain when paths differ", () => {
    const groups = findDuplicateGroups([
      item({
        id: "vault-a:login",
        title: "Example login",
        urls: ["https://example.com/login"],
        usernames: ["alice"],
        comparableFields: [{ label: "password", kind: "secret", normalizedValueHash: "login-secret" }]
      }),
      item({
        id: "vault-b:settings",
        onePasswordItemId: "settings",
        vaultId: "vault-b",
        vaultName: "Work",
        title: "Example settings",
        urls: ["https://example.com/settings"],
        usernames: ["alice"],
        comparableFields: [{ label: "password", kind: "secret", normalizedValueHash: "settings-secret" }]
      })
    ]);

    expect(groups).toHaveLength(0);
  });

  it("resolves overlapping similar buckets so each item appears in at most one group", () => {
    const groups = findDuplicateGroups([
      item({
        id: "vault-a:a",
        title: "Service A",
        urls: ["https://example.com/login"],
        usernames: ["a"],
        comparableFields: [{ label: "password", kind: "secret", normalizedValueHash: "secret-a" }],
        analysis: analysis({
          similarUrlKeys: ["https://example.com/login"],
          identityValues: ["a"],
          fieldSignatures: ["password:secret-a"]
        })
      }),
      item({
        id: "vault-a:b",
        title: "Service B",
        urls: ["https://example.com/login"],
        usernames: ["a", "b"],
        comparableFields: [{ label: "password", kind: "secret", normalizedValueHash: "secret-b" }],
        analysis: analysis({
          similarUrlKeys: ["https://example.com/login"],
          identityValues: ["a", "b"],
          fieldSignatures: ["password:secret-b"]
        })
      }),
      item({
        id: "vault-a:c",
        title: "Service C",
        urls: ["https://example.com/login"],
        usernames: ["b"],
        comparableFields: [{ label: "password", kind: "secret", normalizedValueHash: "secret-c" }],
        analysis: analysis({
          similarUrlKeys: ["https://example.com/login"],
          identityValues: ["b"],
          fieldSignatures: ["password:secret-c"]
        })
      })
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].candidateClass).toBe("similar-login");
    expect(new Set(groups.flatMap((group) => group.itemIds)).size).toBe(groups.flatMap((group) => group.itemIds).length);
  });

  it("lets an item with identity but missing credential material join a similar group before delete suggestions are built", () => {
    const groups = findDuplicateGroups([
      item({
        id: "vault-a:empty",
        title: "Example empty login",
        urls: ["https://example.com/login"],
        usernames: ["alice"],
        comparableFields: [{ label: "username", kind: "username", normalizedValue: "alice" }]
      }),
      item({
        id: "vault-b:complete",
        onePasswordItemId: "complete",
        vaultId: "vault-b",
        vaultName: "Work",
        title: "Example complete login",
        urls: ["https://example.com/login?imported=1"],
        usernames: ["alice"],
        comparableFields: [{ label: "password", kind: "secret", normalizedValueHash: "secret" }]
      })
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].candidateClass).toBe("similar-login");
  });

  it("emits delete suggestions only for remaining login items with missing identity or credential material", () => {
    const groups = findDuplicateGroups([
      item({
        id: "vault-a:missing-username",
        title: "No username",
        urls: ["https://example.com"],
        usernames: [],
        comparableFields: [{ label: "password", kind: "secret", normalizedValueHash: "has-secret" }]
      }),
      item({
        id: "vault-a:missing-material",
        title: "No credential material",
        urls: ["https://example.org"],
        usernames: ["alice"],
        comparableFields: [{ label: "username", kind: "username", normalizedValue: "alice" }]
      })
    ]);

    expect(groups).toHaveLength(2);
    expect(groups.every((group) => group.candidateClass === "delete-suggestion")).toBe(true);
    expect(groups.every((group) => group.itemIds.length === 1)).toBe(true);
    expect(groups.every((group) => group.recommendedKeepIds.length === 0)).toBe(true);
    expect(groups.flatMap((group) => group.reasons.map((reason) => reason.rule))).toEqual(
      expect.arrayContaining(["missing-account-identity", "missing-credential-material"])
    );
  });

  it("keeps identityless logins with a title, normalized URL and TOTP or Passkey out of delete suggestions", () => {
    const groups = findDuplicateGroups([
      item({
        id: "vault-a:totp-only",
        title: "TOTP protected login",
        urls: ["https://totp.example.com/login"],
        hasTotp: true
      }),
      item({
        id: "vault-a:passkey-only",
        title: "Passkey protected login",
        urls: ["passkey.example.com/login"],
        hasPasskey: true
      })
    ]);

    expect(groups).toHaveLength(0);
  });

  it("still suggests identityless logins with only a password or without a title or normalized URL", () => {
    const groups = findDuplicateGroups([
      item({
        id: "vault-a:password-only",
        title: "Password only",
        urls: ["https://password.example.com/login"],
        hasPassword: true
      }),
      item({
        id: "vault-a:missing-title",
        title: "   ",
        urls: ["https://totp.example.com/login"],
        hasTotp: true
      }),
      item({
        id: "vault-a:missing-url",
        title: "Passkey without URL",
        urls: ["   "],
        hasPasskey: true
      })
    ]);

    expect(groups).toHaveLength(3);
    expect(groups.every((group) => group.candidateClass === "delete-suggestion")).toBe(true);
    expect(groups.map((group) => group.itemIds[0])).toEqual(expect.arrayContaining([
      "vault-a:password-only",
      "vault-a:missing-title",
      "vault-a:missing-url"
    ]));
  });

  it("does not create groups from password reuse, secret hashes, or title matches alone", () => {
    const groups = findDuplicateGroups([
      item({
        id: "vault-a:github",
        title: "Shared title",
        urls: ["https://github.com/login"],
        usernames: ["alice@example.com"],
        comparableFields: [{ label: "password", kind: "secret", normalizedValueHash: "same-secret" }]
      }),
      item({
        id: "vault-b:gitlab",
        onePasswordItemId: "gitlab",
        vaultId: "vault-b",
        vaultName: "Work",
        title: "Shared title",
        urls: ["https://gitlab.com/users/sign_in"],
        usernames: ["alice@example.com"],
        comparableFields: [{ label: "password", kind: "secret", normalizedValueHash: "same-secret" }]
      })
    ]);

    expect(groups).toHaveLength(0);
  });
});
