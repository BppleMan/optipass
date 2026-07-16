import { randomUUID } from "node:crypto";
import {
    ActionMappingRequest,
    ActionMappingResult,
    ArchiveItemAction,
    ArchiveItemCommand,
    BackendCapabilities,
    BackendMutationResult,
    BackendReadRequest,
    BackendReadResult,
    BackendVerificationRequest,
    BackendVerificationResult,
    CanonicalItem,
    CreateItemAction,
    CreateItemCommand,
    DeleteItemAction,
    DeleteItemCommand,
    ItemBackend,
    ItemAction,
    ItemCapability,
    ItemDisposition,
    ItemFieldKind,
    ItemFieldSensitivity,
    ItemIdentityKind,
    ItemLifecycleState,
    ItemPatch,
    ItemProvider,
    ItemStore,
    KeepItemAction,
    UpdateItemAction,
    UpdateItemCommand,
    VerificationSeverity,
} from "@optimize-password/core";
import { createMockScanResult } from "./mock-data.js";
import { canonicalItemId } from "./onepassword-backend.js";

export class MockItemBackend implements ItemBackend {
    public getProvider(): ItemProvider {
        return ItemProvider.Mock;
    }

    public getCapabilities(): BackendCapabilities {
        return {
            supportsCreate: true,
            supportsUpdate: true,
            supportsArchive: true,
            supportsDelete: true,
            supportsAtomicContainerChange: false,
            supportsCopy: true,
            supportsAttachments: true,
            supportsPasskeys: false,
            supportsSecretFields: true,
        };
    }

    public async readAll(request: BackendReadRequest): Promise<BackendReadResult> {
        const scan = createMockScanResult();
        const accountId = request.accountId || "mock";
        const containers = scan.vaults.map((vault) => ({ provider: ItemProvider.Mock, accountId, containerId: vault.id, name: vault.name }));
        const containerById = new Map(containers.map((container) => [container.containerId, container]));
        const items = scan.items.map((item) => toCanonical(item, accountId, containerById.get(item.vaultId)!));
        request.onProgress?.("Mock 扫描完成。", items.length);
        return { provider: ItemProvider.Mock, accountId, items, containers };
    }

    public async create(command: CreateItemCommand, source: CanonicalItem): Promise<BackendMutationResult> {
        const externalItemId = randomUUID();
        const createdItem: CanonicalItem = {
            ...structuredClone(source),
            id: canonicalItemId(ItemProvider.Mock, source.source.accountId, externalItemId),
            source: { ...source.source, externalItemId },
            container: { ...source.container, containerId: command.targetContainerId },
            revision: 1,
            title: command.desiredTitle ?? source.title,
            tags: source.tags.filter((tag) => !command.removeTags.includes(tag)),
        };
        return { createdItem };
    }

    public async update(command: UpdateItemCommand, currentItem: CanonicalItem): Promise<BackendMutationResult> {
        const updatedItem = applyPatch(currentItem, command.patch);
        return { updatedItem };
    }

    public async archive(command: ArchiveItemCommand, currentItem: CanonicalItem): Promise<BackendMutationResult> {
        return this.update({ itemId: command.itemId, patch: { lifecycleState: ItemLifecycleState.Archived } }, currentItem);
    }

    public async delete(command: DeleteItemCommand, currentItem: CanonicalItem): Promise<BackendMutationResult> {
        if (currentItem.id !== command.itemId) {
            throw new Error(`删除命令与当前 item 不匹配：${ command.itemId }`);
        }
        return { removedItemId: command.itemId };
    }

    public async verify(_request: BackendVerificationRequest): Promise<BackendVerificationResult> {
        return { ok: true, severity: VerificationSeverity.Incomplete, message: "Mock 操作已确认。" };
    }

