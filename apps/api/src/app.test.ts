import {
    ActionExecutionStatus,
    DryRunSpeedMultiplier,
    ExecutionMode,
    ItemDisposition,
    ItemProvider,
    StoreState,
    UpdateItemAction,
    type ScanResult,
    type ScanSnapshot,
} from "@optimize-password/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiServer } from "./app.js";
import { CsvItemBackend } from "./csv-backend.js";
import { ApplicationServices, createApplicationServices } from "./item-services.js";
import { MockItemBackend } from "./mock-backend.js";

const token = "test-session-token";
const headers = { "x-session-token": token, "x-tab-id": "tab-1" };

describe("canonical API workflow", () => {
    let app: Awaited<ReturnType<typeof createApiServer>>;
    let services: ApplicationServices;

    beforeEach(async () => {
        services = createApplicationServices([new MockItemBackend(), new CsvItemBackend()]);
        app = await createApiServer({
            config: {
                host: "127.0.0.1",
                port: 3417,
                sessionToken: token,
                webOrigins: ["http://127.0.0.1:4200"],
                enableMutations: false,
            },
            services,
            logger: false,
        });
    });

    afterEach(async () => {
        await app.close();
    });

    it("loads the Canonical Store and exposes canonical item ids", async () => {
        const analysis = await scanAndAnalyze(app, { provider: ItemProvider.Mock });

        expect(analysis.storeVersion).toBe(1);
        expect(analysis.items.length).toBeGreaterThan(0);
        expect(analysis.groups.length).toBeGreaterThan(0);
        expect(analysis.items.every((item) => item.id.startsWith(`${ ItemProvider.Mock }:`))).toBe(true);
        expect(analysis.items.every((item) => item.analysis === undefined)).toBe(true);
    });

    it("item 搜索直接读取 Store 当前事实而不是扫描 DTO 缓存", async () => {
        const analysis = await scanAndAnalyze(app, { provider: ItemProvider.Mock });
        const item = services.itemRepository.getStore().listActive()[0];
        const action = new UpdateItemAction(
            "update-search-title",
            analysis.groups[0].id,
            item.id,
            ItemProvider.Mock,
            0,
            [],
            { label: "更新标题", detail: "验证搜索事实源" },
            { itemId: item.id, patch: { title: "Store-only-search-title" } },
        );
        await services.itemRepository.apply(action, services.itemRepository.getStore(), ExecutionMode.Real);

        const response = await app.inject({
            method: "POST",
            url: "/api/items/search",
            headers,
            payload: { keywords: ["Store-only-search-title"], itemIds: analysis.items.map((candidate) => candidate.id) },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json().itemIds).toContain(item.id);
    });

    it("returns only DTO steps and never serializes backend action commands", async () => {
        const analysis = await scanAndAnalyze(app, { provider: ItemProvider.Mock });
        const draft = draftFor(analysis);

        const response = await app.inject({ method: "POST", url: "/api/plan", headers, payload: draft });

        expect(response.statusCode).toBe(200);
        const plan = response.json();
        expect(plan.storeSnapshotId).toBe(analysis.scanId);
        expect(plan.planHash).toMatch(/^[0-9a-f]{64}$/);
        expect(plan.statistics.groupCount).toBe(1);
        expect(plan.groups[0].steps.length).toBeGreaterThan(0);
        expect(plan.groups[0].items[0]).not.toHaveProperty("actions");
        expect(JSON.stringify(plan)).not.toContain("command");
    });

    it("拒绝用错误 hash 或其它 tab 启动已展开计划", async () => {
        const analysis = await scanAndAnalyze(app, { provider: ItemProvider.Mock });
        const plan = (await app.inject({ method: "POST", url: "/api/plan", headers, payload: draftFor(analysis) })).json();

        const wrongHash = await app.inject({
            method: "POST",
            url: "/api/action-executions/start",
            headers,
            payload: { planId: plan.planId, planHash: "b".repeat(64) },
        });
        const wrongTab = await app.inject({
            method: "POST",
            url: "/api/action-executions/start",
            headers: { ...headers, "x-tab-id": "tab-2" },
            payload: { planId: plan.planId, planHash: plan.planHash },
        });

        expect(wrongHash.statusCode).toBe(400);
        expect(wrongTab.statusCode).toBe(400);
    });

    it("executes the backend-expanded plan against a Store fork in dry-run mode", async () => {
        const analysis = await scanAndAnalyze(app, { provider: ItemProvider.Mock });
        const draft = draftFor(analysis);
        const plan = (await app.inject({ method: "POST", url: "/api/plan", headers, payload: draft })).json();
        const start = await app.inject({
            method: "POST",
            url: "/api/action-executions/start",
            headers,
            payload: { planId: plan.planId, planHash: plan.planHash, dryRunSpeedMultiplier: DryRunSpeedMultiplier.Ten },
        });

        expect(start.statusCode).toBe(200);
        expect(start.json().writeEnabled).toBe(false);
        expect(start.json().plan.planHash).toBe(plan.planHash);
        expect(start.json().plan.groups[0].steps.map((step: { actionId: string }) => step.actionId))
            .toEqual(plan.groups[0].steps.map((step: { actionId: string }) => step.actionId));
        expect(start.json().plan.groups[0].steps.length).toBeGreaterThan(0);
        await vi.waitFor(async () => {
            const snapshot = await app.inject({
                method: "GET",
                url: `/api/action-executions/${ start.json().executionId }`,
                headers,
            });
            expect(snapshot.json().status).toBe(ActionExecutionStatus.Completed);
        });

        const formal = await app.inject({ method: "GET", url: "/api/analysis", headers });
        expect(formal.statusCode).toBe(200);
        expect(formal.json().storeVersion).toBe(analysis.storeVersion);
        expect(formal.json().groups).toEqual(analysis.groups);
    });

    it("真实执行按 Backend 能力运行并刷新所有 tab 的 workspace 投影", async () => {
        const analysis = await scanAndAnalyze(app, { provider: ItemProvider.Mock });
        const plan = (await app.inject({ method: "POST", url: "/api/plan", headers, payload: draftFor(analysis) })).json();
        const tabTwoHeaders = { ...headers, "x-tab-id": "tab-2" };
        const tabTwoAnalysis = await app.inject({
            method: "POST",
            url: "/api/analyze",
            headers: tabTwoHeaders,
            payload: { scanId: analysis.scanId },
        });
        expect(tabTwoAnalysis.statusCode).toBe(200);
        await app.inject({
            method: "PATCH",
            url: "/api/session/mutations",
            headers,
            payload: { enableMutations: true },
        });

        const start = await app.inject({
            method: "POST",
            url: "/api/action-executions/start",
            headers,
            payload: { planId: plan.planId, planHash: plan.planHash, dryRunSpeedMultiplier: DryRunSpeedMultiplier.One },
        });

        expect(start.statusCode).toBe(200);
        expect(start.json().writeEnabled).toBe(true);
        await vi.waitFor(async () => {
            const snapshot = await app.inject({
                method: "GET",
                url: `/api/action-executions/${ start.json().executionId }`,
                headers,
            });
            expect(snapshot.json().status).toBe(ActionExecutionStatus.Completed);
        });
        const refreshedTabTwo = await app.inject({ method: "GET", url: "/api/analysis", headers: tabTwoHeaders });
        expect(refreshedTabTwo.statusCode).toBe(200);
        expect(refreshedTabTwo.json().storeVersion).toBeGreaterThan(analysis.storeVersion);
        expect(refreshedTabTwo.json().groups).toHaveLength(analysis.groups.length - 1);
        expect(refreshedTabTwo.json().groups.map((group: { id: string }) => group.id)).not.toContain(analysis.groups[0].id);
    });

    it("marks skipped groups per workspace without changing Store analysis", async () => {
        const analysis = await scanAndAnalyze(app, { provider: ItemProvider.Mock });
        const group = analysis.groups[0];
        const response = await app.inject({
            method: "POST",
            url: `/api/groups/${ group.id }/skip`,
            headers,
            payload: { scanId: analysis.scanId },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json().scan.groups).toHaveLength(analysis.groups.length);
        expect(response.json().scan.skippedGroupIds).toContain(group.id);
    });

    it("scans a 1Password CSV through the read-only backend", async () => {
        const analysis = await scanAndAnalyze(app, {
            provider: ItemProvider.Csv,
            fileName: "export.csv",
            csvContent: [
                "Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes",
                "Example,https://example.com,user@example.com,secret-value-never-expose,,,false,,",
                "Example,https://example.com/,user@example.com,another-secret-never-expose,,,false,,",
            ].join("\n"),
        });
        const planResponse = await app.inject({ method: "POST", url: "/api/plan", headers, payload: draftFor(analysis) });

        expect(analysis.items).toHaveLength(2);
        expect(JSON.stringify(analysis)).not.toContain("secret-value-never-expose");
        expect(JSON.stringify(analysis)).not.toContain("another-secret-never-expose");
        expect(planResponse.statusCode).toBe(200);
        expect(planResponse.json().realExecutionSupported).toBe(false);
    });

    it("CSV 在真写模式下明确阻断而不是静默降级为 dry-run", async () => {
        const analysis = await scanAndAnalyze(app, {
            provider: ItemProvider.Csv,
            fileName: "export.csv",
            csvContent: [
                "Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes",
                "Example,https://example.com,user@example.com,secret,,,false,,",
                "Example,https://example.com/,user@example.com,secret,,,false,,",
            ].join("\n"),
        });
        await app.inject({
            method: "PATCH",
            url: "/api/session/mutations",
            headers,
            payload: { enableMutations: true },
        });
        const plan = (await app.inject({ method: "POST", url: "/api/plan", headers, payload: draftFor(analysis) })).json();

        const response = await app.inject({
            method: "POST",
            url: "/api/action-executions/start",
            headers,
            payload: { planId: plan.planId, planHash: plan.planHash, dryRunSpeedMultiplier: DryRunSpeedMultiplier.One },
        });

        expect(response.statusCode).toBe(422);
        expect(response.json().message).toBe("当前扫描源不支持真实写回。");
    });

    it("clears Store and workspace state together", async () => {
        await scanAndAnalyze(app, { provider: ItemProvider.Mock });
        expect((await app.inject({ method: "POST", url: "/api/scan/clear", headers })).statusCode).toBe(200);
        expect((await app.inject({ method: "GET", url: "/api/scan", headers })).statusCode).toBe(400);
        expect((await app.inject({ method: "GET", url: "/api/analysis", headers })).statusCode).toBe(400);
    });

    it("开始不同后端扫描时立即清除全局 Store、扫描快照和所有 tab workspace", async () => {
        const previous = await scanAndAnalyze(app, { provider: ItemProvider.Mock });
        const secondTabHeaders = { ...headers, "x-tab-id": "tab-2" };
        expect((await app.inject({
            method: "POST",
            url: "/api/analyze",
            headers: secondTabHeaders,
            payload: { scanId: previous.scanId },
        })).statusCode).toBe(200);

        const start = await app.inject({
            method: "POST",
            url: "/api/scan",
            headers,
            payload: {
                provider: ItemProvider.Csv,
                fileName: "replacement.csv",
                csvContent: "invalid,csv\nvalue",
            },
        });

        expect(start.statusCode).toBe(200);
        expect(services.itemRepository.getStore().getState()).toBe(StoreState.Empty);
        expect((await app.inject({ method: "GET", url: "/api/scan", headers })).statusCode).toBe(400);
        expect((await app.inject({ method: "GET", url: "/api/analysis", headers })).statusCode).toBe(400);
        expect((await app.inject({ method: "GET", url: "/api/analysis", headers: secondTabHeaders })).statusCode).toBe(400);
    });
});

async function scanAndAnalyze(
    app: Awaited<ReturnType<typeof createApiServer>>,
    payload: Record<string, unknown>,
): Promise<ScanResult & { skippedGroupIds: string[] }> {
    const started = await app.inject({ method: "POST", url: "/api/scan", headers, payload });
    expect(started.statusCode).toBe(200);
    let snapshot: ScanSnapshot | undefined;
    await vi.waitFor(async () => {
        const response = await app.inject({ method: "GET", url: "/api/scan", headers });
        expect(response.statusCode).toBe(200);
        snapshot = response.json();
    });
    const response = await app.inject({ method: "POST", url: "/api/analyze", headers, payload: { scanId: snapshot!.scanId } });
    expect(response.statusCode).toBe(200);
    return response.json();
}

function draftFor(analysis: ScanResult) {
    const group = analysis.groups[0];
    return {
        storeSnapshotId: analysis.scanId,
        storeVersion: analysis.storeVersion,
        groups: [{
            groupId: group.id,
            items: group.itemIds.map((itemId, index) => ({
                itemId,
                disposition: index === 0 ? ItemDisposition.Keep : ItemDisposition.Archive,
                removeTags: [],
            })),
        }],
    };
}
