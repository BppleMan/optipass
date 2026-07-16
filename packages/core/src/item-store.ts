import {
    CanonicalItem,
    ItemLookupResult,
    ItemLifecycleState,
    ItemMutationReceipt,
    ItemPatch,
    ItemProvider,
    ItemStoreSnapshot,
    StoreState,
} from "./domain.js";

export interface ItemStore {
    getState(): StoreState;
    getVersion(): number;
    getSnapshotId(): string;
    getSourceProvider(): ItemProvider;
    getRequired(itemId: string): CanonicalItem;
    tryGet(itemId: string): ItemLookupResult;
    list(): CanonicalItem[];
    listActive(): CanonicalItem[];
    replaceAll(snapshot: ItemStoreSnapshot): void;
    create(item: CanonicalItem, expectedVersion: number): ItemMutationReceipt;
    update(itemId: string, patch: ItemPatch, expectedVersion: number): ItemMutationReceipt;
    remove(itemId: string, expectedVersion: number): ItemMutationReceipt;
    createSnapshot(): ItemStoreSnapshot;
    fork(): ItemStore;
    markStale(reason: string): void;
    getStaleReason(): string;
    clear(): void;
}

export class InMemoryItemStore implements ItemStore {
    private snapshotId: string = globalThis.crypto.randomUUID();
    private version = 0;
    private state = StoreState.Empty;
    private sourceProvider = ItemProvider.OnePassword;
    private staleReason = "";
    private readonly items = new Map<string, CanonicalItem>();
    private containers: ItemStoreSnapshot["containers"] = [];

    public getState(): StoreState {
        return this.state;
    }

    public getVersion(): number {
        return this.version;
    }

    public getSnapshotId(): string {
        return this.snapshotId;
    }

    public getSourceProvider(): ItemProvider {
        return this.sourceProvider;
    }

    public getRequired(itemId: string): CanonicalItem {
        const item = this.items.get(itemId);
        if (!item) {
            throw new Error(`Item Store 中不存在 item：${ itemId }`);
        }
        return clone(item);
    }

    public tryGet(itemId: string): ItemLookupResult {
        const item = this.items.get(itemId);
        return item ? { found: true, item: clone(item) } : { found: false };
    }

    public list(): CanonicalItem[] {
        return Array.from(this.items.values(), clone);
    }

    public listActive(): CanonicalItem[] {
        return this.list().filter((item) => item.lifecycleState === ItemLifecycleState.Active);
    }

    public replaceAll(snapshot: ItemStoreSnapshot): void {
        this.items.clear();
        for (const item of snapshot.items) {
            this.items.set(item.id, clone(item));
        }
        this.snapshotId = snapshot.snapshotId;
        this.version = snapshot.version;
        this.state = snapshot.state;
        this.sourceProvider = snapshot.sourceProvider;
        this.containers = clone(snapshot.containers);
        this.staleReason = "";
    }

    public create(item: CanonicalItem, expectedVersion: number): ItemMutationReceipt {
        this.assertWritable(expectedVersion);
        if (this.items.has(item.id)) {
            throw new Error(`Item Store 已存在 item：${ item.id }`);
        }
        const createdItem = { ...clone(item), revision: Math.max(1, item.revision) };
        this.items.set(createdItem.id, createdItem);
        this.version += 1;
        return { createdItem: clone(createdItem), resultingVersion: this.version };
    }

    public update(itemId: string, patch: ItemPatch, expectedVersion: number): ItemMutationReceipt {
        this.assertWritable(expectedVersion);
        const current = this.getRequired(itemId);
        const updatedItem: CanonicalItem = {
            ...current,
            ...clone(patch),
            revision: current.revision + 1,
        };
        this.items.set(itemId, updatedItem);
        this.version += 1;
        return { sourceItemId: itemId, updatedItem: clone(updatedItem), resultingVersion: this.version };
    }

    public remove(itemId: string, expectedVersion: number): ItemMutationReceipt {
        this.assertWritable(expectedVersion);
        if (!this.items.delete(itemId)) {
            throw new Error(`Item Store 中不存在 item：${ itemId }`);
        }
        this.version += 1;
        return { sourceItemId: itemId, removedItemId: itemId, resultingVersion: this.version };
    }

    public createSnapshot(): ItemStoreSnapshot {
        return {
            snapshotId: this.snapshotId,
            version: this.version,
            state: this.state,
            createdAt: new Date().toISOString(),
            sourceProvider: this.sourceProvider,
            items: this.list(),
            containers: clone(this.containers),
        };
    }

    public fork(): ItemStore {
        const fork = new InMemoryItemStore();
        fork.replaceAll(this.createSnapshot());
        return fork;
    }

    public markStale(reason: string): void {
        this.state = StoreState.Stale;
        this.staleReason = reason;
    }

    public getStaleReason(): string {
        return this.staleReason;
    }

    public clear(): void {
        this.items.clear();
        this.containers = [];
        this.snapshotId = globalThis.crypto.randomUUID();
        this.version = 0;
        this.state = StoreState.Empty;
        this.staleReason = "";
    }

    private assertWritable(expectedVersion: number): void {
        if (this.state === StoreState.Empty) {
            throw new Error("Item Store 尚未装载扫描快照。");
        }
        if (this.state === StoreState.Stale) {
            throw new Error(`Item Store 已失效：${ this.staleReason || "请重新扫描" }`);
        }
        if (expectedVersion !== this.version) {
            throw new Error(`Item Store 版本冲突：期望 ${ expectedVersion }，当前 ${ this.version }`);
        }
    }
}

function clone<T>(value: T): T {
    return structuredClone(value);
}
