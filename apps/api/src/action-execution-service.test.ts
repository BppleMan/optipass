import { describe, expect, it, vi } from "vitest";
import {
    ActionExecutionStatus,
    DryRunSpeedMultiplier,
    ExecutionMode,
    ItemDisposition,
    ItemProvider,
    StoreState,
} from "@optimize-password/core";
import { ActionExecutionControl } from "./action-execution-service.js";
import { CsvItemBackend } from "./csv-backend.js";
import { createApplicationServices } from "./item-services.js";
import { MockItemBackend } from "./mock-backend.js";

const csv = [
    "Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes",
    "Example,https://example.com,user@example.com,***,,false,false,,",
    "Example copy,https://example.com,user@example.com,***,,false,false,,",
].join("\n");

describe("ActionExecutionService", () => {
    it("dry-run 修改 fork 并保留正式 Store", async () => {
        const services = createApplicationServices([new CsvItemBackend()]);
        await services.synchronization.synchronize(ItemProvider.Csv, "export.csv", undefined, undefined, undefined, "export.csv", csv);
        const analysis = services.analysis.analyze(services.itemRepository.getStore());
        const group = analysis.groups[0];
        const snapshot = services.itemRepository.getStore().createSnapshot();
        const plan = await services.planning.createPlan({
            storeSnapshotId: snapshot.snapshotId,
            storeVersion: snapshot.version,
            groups: [{ groupId: group.id, items: [
                { itemId: group.itemIds[0], disposition: ItemDisposition.Keep, removeTags: [] },
                { itemId: group.itemIds[1], disposition: ItemDisposition.Delete, removeTags: [] },
            ] }],
        }, analysis.groups);

        const result = await services.execution.execute({
            executionId: "dry-1",
            plan,
            mode: ExecutionMode.DryRun,
            dryRunSpeedMultiplier: DryRunSpeedMultiplier.Ten,
        });

        expect(result.succeeded).toBe(true);
        expect(result.analysis.items).toHaveLength(1);
        expect(services.itemRepository.getStore().listActive()).toHaveLength(2);
    });

    it("真实执行在调用 CSV CRUD 前被能力检查拒绝", async () => {
        const services = createApplicationServices([new CsvItemBackend()]);
        await services.synchronization.synchronize(ItemProvider.Csv, "export.csv", undefined, undefined, undefined, "export.csv", csv);
        const analysis = services.analysis.analyze(services.itemRepository.getStore());
        const group = analysis.groups[0];
        const snapshot = services.itemRepository.getStore().createSnapshot();
        const plan = await services.planning.createPlan({
            storeSnapshotId: snapshot.snapshotId,
            storeVersion: snapshot.version,
            groups: [{ groupId: group.id, items: [
                { itemId: group.itemIds[0], disposition: ItemDisposition.Keep, removeTags: [] },
                { itemId: group.itemIds[1], disposition: ItemDisposition.Archive, removeTags: [] },
            ] }],
        }, analysis.groups);

        await expect(services.execution.execute({ executionId: "real-1", plan, mode: ExecutionMode.Real }))
            .rejects.toThrow("CSV Backend 不支持真实归档");
        expect(services.itemRepository.getStore().listActive()).toHaveLength(2);
    });

    it("复制成功但归档失败时保留 Store 的实际结果并重新分析", async () => {
        const backend = new MockItemBackend();
        const services = createApplicationServices([backend]);
        await services.synchronization.synchronize(ItemProvider.Mock, "mock");
        const store = services.itemRepository.getStore();
        const analysis = services.analysis.analyze(store);
        const group = analysis.groups[0];
        const source = store.getRequired(group.itemIds[0]);
        const target = store.createSnapshot().containers.find((container) => container.containerId !== source.container.containerId)!;
        const activeCount = store.listActive().length;
        const snapshot = store.createSnapshot();
        const plan = await services.planning.createPlan({
            storeSnapshotId: snapshot.snapshotId,
            storeVersion: snapshot.version,
            groups: [{
                groupId: group.id,
                items: group.itemIds.map((itemId, index) => ({
                    itemId,
                    disposition: ItemDisposition.Keep,
                    targetContainerId: index === 0 ? target.containerId : undefined,
                    removeTags: [],
                })),
            }],
        }, analysis.groups);
        vi.spyOn(backend, "archive").mockRejectedValue(new Error("归档源 item 失败"));

        const result = await services.execution.execute({ executionId: "partial-real", plan, mode: ExecutionMode.Real });

        expect(result.succeeded).toBe(false);
        expect(store.listActive()).toHaveLength(activeCount + 1);
        expect(result.itemIdMappings[source.id]).toBeTruthy();
        expect(store.getState()).toBe(StoreState.Stale);
        expect(result.analysis.items.map((item) => item.id)).toContain(result.itemIdMappings[source.id]);
    });

    it.each([
        { multiplier: DryRunSpeedMultiplier.One, waitMs: 0 },
        { multiplier: DryRunSpeedMultiplier.Five, waitMs: 200 },
        { multiplier: DryRunSpeedMultiplier.Ten, waitMs: 400 },
    ])("dry-run $multiplier x 档位在步骤后等待 $waitMs ms", async ({ multiplier, waitMs }) => {
        vi.useFakeTimers();
        try {
            const services = createApplicationServices([new CsvItemBackend()]);
            await services.synchronization.synchronize(ItemProvider.Csv, "export.csv", undefined, undefined, undefined, "export.csv", csv);
            const analysis = services.analysis.analyze(services.itemRepository.getStore());
            const group = analysis.groups[0];
            const snapshot = services.itemRepository.getStore().createSnapshot();
            const plan = await services.planning.createPlan({
                storeSnapshotId: snapshot.snapshotId,
                storeVersion: snapshot.version,
                groups: [{ groupId: group.id, items: [
                    { itemId: group.itemIds[0], disposition: ItemDisposition.Keep, removeTags: [] },
                    { itemId: group.itemIds[1], disposition: ItemDisposition.Delete, removeTags: [] },
                ] }],
            }, analysis.groups);

            const execution = services.execution.execute({
                executionId: "paced-dry-run",
                plan,
                mode: ExecutionMode.DryRun,
                dryRunSpeedMultiplier: multiplier,
            });
            let completed = false;
            void execution.then(() => { completed = true; });
            await vi.advanceTimersByTimeAsync(Math.max(0, waitMs - 1));
            expect(completed).toBe(waitMs === 0);
            await vi.advanceTimersByTimeAsync(waitMs === 0 ? 0 : 1);
            await expect(execution).resolves.toMatchObject({ succeeded: true });
        } finally {
            vi.useRealTimers();
        }
    });

    it("暂停会在步骤边界等待，恢复后继续同一计划", async () => {
        vi.useFakeTimers();
        try {
            const services = createApplicationServices([new CsvItemBackend()]);
            await services.synchronization.synchronize(ItemProvider.Csv, "export.csv", undefined, undefined, undefined, "export.csv", csv);
            const analysis = services.analysis.analyze(services.itemRepository.getStore());
            const group = analysis.groups[0];
            const snapshot = services.itemRepository.getStore().createSnapshot();
            const plan = await services.planning.createPlan({
                storeSnapshotId: snapshot.snapshotId,
                storeVersion: snapshot.version,
                groups: [{ groupId: group.id, items: [
                    { itemId: group.itemIds[0], disposition: ItemDisposition.Keep, removeTags: [] },
                    { itemId: group.itemIds[1], disposition: ItemDisposition.Delete, removeTags: [] },
                ] }],
            }, analysis.groups);
            const control = new ActionExecutionControl();
            control.pause();
            const execution = services.execution.execute({
                executionId: "pause-resume",
                plan,
                mode: ExecutionMode.DryRun,
                dryRunSpeedMultiplier: DryRunSpeedMultiplier.Ten,
                control,
            });
            let completed = false;
            void execution.then(() => { completed = true; });
            await vi.advanceTimersByTimeAsync(500);
            expect(completed).toBe(false);

            control.resume();
            await vi.advanceTimersByTimeAsync(400);
            await expect(execution).resolves.toMatchObject({ status: ActionExecutionStatus.Completed });
        } finally {
            vi.useRealTimers();
        }
    });

    it("停止请求会在下一步骤前结束且不修改目标 Store", async () => {
        const services = createApplicationServices([new CsvItemBackend()]);
        await services.synchronization.synchronize(ItemProvider.Csv, "export.csv", undefined, undefined, undefined, "export.csv", csv);
        const analysis = services.analysis.analyze(services.itemRepository.getStore());
        const group = analysis.groups[0];
        const snapshot = services.itemRepository.getStore().createSnapshot();
        const plan = await services.planning.createPlan({
            storeSnapshotId: snapshot.snapshotId,
            storeVersion: snapshot.version,
            groups: [{ groupId: group.id, items: [
                { itemId: group.itemIds[0], disposition: ItemDisposition.Keep, removeTags: [] },
                { itemId: group.itemIds[1], disposition: ItemDisposition.Delete, removeTags: [] },
            ] }],
        }, analysis.groups);
        const control = new ActionExecutionControl();
        control.stop();

        const result = await services.execution.execute({ executionId: "stop", plan, mode: ExecutionMode.DryRun, control });

        expect(result.status).toBe(ActionExecutionStatus.Stopped);
        expect(result.analysis.items).toHaveLength(2);
    });
});
