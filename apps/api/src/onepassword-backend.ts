import { randomUUID } from "node:crypto";
import {
    ActionKind,
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
    ItemCategory,
    ItemDisposition,
    ItemFieldKind,
    ItemFieldSensitivity,
    ItemIdentityKind,
    ItemLifecycleState,
    ItemPatch,
    ItemProvider,
    ItemStore,
    KeepItemAction,
    StoreState,
    UpdateItemAction,
    UpdateItemCommand,
    VerificationSeverity,
} from "@optimize-password/core";
import { OnePasswordService, toAppItemId } from "./onepassword.js";

export class OnePasswordItemBackend implements ItemBackend {
    private readonly containers = new Map<string, CanonicalItem["container"]>();

    public constructor(private readonly delegate: OnePasswordService) {
    }

    public getProvider(): ItemProvider {
        return ItemProvider.OnePassword;
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
        const scan = await this.delegate.scan({
            accountName: request.accountName,
            serviceAccountToken: request.serviceAccountToken,
            onProgress: (event) => request.onProgress?.(event.progress.message ?? "", event.progress.scannedItems, event.progress),
        });
        const accountId = request.accountId || request.accountName || "default";
        const containers = scan.vaults.map((vault) => ({
            provider: ItemProvider.OnePassword,
            accountId,
            containerId: vault.id,
            name: vault.name,
        }));
        const containerById = new Map(containers.map((container) => [container.containerId, container]));
        this.containers.clear();
        for (const container of containers) this.containers.set(container.containerId, structuredClone(container));
        const items = scan.items.map((item) => toCanonicalItem(
            item,
            accountId,
            containerById.get(item.vaultId)!,
            this.delegate.canonicalMaterial(item.id),
        ));
        return { provider: ItemProvider.OnePassword, accountId, items, containers };
    }

    public async create(command: CreateItemCommand, source: CanonicalItem): Promise<BackendMutationResult> {
        const result = await this.delegate.copyToVault(
            toAppItemId(source.container.containerId, source.source.externalItemId),
            command.targetContainerId,
            command.removeTags,
            command.desiredTitle,
        );
        const createdItem: CanonicalItem = {
            ...structuredClone(source),
            id: canonicalItemId(ItemProvider.OnePassword, source.source.accountId, result.createdItemId),
            source: { ...source.source, externalItemId: result.createdItemId },
            container: structuredClone(this.containers.get(command.targetContainerId) ?? { ...source.container, containerId: command.targetContainerId }),
            revision: 1,
            title: command.desiredTitle ?? source.title,
            tags: source.tags.filter((tag) => !command.removeTags.includes(tag)),
            updatedAt: new Date().toISOString(),
        };
        return { createdItem };
    }

    public async update(command: UpdateItemCommand, item: CanonicalItem): Promise<BackendMutationResult> {
        const appItemId = toAppItemId(item.container.containerId, item.source.externalItemId);
        await this.delegate.updateItem(appItemId, command.patch);
        const updatedItem = applyPatch(item, command.patch);
        return { updatedItem };
    }

    public async archive(command: ArchiveItemCommand, item: CanonicalItem): Promise<BackendMutationResult> {
        await this.delegate.archive(item.container.containerId, item.source.externalItemId);
        const updatedItem = applyPatch(item, { lifecycleState: ItemLifecycleState.Archived });
        return { updatedItem };
    }

    public async delete(command: DeleteItemCommand, item: CanonicalItem): Promise<BackendMutationResult> {
        await this.delegate.delete(item.container.containerId, item.source.externalItemId);
        return { removedItemId: item.id };
    }

    public async verify(request: BackendVerificationRequest): Promise<BackendVerificationResult> {
        if (request.action.kind === ActionKind.Delete && request.mutation.removedItemId) {
            return { ok: true, severity: VerificationSeverity.Incomplete, message: "删除操作已由 1Password SDK 确认。" };
        }
        const item = request.mutation.createdItem ?? request.mutation.updatedItem;
        if (!item) {
            return { ok: false, severity: VerificationSeverity.Critical, message: "1Password 操作没有返回规范 Item。" };
        }
        return { ok: true, severity: VerificationSeverity.Incomplete, message: "1Password 操作已完成。" };
    }

