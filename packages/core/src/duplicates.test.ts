import { describe, expect, it } from "vitest";
import { findDuplicateGroups } from "./duplicates.js";
import { item } from "./test-helpers.js";

describe("findDuplicateGroups", () => {
  it("groups connected duplicates across different matching rules", () => {
    const groups = findDuplicateGroups([
      item({
        id: "vault-a:1",
        title: "GitHub",
        urls: ["https://github.com/login"],
        usernames: ["alice"]
      }),
      item({
        id: "vault-b:2",
        onePasswordItemId: "2",
        vaultId: "vault-b",
        vaultName: "Work",
        title: "github copy",
        urls: ["github.com/login"],
        usernames: ["alice"]
      }),
      item({
        id: "vault-c:3",
        onePasswordItemId: "3",
        vaultId: "vault-c",
        vaultName: "Archive",
        title: "GitHub",
        urls: ["https://example.com"],
        usernames: ["alice"]
      })
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].itemIds.sort()).toEqual(["vault-a:1", "vault-b:2", "vault-c:3"]);
    expect(groups[0].reasons.map((reason) => reason.rule)).toEqual(expect.arrayContaining(["title", "url", "username-url"]));
  });

  it("recommends preserving multiple high-value items when attachments or totp are present", () => {
    const groups = findDuplicateGroups([
      item({
        id: "vault-a:1",
        title: "Example",
        urls: ["https://example.com"],
        updatedAt: "2026-01-01T00:00:00.000Z",
        hasTotp: true,
        fieldCount: 4
      }),
      item({
        id: "vault-a:2",
        title: "Example",
        urls: ["https://example.com"],
        updatedAt: "2026-01-02T00:00:00.000Z",
        hasAttachments: true,
        fieldCount: 4
      })
    ]);

    expect(groups[0].recommendedKeepIds.sort()).toEqual(["vault-a:1", "vault-a:2"]);
    expect(groups[0].recommendedKeepReasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ itemId: "vault-a:1", labels: expect.arrayContaining(["含 TOTP"]) }),
        expect.objectContaining({ itemId: "vault-a:2", labels: expect.arrayContaining(["含附件"]) })
      ])
    );
  });

  it("uses secret hashes without exposing secret values", () => {
    const groups = findDuplicateGroups([
      item({
        id: "vault-a:1",
        title: "API A",
        comparableFields: [{ label: "token", kind: "secret", normalizedValueHash: "same-secret-hash" }]
      }),
      item({
        id: "vault-b:2",
        onePasswordItemId: "2",
        vaultId: "vault-b",
        vaultName: "Work",
        title: "Different title",
        comparableFields: [{ label: "token", kind: "secret", normalizedValueHash: "same-secret-hash" }]
      })
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].confidence).toBe("high");
    expect(groups[0].reasons[0].key).toBe("secret:secret:same-secret-hash");
    expect(JSON.stringify(groups[0].recommendedKeepReasons)).not.toContain("same-secret-hash");
  });

  it("explains why a single item is recommended to keep", () => {
    const groups = findDuplicateGroups([
      item({
        id: "vault-a:1",
        title: "Example",
        urls: ["https://example.com"],
        updatedAt: "2026-01-03T00:00:00.000Z",
        hasNotes: true,
        tags: ["important"],
        fieldCount: 5
      }),
      item({
        id: "vault-b:2",
        onePasswordItemId: "2",
        vaultId: "vault-b",
        vaultName: "Work",
        title: "Example",
        urls: ["https://example.com"],
        fieldCount: 1
      })
    ]);

    expect(groups[0].recommendedKeepIds).toEqual(["vault-a:1"]);
    expect(groups[0].recommendedKeepReasons[0]).toMatchObject({
      itemId: "vault-a:1",
      labels: expect.arrayContaining(["含备注", "字段 5", "URL 1", "标签 1", "最近更新"])
    });
  });

  it("uses hashed card fields for high-confidence duplicate groups", () => {
    const groups = findDuplicateGroups([
      item({
        id: "vault-a:card-1",
        title: "Personal Visa",
        category: "credit-card",
        comparableFields: [{ label: "card number", kind: "card", normalizedValueHash: "same-card-hash" }]
      }),
      item({
        id: "vault-b:card-2",
        onePasswordItemId: "card-2",
        vaultId: "vault-b",
        vaultName: "Work",
        title: "Backup Card",
        category: "credit-card",
        comparableFields: [{ label: "card number", kind: "card", normalizedValueHash: "same-card-hash" }]
      })
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].confidence).toBe("high");
    expect(groups[0].reasons[0]).toMatchObject({
      rule: "secret",
      key: "secret:card:same-card-hash",
      label: "敏感字段指纹相同：card number"
    });
  });
});
