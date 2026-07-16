import { describe, expect, it } from "vitest";
import {
    ActionMappingRequest,
    ActionMappingResult,
    BackendCapabilities,
    BackendMutationResult,
    BackendReadRequest,
    BackendReadResult,
    BackendVerificationRequest,
    BackendVerificationResult,
    ItemBackend,
    KeepItemAction,
    UpdateItemAction,
} from "./action-model.js";
import { ItemCategory, ItemDisposition, ItemLifecycleState, ItemProvider, StoreState, VerificationSeverity } from "./domain.js";
import { InMemoryItemStore } from "./item-store.js";
import { ActionPlanningService } from "./plan.js";

describe("ActionPlanningService", () => {
    it("按 provider 映射用户意图并返回真实步骤", async () => {
        const store = createStore();
        const backend = new FakeBackend();
        const service = new ActionPlanningService(store, { get: () => backend });
        const snapshot = store.createSnapshot();
        const plan = await service.createPlan({
            storeSnapshotId: snapshot.snapshotId,
            storeVersion: snapshot.version,
            groups: [{
                groupId: "group-1",
                items: [
                    { itemId: "mock:test:1", disposition: ItemDisposition.Keep, removeTags: [] },
                    { itemId: "mock:test:2", disposition: ItemDisposition.Archive, removeTags: [] },
                ],
            }],
        }, [{ id: "group-1", itemIds: ["mock:test:1", "mock:test:2"], reasons: [], recommendedKeepIds: [], recommendedKeepReasons: [] }]);

        expect(backend.mappedItemIds).toEqual(["mock:test:1", "mock:test:2"]);
        expect(backend.mappedSnapshots[0]).toBe(backend.mappedSnapshots[1]);
        expect(plan.groups[0].steps).toHaveLength(2);
        expect(plan.groups[0].steps.map((step) => step.sequence)).toEqual([0, 1]);
        expect(plan.planHash).toMatch(/^[0-9a-f]{64}$/);
        expect(plan.statistics).toEqual({ groupCount: 1, itemCount: 2, stepCount: 2, mutationStepCount: 0 });
        expect(plan.blockers).toEqual([]);
    });

    it("拒绝过期 Store 版本", async () => {
        const store = createStore();
        const service = new ActionPlanningService(store, { get: () => new FakeBackend() });
        await expect(service.createPlan({
            storeSnapshotId: store.getSnapshotId(),
            storeVersion: store.getVersion() - 1,
            groups: [],
        }, [])).rejects.toThrow("Item Store 已发生变化");
    });

    it("允许整组不保留并对永久删除要求显式确认", async () => {
        const store = createStore();
        const service = new ActionPlanningService(store, { get: () => new FakeBackend() });
        const plan = await service.createPlan({
            storeSnapshotId: store.getSnapshotId(),
            storeVersion: store.getVersion(),
            groups: [{ groupId: "group-1", items: [
                { itemId: "mock:test:1", disposition: ItemDisposition.Archive, removeTags: [] },
                { itemId: "mock:test:2", disposition: ItemDisposition.Delete, removeTags: [] },
            ] }],
        }, [{ id: "group-1", itemIds: ["mock:test:1", "mock:test:2"], reasons: [], recommendedKeepIds: [], recommendedKeepReasons: [] }]);
        expect(plan.blockers).toEqual([]);
        expect(plan.requiresExplicitDeleteConfirmation).toBe(true);
    });

    it("保留后端提供的原子移动步骤而不硬编码 1Password 两步迁移", async () => {
        const store = createStore();
        const service = new ActionPlanningService(store, { get: () => new AtomicMoveBackend() });
        const plan = await service.createPlan({
            storeSnapshotId: store.getSnapshotId(),
            storeVersion: store.getVersion(),
            groups: [{
                groupId: "group-1",
                items: [{
                    itemId: "mock:test:1",
                    disposition: ItemDisposition.Keep,
                    targetContainerId: "target-vault",
                    removeTags: [],
                }],
            }],
        }, [{ id: "group-1", itemIds: ["mock:test:1"], reasons: [], recommendedKeepIds: [], recommendedKeepReasons: [] }]);

        expect(plan.groups[0].steps).toHaveLength(1);
        expect(plan.groups[0].items[0].actions[0]).toBeInstanceOf(UpdateItemAction);
    });
});

class FakeBackend implements ItemBackend {
    public readonly mappedItemIds: string[] = [];
    public readonly mappedSnapshots: ActionMappingRequest["snapshot"][] = [];
    public getProvider(): ItemProvider { return ItemProvider.Mock; }
    public getCapabilities(): BackendCapabilities { return { supportsCreate: true, supportsUpdate: true, supportsArchive: true, supportsDelete: true,
        supportsAtomicContainerChange: true, supportsCopy: true, supportsAttachments: true, supportsPasskeys: true, supportsSecretFields: true }; }
    public async readAll(_request: BackendReadRequest): Promise<BackendReadResult> { throw new Error("unused"); }
    public async create(): Promise<BackendMutationResult> { return {}; }
    public async update(): Promise<BackendMutationResult> { return {}; }
    public async archive(): Promise<BackendMutationResult> { return {}; }
    public async delete(): Promise<BackendMutationResult> { return {}; }
    public async verify(_request: BackendVerificationRequest): Promise<BackendVerificationResult> {
        return { ok: true, severity: VerificationSeverity.Incomplete, message: "ok" };
    }
    public async map(request: ActionMappingRequest): Promise<ActionMappingResult> {
        this.mappedItemIds.push(request.item.id);
        this.mappedSnapshots.push(request.snapshot);
        return { actions: [new KeepItemAction(request.item.id, request.groupId, request.item.id, ItemProvider.Mock, request.startingSequence,
            { label: request.item.title, detail: "test" })], blockers: [], warnings: [], affectedItemIds: [request.item.id] };
    }
    public async simulate(): Promise<BackendMutationResult> { return {}; }
    public clearSession(): void {}
}

class AtomicMoveBackend extends FakeBackend {
    public override async map(request: ActionMappingRequest): Promise<ActionMappingResult> {
        return {
            actions: [new UpdateItemAction(
                "atomic-move",
                request.groupId,
                request.item.id,
                ItemProvider.Mock,
                request.startingSequence,
                [],
                { label: "移动 item", detail: "后端原子修改容器" },
                { itemId: request.item.id, patch: { container: { ...request.item.container, containerId: "target-vault" } } },
            )],
            blockers: [],
            warnings: [],
            affectedItemIds: [request.item.id],
        };
    }
}

function createStore(): InMemoryItemStore {
    const store = new InMemoryItemStore();
    const container = { provider: ItemProvider.Mock, accountId: "test", containerId: "vault", name: "Vault" };
    store.replaceAll({
        snapshotId: "snapshot-1", version: 1, state: StoreState.Ready, createdAt: new Date().toISOString(), sourceProvider: ItemProvider.Mock,
        containers: [container], items: ["1", "2"].map((id) => ({
            id: `mock:test:${ id }`, source: { provider: ItemProvider.Mock, accountId: "test", externalItemId: id }, container,
            revision: 1, lifecycleState: ItemLifecycleState.Active, category: ItemCategory.Login, title: "A", identities: [], urls: [], tags: [],
            sections: [], fields: [], attachments: [], capabilities: [],
        })),
    });
    return store;
}