    public async map(request: ActionMappingRequest): Promise<ActionMappingResult> {
        const { draft, groupId, item } = request;
        const actions: ItemAction[] = [];
        const blockers: string[] = [];
        const warnings: string[] = [];
        let sequence = request.startingSequence;
        const targetContainerId = draft.targetContainerId ?? item.container.containerId;
        const desiredTitle = draft.desiredTitle?.trim();
        const tags = item.tags.filter((tag) => !draft.removeTags.includes(tag));

        if (draft.disposition === ItemDisposition.Keep && targetContainerId !== item.container.containerId) {
            if (!request.snapshot.containers.some((container) => container.containerId === targetContainerId &&
                container.provider === item.source.provider && container.accountId === item.source.accountId)) {
                blockers.push(`目标保险库不存在或不属于当前账户：${ targetContainerId }`);
                return { actions, blockers, warnings, affectedItemIds: [item.id] };
            }
            if (item.fields.some((field) => field.kind === ItemFieldKind.Passkey)) {
                blockers.push(`含 Passkey 的 item 不支持跨保险库迁移：${ item.title }`);
            }
            const createId = randomUUID();
            actions.push(new CreateItemAction(
                createId,
                groupId,
                item.id,
                ItemProvider.OnePassword,
                sequence++,
                [],
                { label: `复制「${ item.title }」`, detail: "复制到目标保险库", sourceLabel: item.container.name, targetLabel: targetContainerId },
                { sourceItemId: item.id, targetContainerId, desiredTitle, removeTags: draft.removeTags },
            ));
            actions.push(new ArchiveItemAction(
                randomUUID(),
                groupId,
                item.id,
                ItemProvider.OnePassword,
                sequence++,
                [createId],
                { label: `归档原 item「${ item.title }」`, detail: "目标副本创建成功后归档源 item", sourceLabel: item.container.name },
                { itemId: item.id },
            ));
            warnings.push("1Password 跨保险库迁移会先创建副本，再归档原 item。");
        } else if (draft.disposition === ItemDisposition.Keep && ((desiredTitle && desiredTitle !== item.title) || tags.length !== item.tags.length)) {
            const patch: ItemPatch = { tags };
            if (desiredTitle && desiredTitle !== item.title) {
                patch.title = desiredTitle;
            }
            actions.push(new UpdateItemAction(
                randomUUID(), groupId, item.id, ItemProvider.OnePassword, sequence++, [],
                { label: `更新「${ item.title }」`, detail: "修改标题或标签", sourceLabel: item.container.name },
                { itemId: item.id, patch },
            ));
        } else if (draft.disposition === ItemDisposition.Keep) {
            actions.push(new KeepItemAction(randomUUID(), groupId, item.id, ItemProvider.OnePassword, sequence++, {
                label: `保留「${ item.title }」`, detail: "不修改 item", sourceLabel: item.container.name,
            }));
        } else if (draft.disposition === ItemDisposition.Delete) {
            actions.push(new DeleteItemAction(
                randomUUID(), groupId, item.id, ItemProvider.OnePassword, sequence++, [],
                { label: `永久删除「${ item.title }」`, detail: "从 1Password 永久删除", sourceLabel: item.container.name },
                { itemId: item.id },
            ));
        } else {
            actions.push(new ArchiveItemAction(
                randomUUID(), groupId, item.id, ItemProvider.OnePassword, sequence++, [],
                { label: `归档「${ item.title }」`, detail: "移动到 1Password 归档", sourceLabel: item.container.name },
                { itemId: item.id },
            ));
        }
        return { actions, blockers, warnings, affectedItemIds: [item.id] };
    }

    public async simulate(step: import("@optimize-password/core").ItemAction, store: ItemStore): Promise<BackendMutationResult> {
        if (step instanceof CreateItemAction) {
            const source = store.getRequired(step.command.sourceItemId);
            const createdItem: CanonicalItem = {
                ...structuredClone(source),
                id: canonicalItemId(source.source.provider, source.source.accountId, `dry-run-${ step.actionId }`),
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
        this.containers.clear();
        this.delegate.clearCache();
    }
}

export function canonicalItemId(provider: ItemProvider, accountId: string, externalItemId: string): string {
    return `${ provider }:${ accountId }:${ externalItemId }`;
}

function toCanonicalItem(
    item: import("@optimize-password/core").ItemSummary,
    accountId: string,
    container: CanonicalItem["container"],
    material: import("./onepassword.js").OnePasswordCanonicalMaterial,
): CanonicalItem {
    const hasPasskey = material.fields.some((field) => field.kind === ItemFieldKind.Passkey);
    const capabilities = [
        ItemCapability.Update,
        ItemCapability.Archive,
        ItemCapability.Delete,
        ItemCapability.RevealSecret,
    ];
    if (!hasPasskey) {
        capabilities.push(ItemCapability.ChangeContainer, ItemCapability.Copy);
    }
    return {
        id: canonicalItemId(ItemProvider.OnePassword, accountId, item.onePasswordItemId),
        source: { provider: ItemProvider.OnePassword, accountId, externalItemId: item.onePasswordItemId },
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
        sections: material.sections,
        fields: material.fields.map((field) => {
            const comparable = item.comparableFields.find((candidate) => candidate.label === field.label);
            return { ...field, normalizedValue: comparable?.normalizedValue, normalizedValueHash: comparable?.normalizedValueHash };
        }),
        attachments: material.attachments.map((attachment) => ({
            ...attachment,
            sourceReference: { provider: ItemProvider.OnePassword, accountId, externalItemId: item.onePasswordItemId },
        })),
        capabilities,
    };
}

function comparableKind(kind: string): ItemFieldKind {
    return Object.values(ItemFieldKind).includes(kind as ItemFieldKind) ? kind as ItemFieldKind : ItemFieldKind.Unknown;
}

function applyPatch(item: CanonicalItem, patch: ItemPatch): CanonicalItem {
    return { ...structuredClone(item), ...structuredClone(patch), revision: item.revision + 1, updatedAt: patch.updatedAt ?? new Date().toISOString() };
}
