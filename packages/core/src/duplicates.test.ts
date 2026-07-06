import { describe, expect, it } from "vitest";
import { findDuplicateGroups } from "./duplicates.js";
import { item } from "./test-helpers.js";

describe("findDuplicateGroups", () => {
  it("does not group similar login items by same domain when normalized URLs differ", () => {
    const groups = findDuplicateGroups([
      item({
        id: "vault-a:1",
        title: "GitHub",
        urls: ["https://github.com/login"],
        usernames: ["alice@example.com"],
        comparableFields: [{ label: "password", kind: "secret", normalizedValueHash: "old-secret" }]
      }),
      item({
        id: "vault-b:2",
        onePasswordItemId: "2",
        vaultId: "vault-b",
        vaultName: "Work",
        title: "GitHub work",
        urls: ["https://github.com/settings/profile"],
        usernames: ["alice@example.com"],
        comparableFields: [{ label: "password", kind: "secret", normalizedValueHash: "new-secret" }]
      })
    ]);

    expect(groups).toHaveLength(0);
  });

  it("groups similar login items by same normalized URL and same account identity", () => {
    const groups = findDuplicateGroups([
      item({
        id: "vault-a:1",
        title: "GitHub",
        urls: ["https://www.github.com/login/"],
        usernames: ["alice@example.com"],
        comparableFields: [{ label: "password", kind: "secret", normalizedValueHash: "old-secret" }]
      }),
      item({
        id: "vault-b:2",
        onePasswordItemId: "2",
        vaultId: "vault-b",
        vaultName: "Work",
        title: "GitHub work",
        urls: ["github.com/login"],
        usernames: ["alice@example.com"],
        comparableFields: [{ label: "password", kind: "secret", normalizedValueHash: "new-secret" }]
      })
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      candidateClass: "similar-login",
      confidence: "high"
    });
    expect(groups[0].reasons[0]).toMatchObject({
      rule: "username-url",
      label: "完整 URL + 用户名相同：alice@example.com@https://github.com/login"
    });
  });

  it("keeps same domain but different full URLs in separate login buckets", () => {
    const groups = findDuplicateGroups([
      item({
        id: "vault-a:login-1",
        title: "Example login",
        urls: ["https://example.com/login"],
        usernames: ["alice"],
        comparableFields: [{ label: "password", kind: "secret", normalizedValueHash: "login-old" }]
      }),
      item({
        id: "vault-b:login-2",
        onePasswordItemId: "login-2",
        vaultId: "vault-b",
        vaultName: "Work",
        title: "Example login copy",
        urls: ["https://example.com/login"],
        usernames: ["alice"],
        comparableFields: [{ label: "password", kind: "secret", normalizedValueHash: "login-new" }]
      }),
      item({
        id: "vault-a:settings-1",
        title: "Example settings",
        urls: ["https://example.com/settings"],
        usernames: ["alice"],
        comparableFields: [{ label: "password", kind: "secret", normalizedValueHash: "settings-old" }]
      }),
      item({
        id: "vault-b:settings-2",
        onePasswordItemId: "settings-2",
        vaultId: "vault-b",
        vaultName: "Work",
        title: "Example settings copy",
        urls: ["https://example.com/settings"],
        usernames: ["alice"],
        comparableFields: [{ label: "password", kind: "secret", normalizedValueHash: "settings-new" }]
      })
    ]);

    expect(groups).toHaveLength(2);
    expect(groups.every((group) => group.candidateClass === "similar-login")).toBe(true);
    expect(groups.map((group) => group.itemIds.sort())).toEqual(
      expect.arrayContaining([
        ["vault-a:login-1", "vault-b:login-2"],
        ["vault-a:settings-1", "vault-b:settings-2"]
      ])
    );
  });

  it("does not merge root and querystring URL variants into one exact group", () => {
    const groups = findDuplicateGroups([
      item({
        id: "vault-a:leetcode-root",
        title: "leetcode-cn.com",
        urls: ["https://leetcode-cn.com/"],
        usernames: ["18194005505"],
        comparableFields: [{ label: "password", kind: "secret", normalizedValueHash: "same-secret" }]
      }),
      item({
        id: "vault-b:leetcode-query-1",
        onePasswordItemId: "leetcode-query-1",
        vaultId: "vault-b",
        vaultName: "Work",
        title: "leetcode-cn.com",
        urls: ["https://leetcode-cn.com/?utm_source=LCUS&utm_medium=banner_redirect&utm_campaign=transfer2china"],
        usernames: ["18194005505"],
        comparableFields: [{ label: "password", kind: "secret", normalizedValueHash: "same-secret" }]
      }),
      item({
        id: "vault-c:leetcode-query-2",
        onePasswordItemId: "leetcode-query-2",
        vaultId: "vault-c",
        vaultName: "Archive",
        title: "leetcode-cn.com",
        urls: ["https://leetcode-cn.com/?utm_source=LCUS&utm_medium=banner_redirect&utm_campaign=transfer2china"],
        usernames: ["18194005505"],
        comparableFields: [{ label: "password", kind: "secret", normalizedValueHash: "same-secret" }]
      })
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      candidateClass: "exact-duplicate"
    });
    expect(groups[0].itemIds).toEqual(expect.arrayContaining(["vault-b:leetcode-query-1", "vault-c:leetcode-query-2"]));
    expect(groups[0].itemIds).not.toContain("vault-a:leetcode-root");
  });

  it("classifies login copies as exact only after the site and username anchor matches", () => {
    const groups = findDuplicateGroups([
      item({
        id: "vault-a:1",
        title: "GitHub",
        urls: ["https://github.com/login"],
        usernames: ["alice@example.com"],
        comparableFields: [{ label: "password", kind: "secret", normalizedValueHash: "same-secret" }]
      }),
      item({
        id: "vault-b:2",
        onePasswordItemId: "2",
        vaultId: "vault-b",
        vaultName: "Work",
        title: "GitHub copy",
        urls: ["github.com/login"],
        usernames: ["alice@example.com"],
        comparableFields: [{ label: "password", kind: "secret", normalizedValueHash: "same-secret" }]
      })
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      candidateClass: "exact-duplicate",
      confidence: "high"
    });
    expect(groups[0].reasons.map((reason) => reason.rule)).toEqual(expect.arrayContaining(["username-url", "credential-material"]));
  });

  it("keeps same username and URL items similar when credential fingerprints differ", () => {
    const groups = findDuplicateGroups([
      item({
        id: "vault-a:1",
        title: "GitHub",
        urls: ["https://github.com/login"],
        usernames: ["alice@example.com"],
        comparableFields: [{ label: "password", kind: "secret", normalizedValueHash: "old-secret" }]
      }),
      item({
        id: "vault-b:2",
        onePasswordItemId: "2",
        vaultId: "vault-b",
        vaultName: "Work",
        title: "GitHub backup",
        urls: ["https://github.com/login"],
        usernames: ["alice@example.com"],
        comparableFields: [{ label: "password", kind: "secret", normalizedValueHash: "new-secret" }]
      })
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      candidateClass: "similar-login",
      confidence: "high"
    });
    expect(groups[0].reasons.map((reason) => reason.rule)).not.toContain("credential-material");
  });

  it("does not classify a shared username and URL bucket as exact when full username sets differ", () => {
    const groups = findDuplicateGroups([
      item({
        id: "vault-a:1",
        title: "GitHub",
        urls: ["https://github.com/login"],
        usernames: ["alice@example.com"],
        comparableFields: [{ label: "password", kind: "secret", normalizedValueHash: "same-secret" }]
      }),
      item({
        id: "vault-b:2",
        onePasswordItemId: "2",
        vaultId: "vault-b",
        vaultName: "Work",
        title: "GitHub copy",
        urls: ["https://github.com/login"],
        usernames: ["alice@example.com", "alice"],
        comparableFields: [{ label: "password", kind: "secret", normalizedValueHash: "same-secret" }]
      })
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      candidateClass: "similar-login",
      confidence: "high"
    });
  });

  it("does not classify a shared username and URL bucket as exact when full URL sets differ", () => {
    const groups = findDuplicateGroups([
      item({
        id: "vault-a:1",
        title: "GitHub",
        urls: ["https://github.com/login"],
        usernames: ["alice@example.com"],
        comparableFields: [{ label: "password", kind: "secret", normalizedValueHash: "same-secret" }]
      }),
      item({
        id: "vault-b:2",
        onePasswordItemId: "2",
        vaultId: "vault-b",
        vaultName: "Work",
        title: "GitHub copy",
        urls: ["https://github.com/login", "https://github.com/settings"],
        usernames: ["alice@example.com"],
        comparableFields: [{ label: "password", kind: "secret", normalizedValueHash: "same-secret" }]
      })
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      candidateClass: "similar-login",
      confidence: "high"
    });
  });

  it("does not classify matching password hashes as exact when credential kinds differ", () => {
    const groups = findDuplicateGroups([
      item({
        id: "vault-a:1",
        title: "GitHub",
        urls: ["https://github.com/login"],
        usernames: ["alice@example.com"],
        comparableFields: [{ label: "password", kind: "secret", normalizedValueHash: "same-secret" }]
      }),
      item({
        id: "vault-b:2",
        onePasswordItemId: "2",
        vaultId: "vault-b",
        vaultName: "Work",
        title: "GitHub copy",
        urls: ["https://github.com/login"],
        usernames: ["alice@example.com"],
        hasTotp: true,
        comparableFields: [{ label: "password", kind: "secret", normalizedValueHash: "same-secret" }]
      })
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      candidateClass: "similar-login",
      confidence: "high"
    });
  });

  it("does not classify matching secret values as exact when password material types differ", () => {
    const groups = findDuplicateGroups([
      item({
        id: "vault-a:1",
        title: "GitHub",
        urls: ["https://github.com/login"],
        usernames: ["alice@example.com"],
        hasPassword: true,
        comparableFields: [{ label: "password", kind: "secret", normalizedValueHash: "same-secret" }]
      }),
      item({
        id: "vault-b:2",
        onePasswordItemId: "2",
        vaultId: "vault-b",
        vaultName: "Work",
        title: "GitHub copy",
        urls: ["https://github.com/login"],
        usernames: ["alice@example.com"],
        comparableFields: [{ label: "api secret", kind: "secret", normalizedValueHash: "same-secret" }]
      })
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      candidateClass: "similar-login",
      confidence: "high"
    });
  });

  it("does not classify matching secret hashes as exact when secret labels differ", () => {
    const groups = findDuplicateGroups([
      item({
        id: "vault-a:1",
        title: "GitHub",
        urls: ["https://github.com/login"],
        usernames: ["alice@example.com"],
        hasPassword: true,
        comparableFields: [{ label: "password", kind: "secret", normalizedValueHash: "same-secret" }]
      }),
      item({
        id: "vault-b:2",
        onePasswordItemId: "2",
        vaultId: "vault-b",
        vaultName: "Work",
        title: "GitHub copy",
        urls: ["https://github.com/login"],
        usernames: ["alice@example.com"],
        hasPassword: true,
        comparableFields: [{ label: "recovery code", kind: "secret", normalizedValueHash: "same-secret" }]
      })
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      candidateClass: "similar-login",
      confidence: "high"
    });
  });

  it("does not create groups from password reuse or secret hashes alone", () => {
    const groups = findDuplicateGroups([
      item({
        id: "vault-a:1",
        title: "GitHub",
        urls: ["https://github.com/login"],
        usernames: ["alice@example.com"],
        comparableFields: [{ label: "password", kind: "secret", normalizedValueHash: "same-secret" }]
      }),
      item({
        id: "vault-b:2",
        onePasswordItemId: "2",
        vaultId: "vault-b",
        vaultName: "Work",
        title: "GitLab",
        urls: ["https://gitlab.com/users/sign_in"],
        usernames: ["alice@example.com"],
        comparableFields: [{ label: "password", kind: "secret", normalizedValueHash: "same-secret" }]
      })
    ]);

    expect(groups).toHaveLength(0);
  });

  it("does not bridge unrelated login items through mixed weak clues", () => {
    const groups = findDuplicateGroups([
      item({
        id: "vault-a:1",
        title: "GitHub",
        urls: ["https://github.com/login"],
        usernames: ["alice"],
        comparableFields: [{ label: "password", kind: "secret", normalizedValueHash: "secret-a" }]
      }),
      item({
        id: "vault-b:2",
        onePasswordItemId: "2",
        vaultId: "vault-b",
        vaultName: "Work",
        title: "GitHub",
        urls: ["https://example.com"],
        usernames: ["alice"],
        comparableFields: [{ label: "password", kind: "secret", normalizedValueHash: "secret-b" }]
      }),
      item({
        id: "vault-c:3",
        onePasswordItemId: "3",
        vaultId: "vault-c",
        vaultName: "Archive",
        title: "Other",
        urls: ["https://github.com/login"],
        usernames: ["bob"],
        comparableFields: [{ label: "password", kind: "secret", normalizedValueHash: "secret-a" }]
      })
    ]);

    expect(groups).toHaveLength(0);
  });

  it("does not create miscellaneous candidate groups for non-login items", () => {
    const groups = findDuplicateGroups([
      item({
        id: "vault-a:note-1",
        title: "VPN Recovery",
        category: "secure-note"
      }),
      item({
        id: "vault-b:note-2",
        onePasswordItemId: "note-2",
        vaultId: "vault-b",
        vaultName: "Work",
        title: "VPN Recovery",
        category: "document"
      }),
      item({
        id: "vault-a:card-1",
        title: "Visa",
        category: "credit-card"
      }),
      item({
        id: "vault-a:ssh-1",
        title: "One-off SSH key",
        category: "ssh-key"
      }),
      item({
        id: "vault-b:card-2",
        onePasswordItemId: "card-2",
        vaultId: "vault-b",
        vaultName: "Work",
        title: "Visa",
        category: "credit-card"
      }),
      item({
        id: "vault-c:login-1",
        onePasswordItemId: "login-1",
        vaultId: "vault-c",
        vaultName: "Archive",
        title: "VPN Recovery",
        category: "login",
        urls: ["https://vpn.example.com"],
        usernames: ["alice"],
        comparableFields: [{ label: "password", kind: "secret", normalizedValueHash: "vpn-secret" }]
      })
    ]);

    expect(groups).toHaveLength(0);
  });

  it("emits delete suggestions as advisory single-item candidates", () => {
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
        urls: ["https://example.com"],
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

  it("treats one-time passwords and sign-in-with fields as credential material", () => {
    const groups = findDuplicateGroups([
      item({
        id: "vault-a:totp-only",
        title: "TOTP only",
        urls: ["https://example.com"],
        usernames: ["alice"],
        hasTotp: true
      }),
      item({
        id: "vault-a:signin-only",
        title: "Sign in with",
        urls: ["https://example.org"],
        usernames: ["bob"],
        hasPasskey: true
      })
    ]);

    expect(groups).toHaveLength(0);
  });
});