    public async map(request: ActionMappingRequest): Promise<ActionMappingResult> {
        const { draft, groupId, item } = request;
        const actions: ItemAction[] = [];
        let sequence = request.startingSequence;
        const targetContainerId = draft.targetContainerId ?? item.container.containerId;
        const desiredTitle = draft.desiredTitle?.trim();
        const tags = item.tags.filter((tag) => !draft.removeTags.includes(tag));
        if (draft.disposition === ItemDisposition.Keep && targetContainerId !== item.container.containerId) {
            if (!request.snapshot.containers.some((container) => container.containerId === targetContainerId &&
                container.provider === item.source.provider && container.accountId === item.source.accountId)) {
                return {
                    actions,
                    blockers: [`目标容器不存在或不属于当前账户：${ targetContainerId }`],
                    warnings: [],
                    affectedItemIds: [item.id],
                };
            }
            const createId = randomUUID();
            actions.push(new CreateItemAction(createId, groupId, item.id, ItemProvider.Mock, sequence++, [], {
                label: `复制「${ item.title }」`, detail: "复制到目标容器", sourceLabel: item.container.name, targetLabel: targetContainerId,
            }, { sourceItemId: item.id, targetContainerId, desiredTitle, removeTags: draft.removeTags }));
            actions.push(new ArchiveItemAction(randomUUID(), groupId, item.id, ItemProvider.Mock, sequence++, [createId], {
                label: `归档原 item「${ item.title }」`, detail: "副本创建成功后归档源 item",
            }, { itemId: item.id }));
        } else if (draft.disposition === ItemDisposition.Keep && ((desiredTitle && desiredTitle !== item.title) || tags.length !== item.tags.length)) {
            const patch: ItemPatch = { tags };
            if (desiredTitle && desiredTitle !== item.title) {
                patch.title = desiredTitle;
            }
            actions.push(new UpdateItemAction(randomUUID(), groupId, item.id, ItemProvider.Mock, sequence++, [], {
                label: `更新「${ item.title }」`, detail: "修改标题或标签",
            }, { itemId: item.id, patch }));
        } else if (draft.disposition === ItemDisposition.Keep) {
            actions.push(new KeepItemAction(randomUUID(), groupId, item.id, ItemProvider.Mock, sequence++, { label: `保留「${ item.title }」`, detail: "不修改 item" }));
        } else if (draft.disposition === ItemDisposition.Delete) {
            actions.push(new DeleteItemAction(randomUUID(), groupId, item.id, ItemProvider.Mock, sequence++, [], {
                label: `永久删除「${ item.title }」`, detail: "永久删除 item",
            }, { itemId: item.id }));
        } else {
            actions.push(new ArchiveItemAction(randomUUID(), groupId, item.id, ItemProvider.Mock, sequence++, [], {
                label: `归档「${ item.title }」`, detail: "归档 item",
            }, { itemId: item.id }));
        }
        return { actions, blockers: [], warnings: [], affectedItemIds: [item.id] };
    }

    public async simulate(step: import("@optimize-password/core").ItemAction, store: ItemStore): Promise<BackendMutationResult> {
        if (step instanceof CreateItemAction) {
            const source = store.getRequired(step.command.sourceItemId);
            const createdItem: CanonicalItem = {
                ...structuredClone(source),
                id: canonicalItemId(ItemProvider.Mock, source.source.accountId, `dry-run-${ step.actionId }`),
                source: { ...source.source, externalItemId: `dry-run-${ step.actionId }` },
                container: { ...source.container, containerId: step.command.targetContainerId },
                revision: 1,
                title: step.command.desiredTitle ?? source.title,
                tags: source.tags.filter((tag) => !step.command.removeTags.includes(tag)),
            };
            return { createdItem };
        }
        if (step instanceof UpdateItemAction) {
            return { updatedItem: applyPatch(store.getRequired(step.command.itemId), step.command.patch) };
        }
        if (step instanceof ArchiveItemAction) {
            return { updatedItem: applyPatch(store.getRequired(step.command.itemId), { lifecycleState: ItemLifecycleState.Archived }) };
        }
        if (step instanceof DeleteItemAction) {
            return { removedItemId: step.command.itemId };
        }
        return {};
    }

    public clearSession(): void {
    }
}

function toCanonical(item: import("@optimize-password/core").ItemSummary, accountId: string, container: CanonicalItem["container"]): CanonicalItem {
    return {
        id: canonicalItemId(ItemProvider.Mock, accountId, item.onePasswordItemId),
        source: { provider: ItemProvider.Mock, accountId, externalItemId: item.onePasswordItemId },
        container,
        revision: 1,
        lifecycleState: ItemLifecycleState.Active,
        category: item.category,
        title: item.title,
        notes: item.analysis?.notesText,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        identities: item.usernames.map((value) => ({ kind: value.includes("@") ? ItemIdentityKind.Email : ItemIdentityKind.Username, value })),
        urls: item.urls.map((value) => ({ value })),
        tags: [...item.tags],
        sections: [],
        fields: item.comparableFields.map((field, index) => ({
            id: `${ index }`, label: field.label, kind: comparableKind(field.kind),
            sensitivity: field.kind === "secret" ? ItemFieldSensitivity.Secret : ItemFieldSensitivity.Private,
            normalizedValue: field.normalizedValue, normalizedValueHash: field.normalizedValueHash,
        })),
        attachments: [],
        capabilities: [ItemCapability.Update, ItemCapability.Archive, ItemCapability.Delete, ItemCapability.ChangeContainer, ItemCapability.Copy],
    };
}

function comparableKind(kind: string): ItemFieldKind {
    return Object.values(ItemFieldKind).includes(kind as ItemFieldKind) ? kind as ItemFieldKind : ItemFieldKind.Unknown;
}

function applyPatch(item: CanonicalItem, patch: ItemPatch): CanonicalItem {
    return { ...structuredClone(item), ...structuredClone(patch), revision: item.revision + 1, updatedAt: patch.updatedAt ?? new Date().toISOString() };
}
