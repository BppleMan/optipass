import { describe, expect, it } from "vitest";
import { ItemCategory, ItemLifecycleState, ItemProvider, StoreState } from "./domain.js";
import { InMemoryItemStore } from "./item-store.js";

describe("InMemoryItemStore", () => {
    it("递增版本并拒绝旧版本写入", () => {
        const store = readyStore();
        const version = store.getVersion();
        store.update("mock:test:1", { title: "New" }, version);
        expect(store.getVersion()).toBe(version + 1);
        expect(() => store.update("mock:test:1", { title: "Stale" }, version)).toThrow("版本冲突");
    });

    it("fork 深复制且不污染正式 Store", () => {
        const store = readyStore();
        const fork = store.fork();
        fork.update("mock:test:1", { title: "Fork" }, fork.getVersion());
        expect(fork.getRequired("mock:test:1").title).toBe("Fork");
        expect(store.getRequired("mock:test:1").title).toBe("Original");
    });

    it("stale 状态禁止写入", () => {
        const store = readyStore();
        store.markStale("external verification failed");
        expect(store.getState()).toBe(StoreState.Stale);
        expect(() => store.remove("mock:test:1", store.getVersion())).toThrow("已失效");
    });

    it("支持创建、查询、快照和删除的完整生命周期", () => {
        const store = readyStore();
        const created = {
            ...store.getRequired("mock:test:1"),
            id: "mock:test:2",
            source: { provider: ItemProvider.Mock, accountId: "test", externalItemId: "2" },
        };

        store.create(created, store.getVersion());
        expect(store.tryGet(created.id)).toEqual({ found: true, item: created });
        expect(store.createSnapshot().items.map((item) => item.id)).toEqual(["mock:test:1", "mock:test:2"]);

        store.remove(created.id, store.getVersion());
        expect(store.tryGet(created.id)).toEqual({ found: false });
    });

    it("clear 清除 Item、容器和可写状态", () => {
        const store = readyStore();

        store.clear();

        expect(store.getState()).toBe(StoreState.Empty);
        expect(store.getVersion()).toBe(0);
        expect(store.list()).toEqual([]);
        expect(store.createSnapshot().containers).toEqual([]);
    });
});

function readyStore(): InMemoryItemStore {
    const store = new InMemoryItemStore();
    const container = { provider: ItemProvider.Mock, accountId: "test", containerId: "vault", name: "Vault" };
    store.replaceAll({ snapshotId: "snapshot", version: 1, state: StoreState.Ready, createdAt: new Date().toISOString(),
        sourceProvider: ItemProvider.Mock, containers: [container], items: [{
            id: "mock:test:1", source: { provider: ItemProvider.Mock, accountId: "test", externalItemId: "1" }, container,
            revision: 1, lifecycleState: ItemLifecycleState.Active, category: ItemCategory.Login, title: "Original",
            identities: [], urls: [], tags: [], sections: [], fields: [], attachments: [], capabilities: [],
        }] });
    return store;
}
