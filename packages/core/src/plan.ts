import { ExecutionPlan, ExecutionPlanSummary, GroupDecision, ItemSummary, PlanAction } from "./model.js";

interface ExecutionPlanOptions {
  requireKeep?: boolean;
}

export function validateDecisionItemSet(decisions: GroupDecision, expectedItemIds: string[]): string[] {
  const blockers: string[] = [];
  const actualItemIds = decisions.items.map((decision) => decision.itemId);
  const duplicateItemIds = actualItemIds.filter((itemId, index) => actualItemIds.indexOf(itemId) !== index);
  const missingItemIds = expectedItemIds.filter((itemId) => !actualItemIds.includes(itemId));
  const extraItemIds = actualItemIds.filter((itemId) => !expectedItemIds.includes(itemId));

  if (duplicateItemIds.length > 0) {
    blockers.push(`执行请求包含重复 item：${Array.from(new Set(duplicateItemIds)).join(", ")}`);
  }
  if (missingItemIds.length > 0) {
    blockers.push(`执行请求缺少组内 item：${missingItemIds.join(", ")}`);
  }
  if (extraItemIds.length > 0) {
    blockers.push(`执行请求包含不属于该组的 item：${extraItemIds.join(", ")}`);
  }

  return blockers;
}

export function createExecutionPlan(
  groupId: string,
  decisions: GroupDecision,
  items: ItemSummary[],
  options: ExecutionPlanOptions = {}
): ExecutionPlan {
  const itemById = new Map(items.map((item) => [item.id, item]));
  const warnings: string[] = [];
  const blockers: string[] = [];
  const keepDecisions = decisions.items.filter((decision) => decision.keep);
  const requireKeep = options.requireKeep ?? true;

  if (requireKeep && keepDecisions.length === 0) {
    blockers.push("该组没有选择任何保留项。请至少保留一个 item。");
  }

  const actions = decisions.items.map<PlanAction>((decision) => {
    const item = itemById.get(decision.itemId);
    if (!item) {
      throw new Error(`执行请求包含未知 item：${decision.itemId}`);
    }

    const targetVaultId = decision.targetVaultId || item.vaultId;
    const removeTags = Array.from(new Set(decision.removeTags ?? []))
      .filter((tag) => item.tags.includes(tag));

    if (decision.keep && targetVaultId !== item.vaultId) {
      if (item.hasPasskey) {
        blockers.push(`含 Passkey 的 item 不支持跨保险库迁移：${item.title}`);
      }
      warnings.push("跨保险库迁移会先创建副本，再归档原 item。");
      return {
        type: "copy-to-vault-and-archive-source" as const,
        itemId: item.id,
        vaultId: item.vaultId,
        targetVaultId,
        removeTags
      };
    }

    if (decision.keep) {
      if (removeTags.length > 0) {
        return {
          type: "update-tags" as const,
          itemId: item.id,
          vaultId: item.vaultId,
          removeTags
        };
      }
      return {
        type: "keep" as const,
        itemId: item.id,
        vaultId: item.vaultId,
        targetVaultId
      };
    }

    return {
      type: decision.deleteMode === "delete" ? ("delete" as const) : ("archive" as const),
      itemId: item.id,
      vaultId: item.vaultId
    };
  }).sort(comparePlanActions);

  return {
    createdAt: new Date().toISOString(),
    groupId,
    actions,
    summary: summarizeActions(actions),
    warnings: Array.from(new Set(warnings)),
    blockers: Array.from(new Set(blockers)),
    requiresExplicitDeleteConfirmation: actions.some((action) => action.type === "delete")
  };
}

function summarizeActions(actions: PlanAction[]): ExecutionPlanSummary {
  const affectedVaultIds = new Set<string>();
  const summary: ExecutionPlanSummary = {
    keep: 0,
    archive: 0,
    delete: 0,
    move: 0,
    tagUpdate: 0,
    removedTagCount: 0,
    affectedVaultIds: []
  };

  for (const action of actions) {
    affectedVaultIds.add(action.vaultId);
    if (action.type === "keep") {
      summary.keep += 1;
    } else if (action.type === "update-tags") {
      summary.keep += 1;
      summary.tagUpdate += 1;
      summary.removedTagCount += action.removeTags.length;
    } else if (action.type === "archive") {
      summary.archive += 1;
    } else if (action.type === "delete") {
      summary.delete += 1;
    } else if (action.type === "copy-to-vault-and-archive-source") {
      summary.move += 1;
      if (action.removeTags.length > 0) {
        summary.tagUpdate += 1;
        summary.removedTagCount += action.removeTags.length;
      }
      affectedVaultIds.add(action.targetVaultId);
    }
  }

  return {
    ...summary,
    affectedVaultIds: Array.from(affectedVaultIds).sort()
  };
}

function comparePlanActions(a: PlanAction, b: PlanAction): number {
  return actionPriority(a) - actionPriority(b) || a.itemId.localeCompare(b.itemId);
}

function actionPriority(action: PlanAction): number {
  switch (action.type) {
    case "keep":
      return 0;
    case "update-tags":
      return 1;
    case "copy-to-vault-and-archive-source":
      return 2;
    case "archive":
      return 3;
    case "delete":
      return 4;
  }
}
