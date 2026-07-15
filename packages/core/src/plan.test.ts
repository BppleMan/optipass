import { describe, expect, it } from "vitest";
import { createActionPlan, createExecutionPlan, validateDecisionItemSet } from "./plan.js";
import { item } from "./test-helpers.js";

describe("createExecutionPlan", () => {
  it("builds one immutable batch plan from an ActionDraft", () => {
    const items = [item({ id: "vault-a:1", title: "A" }), item({ id: "vault-a:2", title: "A" })];
    const scan = {
      scanId: "scan-1",
      scannedAt: "2026-07-14T00:00:00.000Z",
      analyzedAt: "2026-07-14T00:00:00.000Z",
      vaults: [{ id: "vault-a", name: "A" }],
      items,
      groups: [{
        id: "group-1",
        candidateClass: "exact-duplicate" as const,
        itemIds: items.map((candidate) => candidate.id),
        reasons: [],
        recommendedKeepIds: [items[0].id],
        recommendedKeepReasons: [],
        confidence: "high" as const
      }]
    };
    const plan = createActionPlan({
      scanId: scan.scanId,
      groups: [{
        groupId: "group-1",
        items: [{ itemId: items[0].id, keep: true }, { itemId: items[1].id, keep: false }]
      }]
    }, scan, false);

    expect(plan).toMatchObject({ sourceScanId: "scan-1", writeEnabled: false, requiresExplicitDeleteConfirmation: false });
    expect(plan.groups).toHaveLength(1);
    expect(plan.summary).toMatchObject({ keep: 1, archive: 1 });
  });

  it("plans archive by default for non-kept items", () => {
    const plan = createExecutionPlan(
      "group-1",
      {
        scanId: "scan-1",
        groupId: "group-1",
        items: [
          { itemId: "vault-a:1", keep: true },
          { itemId: "vault-a:2", keep: false }
        ]
      },
      [item({ id: "vault-a:1", title: "A" }), item({ id: "vault-a:2", title: "A" })]
    );

    expect(plan.actions.map((action) => action.type)).toEqual(["keep", "archive"]);
  });

  it("plans copy-and-archive for cross-vault keeps", () => {
    const plan = createExecutionPlan(
      "group-1",
      {
        scanId: "scan-1",
        groupId: "group-1",
        items: [{ itemId: "vault-a:1", keep: true, targetVaultId: "vault-b" }]
      },
      [item({ id: "vault-a:1", title: "A", vaultId: "vault-a" })]
    );

    expect(plan.actions[0]).toMatchObject({
      type: "copy-to-vault-and-archive-source",
      targetVaultId: "vault-b"
    });
    expect(plan.warnings).toContain("跨保险库迁移会先创建副本，再归档原 item。");
  });

  it("blocks cross-vault migration for passkey items", () => {
    const plan = createExecutionPlan(
      "group-1",
      {
        scanId: "scan-1",
        groupId: "group-1",
        items: [{ itemId: "vault-a:1", keep: true, targetVaultId: "vault-b" }]
      },
      [item({ id: "vault-a:1", title: "Passkey Login", vaultId: "vault-a", hasPasskey: true })]
    );

    expect(plan.actions[0]).toMatchObject({
      type: "copy-to-vault-and-archive-source",
      targetVaultId: "vault-b"
    });
    expect(plan.blockers).toContain("含 Passkey 的 item 不支持跨保险库迁移：Passkey Login");
  });

  it("blocks plans that keep nothing", () => {
    const plan = createExecutionPlan(
      "group-1",
      {
        scanId: "scan-1",
        groupId: "group-1",
        items: [{ itemId: "vault-a:1", keep: false }]
      },
      [item({ id: "vault-a:1", title: "A" })]
    );

    expect(plan.blockers).toEqual(["该组没有选择任何保留项。请至少保留一个 item。"]);
  });

  it("allows advisory delete suggestions to keep nothing", () => {
    const plan = createExecutionPlan(
      "delete-suggestion-1",
      {
        scanId: "scan-1",
        groupId: "delete-suggestion-1",
        items: [{ itemId: "vault-a:1", keep: false }]
      },
      [item({ id: "vault-a:1", title: "Empty login" })],
      { requireKeep: false }
    );

    expect(plan.blockers).toEqual([]);
    expect(plan.actions.map((action) => action.type)).toEqual(["archive"]);
  });

  it("flags permanent delete plans for explicit confirmation", () => {
    const plan = createExecutionPlan(
      "group-1",
      {
        scanId: "scan-1",
        groupId: "group-1",
        items: [
          { itemId: "vault-a:1", keep: true },
          { itemId: "vault-a:2", keep: false, deleteMode: "delete" }
        ]
      },
      [item({ id: "vault-a:1", title: "A" }), item({ id: "vault-a:2", title: "A" })]
    );

    expect(plan.requiresExplicitDeleteConfirmation).toBe(true);
  });

  it("normalizes action order independently from decision input order", () => {
    const plan = createExecutionPlan(
      "group-1",
      {
        scanId: "scan-1",
        groupId: "group-1",
        items: [
          { itemId: "vault-a:delete", keep: false, deleteMode: "delete" },
          { itemId: "vault-a:archive", keep: false },
          { itemId: "vault-a:keep", keep: true },
          { itemId: "vault-a:move", keep: true, targetVaultId: "vault-b" }
        ]
      },
      [
        item({ id: "vault-a:delete", title: "A", vaultId: "vault-a" }),
        item({ id: "vault-a:archive", title: "A", vaultId: "vault-a" }),
        item({ id: "vault-a:keep", title: "A", vaultId: "vault-a" }),
        item({ id: "vault-a:move", title: "A", vaultId: "vault-a" })
      ]
    );

    expect(plan.actions.map((action) => [action.type, action.itemId])).toEqual([
      ["keep", "vault-a:keep"],
      ["copy-to-vault-and-archive-source", "vault-a:move"],
      ["archive", "vault-a:archive"],
      ["delete", "vault-a:delete"]
    ]);
    expect(plan.summary).toEqual({
      keep: 1,
      move: 1,
      archive: 1,
      delete: 1,
      tagUpdate: 0,
      removedTagCount: 0,
      affectedVaultIds: ["vault-a", "vault-b"]
    });
  });

  it("plans tag removal as an update for kept items", () => {
    const plan = createExecutionPlan(
      "group-1",
      {
        scanId: "scan-1",
        groupId: "group-1",
        items: [{ itemId: "vault-a:1", keep: true, removeTags: ["imported", "missing"] }]
      },
      [item({ id: "vault-a:1", title: "A", tags: ["imported", "work"] })]
    );

    expect(plan.actions[0]).toEqual({
      type: "update-tags",
      itemId: "vault-a:1",
      vaultId: "vault-a",
      removeTags: ["imported"]
    });
    expect(plan.summary).toMatchObject({ tagUpdate: 1, removedTagCount: 1 });
  });

  it("folds tag removal into cross-vault migration", () => {
    const plan = createExecutionPlan(
      "group-1",
      {
        scanId: "scan-1",
        groupId: "group-1",
        items: [{ itemId: "vault-a:1", keep: true, targetVaultId: "vault-b", removeTags: ["imported"] }]
      },
      [item({ id: "vault-a:1", title: "A", vaultId: "vault-a", tags: ["imported", "work"] })]
    );

    expect(plan.actions[0]).toMatchObject({
      type: "copy-to-vault-and-archive-source",
      removeTags: ["imported"]
    });
    expect(plan.summary).toMatchObject({ move: 1, tagUpdate: 1, removedTagCount: 1 });
  });

  it("validates that decisions cover exactly one duplicate group", () => {
    const blockers = validateDecisionItemSet(
      {
        scanId: "scan-1",
        groupId: "group-1",
        items: [
          { itemId: "a", keep: true },
          { itemId: "a", keep: false },
          { itemId: "x", keep: false }
        ]
      },
      ["a", "b"]
    );

    expect(blockers).toEqual([
      "执行请求包含重复 item：a",
      "执行请求缺少组内 item：b",
      "执行请求包含不属于该组的 item：x"
    ]);
  });
});
