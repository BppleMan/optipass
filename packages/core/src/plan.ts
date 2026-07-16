import {
    ActionDraft,
    ActionPlan,
    ActionPlanGroup,
    ActionPlanStatistics,
    ItemAction,
    ItemBackend,
    PlannedItemAction,
    toActionStepDto,
} from "./action-model.js";
import { ActionKind, ItemDisposition, ItemProvider, StoreState } from "./domain.js";
import type { ItemStore } from "./item-store.js";
import type { SimilarityGroup } from "./model.js";

export interface ItemBackendResolver {
    get(provider: ItemProvider): ItemBackend;
}

export class ActionPlanningService {
    public constructor(
        private readonly store: ItemStore,
        private readonly backends: ItemBackendResolver,
    ) {
    }

    public async createPlan(draft: ActionDraft, groups: SimilarityGroup[]): Promise<ActionPlan> {
        this.validateStore(draft);
        const groupById = new Map(groups.map((group) => [group.id, group]));
        const planGroups: ActionPlanGroup[] = [];
        const snapshot = this.store.createSnapshot();

        for (const draftGroup of draft.groups) {
            const group = groupById.get(draftGroup.groupId);
            if (!group) {
                throw new Error(`ActionDraft 包含未知重复组：${ draftGroup.groupId }`);
            }
            this.validateItemSet(draftGroup.items.map((item) => item.itemId), group.itemIds);
            const plannedItems: PlannedItemAction[] = [];
            const warnings: string[] = [];
            const blockers: string[] = [];
            let nextSequence = 0;

            for (const draftItem of draftGroup.items) {
                const item = this.store.getRequired(draftItem.itemId);
                const mapping = await this.backends.get(item.source.provider).map({
                    snapshot,
                    groupId: group.id,
                    startingSequence: nextSequence,
                    draft: draftItem,
                    item,
                });
                nextSequence += mapping.actions.length;
                plannedItems.push({
                    itemId: item.id,
                    disposition: draftItem.disposition,
                    intent: { ...draftItem, removeTags: [...draftItem.removeTags] },
                    actions: mapping.actions,
                });
                warnings.push(...mapping.warnings);
                blockers.push(...mapping.blockers);
            }

            const actions = plannedItems.flatMap((item) => item.actions).sort(compareActions);
            planGroups.push({
                groupId: group.id,
                items: plannedItems,
                steps: actions.map(toActionStepDto),
                warnings: unique(warnings),
                blockers: unique(blockers),
            });
        }

        const planId = globalThis.crypto.randomUUID();
        const statistics = planStatistics(planGroups);
        const planHash = await createPlanHash(draft, planGroups);
        return {
            planId,
            planHash,
            storeSnapshotId: draft.storeSnapshotId,
            storeVersion: draft.storeVersion,
            groups: planGroups,
            warnings: unique(planGroups.flatMap((group) => group.warnings)),
            blockers: unique(planGroups.flatMap((group) => group.blockers)),
            requiresExplicitDeleteConfirmation: draft.groups.some((group) => group.items.some((item) => item.disposition === ItemDisposition.Delete)),
            statistics,
        };
    }

    private validateStore(draft: ActionDraft): void {
        if (this.store.getState() !== StoreState.Ready) {
            throw new Error("Item Store 尚未就绪或已经失效，请重新扫描。");
        }
        if (draft.storeSnapshotId !== this.store.getSnapshotId() || draft.storeVersion !== this.store.getVersion()) {
            throw new Error("ActionDraft 对应的 Item Store 已发生变化，请重新生成计划。");
        }
    }

    private validateItemSet(actualItemIds: string[], expectedItemIds: string[]): void {
        const duplicateItemIds = actualItemIds.filter((itemId, index) => actualItemIds.indexOf(itemId) !== index);
        const missingItemIds = expectedItemIds.filter((itemId) => !actualItemIds.includes(itemId));
        const extraItemIds = actualItemIds.filter((itemId) => !expectedItemIds.includes(itemId));
        if (duplicateItemIds.length > 0) {
            throw new Error(`执行请求包含重复 item：${ unique(duplicateItemIds).join(", ") }`);
        }
        if (missingItemIds.length > 0) {
            throw new Error(`执行请求缺少组内 item：${ missingItemIds.join(", ") }`);
        }
        if (extraItemIds.length > 0) {
            throw new Error(`执行请求包含不属于该组的 item：${ extraItemIds.join(", ") }`);
        }
    }
}

function compareActions(left: ItemAction, right: ItemAction): number {
    return left.sequence - right.sequence || left.actionId.localeCompare(right.actionId);
}

function unique(values: string[]): string[] {
    return Array.from(new Set(values));
}

function planStatistics(groups: ActionPlanGroup[]): ActionPlanStatistics {
    const actions = groups.flatMap((group) => group.items.flatMap((item) => item.actions));
    return {
        groupCount: groups.length,
        itemCount: groups.reduce((count, group) => count + group.items.length, 0),
        stepCount: actions.length,
        mutationStepCount: actions.filter((action) => action.kind !== ActionKind.Keep).length,
    };
}

async function createPlanHash(draft: ActionDraft, groups: ActionPlanGroup[]): Promise<string> {
    const payload = JSON.stringify({
        storeSnapshotId: draft.storeSnapshotId,
        storeVersion: draft.storeVersion,
        groups: groups.map((group) => ({
            groupId: group.groupId,
            items: group.items.map((item) => ({
                itemId: item.itemId,
                disposition: item.disposition,
                intent: item.intent,
                steps: item.actions.map(toActionStepDto),
            })),
            blockers: group.blockers,
            warnings: group.warnings,
        })),
    });
    const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
    return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}
