import {
    ExecutionMode,
    ItemProvider,
    StoreState,
    UpdateItemAction,
    VerificationSeverity,
} from "@optimize-password/core";
import { describe, expect, it, vi } from "vitest";
import { createApplicationServices } from "./item-services.js";
import { MockItemBackend } from "./mock-backend.js";

describe("ItemRepositoryService", () => {
    it("从 Store 读取当前 Item 并把后端写回结果提交回同一个 Store", async () => {
        const backend = new MockItemBackend();
        const services = createApplicationServices([backend]);
        await services.synchronization.synchronize(ItemProvider.Mock, "mock");
        const item = services.itemRepository.getStore().listActive()[0];
        const update = vi.spyOn(backend, "update");
        const action = new UpdateItemAction(
            "update-1",
            "group-1",
            item.id,
            ItemProvider.Mock,
            0,
            [],
            { label: "修改标题", detail: "Repository 写回" },
            { itemId: item.id, patch: { title: "Repository title" } },
        );

        await services.itemRepository.apply(action, services.itemRepository.getStore(), ExecutionMode.Real);

        expect(update).toHaveBeenCalledWith(action.command, expect.objectContaining({ id: item.id, title: item.title }));
        expect(services.itemRepository.getStore().getRequired(item.id).title).toBe("Repository title");
    });

    it("后端结果无法确认时不提交内存变更并把 Store 标记为 stale", async () => {
        const backend = new MockItemBackend();
        const services = createApplicationServices([backend]);
        await services.synchronization.synchronize(ItemProvider.Mock, "mock");
        const item = services.itemRepository.getStore().listActive()[0];
        vi.spyOn(backend, "verify").mockResolvedValue({
            ok: false,
            severity: VerificationSeverity.Critical,
            message: "外部状态无法确认",
        });
        const action = new UpdateItemAction(
            "update-2",
            "group-1",
            item.id,
            ItemProvider.Mock,
            0,
            [],
            { label: "修改标题", detail: "Repository 写回" },
            { itemId: item.id, patch: { title: "Unconfirmed title" } },
        );

        await expect(services.itemRepository.apply(action, services.itemRepository.getStore(), ExecutionMode.Real))
            .rejects.toThrow("外部状态无法确认");

        expect(services.itemRepository.getStore().getRequired(item.id).title).toBe(item.title);
        expect(services.itemRepository.getStore().getState()).toBe(StoreState.Stale);
    });

    it("后端写回期间 Store 版本变化时拒绝覆盖并标记 stale", async () => {
        const backend = new MockItemBackend();
        const services = createApplicationServices([backend]);
        await services.synchronization.synchronize(ItemProvider.Mock, "mock");
        const store = services.itemRepository.getStore();
        const item = store.listActive()[0];
        let releaseBackend!: () => void;
        const backendGate = new Promise<void>((resolve) => { releaseBackend = resolve; });
        vi.spyOn(backend, "update").mockImplementation(async (command, currentItem) => {
            await backendGate;
            return { updatedItem: { ...currentItem, ...command.patch, revision: currentItem.revision + 1 } };
        });
        const action = new UpdateItemAction(
            "update-concurrent",
            "group-1",
            item.id,
            ItemProvider.Mock,
            0,
            [],
            { label: "修改标题", detail: "并发版本保护" },
            { itemId: item.id, patch: { title: "Backend title" } },
        );

        const applying = services.itemRepository.apply(action, store, ExecutionMode.Real);
        await Promise.resolve();
        store.update(item.id, { title: "Concurrent title" }, store.getVersion());
        releaseBackend();

        await expect(applying).rejects.toThrow("版本冲突");
        expect(store.getRequired(item.id).title).toBe("Concurrent title");
        expect(store.getState()).toBe(StoreState.Stale);
    });
});
