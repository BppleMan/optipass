import {
    ActionKind,
    ArchiveItemAction,
    BackendCapabilities,
    BackendMutationResult,
    CanonicalItem,
    CreateItemAction,
    DeleteItemAction,
    ExecutionMode,
    InMemoryItemStore,
    ItemAction,
    ItemBackend,
    ItemProvider,
    ItemStore,
    ItemStoreSnapshot,
    StoreState,
    UpdateItemAction,
} from "@optimize-password/core";

export interface ItemBackendResolver {
    get(provider: ItemProvider): ItemBackend;
}

export interface ItemRepositoryMutationResult {
    mutation: BackendMutationResult;
    resultingVersion: number;
}

export class ItemRepositoryService {
    public constructor(
        private readonly backends: ItemBackendResolver,
        private readonly store: ItemStore = new InMemoryItemStore(),
    ) {
    }

    public getStore(): ItemStore {
        return this.store;
    }

    public replace(provider: ItemProvider, items: CanonicalItem[], containers: CanonicalItem["container"][]): ItemStoreSnapshot {
        const snapshot: ItemStoreSnapshot = {
            snapshotId: globalThis.crypto.randomUUID(),
            version: 1,
            state: StoreState.Ready,
            createdAt: new Date().toISOString(),
            sourceProvider: provider,
            items,
            containers,
        };
        this.store.replaceAll(snapshot);
        return this.store.createSnapshot();
    }

    public supportsReal(action: ItemAction): boolean {
        return supportsAction(this.backends.get(action.provider).getCapabilities(), action.kind);
    }

    public async apply(action: ItemAction, targetStore: ItemStore, mode: ExecutionMode): Promise<ItemRepositoryMutationResult> {
        try {
            const expectedVersion = targetStore.getVersion();
            const backend = this.backends.get(action.provider);
            const mutation = mode === ExecutionMode.DryRun
                ? await backend.simulate(action, targetStore)
                : await this.writeThrough(backend, action, targetStore);
            applyMutation(targetStore, mutation, expectedVersion);
            return { mutation, resultingVersion: targetStore.getVersion() };
        } catch (error) {
            if (mode === ExecutionMode.Real && targetStore.getState() === StoreState.Ready) {
                const message = error instanceof Error ? error.message : String(error);
                targetStore.markStale(`后端同步结果无法确认：${ message }`);
            }
            throw error;
        }
    }

    public clear(): void {
        this.store.clear();
    }

    private async writeThrough(backend: ItemBackend, action: ItemAction, targetStore: ItemStore): Promise<BackendMutationResult> {
        const mutation = await executeBackendMutation(backend, action, targetStore);
        const verification = await backend.verify({ action, mutation });
        if (!verification.ok) {
            throw new Error(verification.message);
        }
        return mutation;
    }
}

async function executeBackendMutation(backend: ItemBackend, action: ItemAction, store: ItemStore): Promise<BackendMutationResult> {
    if (action instanceof CreateItemAction) return backend.create(action.command, store.getRequired(action.command.sourceItemId));
    if (action instanceof UpdateItemAction) return backend.update(action.command, store.getRequired(action.command.itemId));
    if (action instanceof ArchiveItemAction) return backend.archive(action.command, store.getRequired(action.command.itemId));
    if (action instanceof DeleteItemAction) return backend.delete(action.command, store.getRequired(action.command.itemId));
    return {};
}

function applyMutation(store: ItemStore, mutation: BackendMutationResult, expectedVersion: number): void {
    let nextExpectedVersion = expectedVersion;
    if (mutation.createdItem) {
        store.create(mutation.createdItem, nextExpectedVersion);
        nextExpectedVersion += 1;
    }
    if (mutation.updatedItem) {
        const item = mutation.updatedItem;
        store.update(item.id, {
            title: item.title,
            container: item.container,
            lifecycleState: item.lifecycleState,
            tags: item.tags,
            updatedAt: item.updatedAt,
        }, nextExpectedVersion);
        nextExpectedVersion += 1;
    }
    if (mutation.removedItemId) {
        store.remove(mutation.removedItemId, nextExpectedVersion);
    }
}

function supportsAction(capabilities: BackendCapabilities, kind: ActionKind): boolean {
    switch (kind) {
        case ActionKind.Keep:
            return true;
        case ActionKind.Create:
            return capabilities.supportsCreate;
        case ActionKind.Update:
            return capabilities.supportsUpdate;
        case ActionKind.Archive:
            return capabilities.supportsArchive;
        case ActionKind.Delete:
            return capabilities.supportsDelete;
    }
}
