import { describe, expect, it } from "vitest";
import { findDuplicateGroups } from "./duplicates.js";
import { item } from "./test-helpers.js";

describe("findDuplicateGroups", () => {
  it("groups similar login items by same domain and same account identity", () => {
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

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      candidateClass: "similar-login",
      confidence: "medium"
    });
    expect(groups[0].reasons[0]).toMatchObject({
      rule: "username-url",
      label: "域名 + 用户名相同：alice@example.com@github.com"
    });
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
