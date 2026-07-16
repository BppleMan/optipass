import { signal } from "@angular/core";
import {
    ActionExecutionEventKind,
    ActionExecutionStatus,
    ActionKind,
    ActionStepStatus,
    DryRunSpeedMultiplier,
    ItemCategory,
    ItemDisposition,
    ItemProvider,
    ScanMode,
    ScanPhase,
    type ActionPlanDto,
    type ScanResult,
} from "@optimize-password/core";
import { describe, expect, it, vi } from "vitest";
import { WorkflowService } from "./workflow.service";
import { ApplyStatus, RemoveAction } from "../../../core/models/workflow.models";
import { ClientAppMode, ClientShell } from "../../../core/services/api.service";

describe("WorkflowService canonical action workflow", () => {
    it("stores decisions with canonical disposition fields", () => {
        const { service } = createService();
        service.setScanResult(scanResult());
        service.decisions.set({
            "one-password:test:new": {
                itemId: "one-password:test:new",
                disposition: ItemDisposition.Keep,
                targetContainerId: "private",
                removeTags: [],
            },
            "one-password:test:old": {
                itemId: "one-password:test:old",
                disposition: ItemDisposition.Archive,
                targetContainerId: "archive",
                removeTags: [],
            },
        });

        service.updateItemTitle("one-password:test:new", "新标题");
        service.updateRemoveAction("one-password:test:old", RemoveAction.Delete);

        expect(service.decisions()["one-password:test:new"].desiredTitle).toBe("新标题");
        expect(service.decisions()["one-password:test:old"].disposition).toBe(ItemDisposition.Delete);
    });

    it("loads expanded backend steps before opening the execution dialog", async () => {
        const { service, api } = createService();
        const result = scanResult();
        service.setScanResult(result);
        service.decisions.set(defaultDecisions());
        vi.mocked(api.createPlan).mockResolvedValue(actionPlan());

        await service.openGroupExecutionDialog("group-1");

        expect(api.createPlan).toHaveBeenCalledWith({
            storeSnapshotId: result.scanId,
            storeVersion: result.storeVersion,
            groups: [{
                groupId: "group-1",
                items: Object.values(defaultDecisions()),
            }],
        });
        expect(service.operations().map((operation) => operation.actionId)).toEqual(["archive-old"]);
        expect(service.actionExecutionStatus()).toBe(ActionExecutionStatus.Ready);
    });

    it("使用预览计划的 planId 和 planHash 启动同一组 Action", async () => {
        const { service, api } = createService();
        const result = scanResult();
        const plan = actionPlan();
        service.setScanResult(result);
        service.decisions.set(defaultDecisions());
        vi.mocked(api.createPlan).mockResolvedValue(plan);
        vi.mocked(api.startActionExecution).mockResolvedValue({
            executionId: "execution-1",
            eventsToken: "events",
            status: ActionExecutionStatus.Completed,
            writeEnabled: false,
            dryRunSpeedMultiplier: DryRunSpeedMultiplier.One,
            totalGroups: 1,
            totalOperations: 1,
            completedOperations: 1,
            cancelledOperations: 0,
            plan,
            draft: {
                storeSnapshotId: result.scanId,
                storeVersion: result.storeVersion,
                groups: [{ groupId: "group-1", items: Object.values(defaultDecisions()) }],
            },
        });
        vi.mocked(api.streamActionExecutionEvents).mockResolvedValue();
        await service.openGroupExecutionDialog("group-1");

        await service.startPreparedActionExecution();

        expect(api.startActionExecution).toHaveBeenCalledWith(
            plan.planId,
            plan.planHash,
            undefined,
            DryRunSpeedMultiplier.One,
        );
    });

    it("updates progress by actionId and replaces formal analysis after real execution", async () => {
        const { service, api } = createService();
        const result = scanResult();
        service.setScanResult(result);
        service.decisions.set(defaultDecisions());
        vi.mocked(api.createPlan).mockResolvedValue(actionPlan());
        await service.openGroupExecutionDialog("group-1");

        const applyEvent = (service as unknown as { applyActionExecutionEvent(event: unknown): void }).applyActionExecutionEvent.bind(service);
        applyEvent({
            type: ActionExecutionEventKind.StepStarted,
            sequence: 1,
            executionId: "execution-1",
            status: ActionExecutionStatus.Running,
            writeEnabled: true,
            totalGroups: 1,
            totalOperations: 1,
            completedOperations: 0,
            actionId: "archive-old",
            stepStatus: ActionStepStatus.Running,
        });
        expect(service.operations()[0].status).toBe(ApplyStatus.Running);

        const refreshed = { ...result, storeVersion: 2, groups: [], skippedGroupIds: [] };
        applyEvent({
            type: ActionExecutionEventKind.AnalysisUpdated,
            sequence: 2,
            executionId: "execution-1",
            status: ActionExecutionStatus.Completed,
            writeEnabled: true,
            totalGroups: 1,
            totalOperations: 1,
            completedOperations: 1,
            response: { analysis: refreshed, storeVersion: 2, itemIdMappings: {}, dryRun: false },
        });
        expect(service.scanResult()?.groups).toEqual([]);
        expect(service.scanResult()?.storeVersion).toBe(2);
    });

    it("releases CSV contents after the API accepts the scan", async () => {
        const { service, api } = createService();
        vi.mocked(api.loadSession).mockResolvedValue(sessionResponse());
        vi.mocked(api.startScan).mockResolvedValue({
            scanId: "scan-job",
            mode: ScanMode.Csv,
            eventsToken: "events",
            progress: { scanId: "scan-job", phase: ScanPhase.Scanning, totalVaults: 0, scannedVaults: 0, totalItems: 0, scannedItems: 0, vaults: [] },
        });
        vi.mocked(api.streamScanEvents).mockResolvedValue();
        await service.selectCsvFile(new File(["Title,Url\nA,https://a.test"], "items.csv", { type: "text/csv" }));

        await service.startScan();

        expect((service as unknown as { csvContent(): string }).csvContent()).toBe("");
        expect(service.scanSource()).toBe(ItemProvider.Csv);
    });

    it("Store 版本变化后丢弃旧 draft 并重建默认决策", async () => {
        const { service, api } = createService();
        const result = scanResult();
        service.setScanResult(result);
        service.decisions.set({
            ...defaultDecisions(),
            "one-password:test:new": {
                ...defaultDecisions()["one-password:test:new"],
                desiredTitle: "旧计划标题",
                removeTags: ["legacy"],
            },
        });
        vi.mocked(api.loadAnalysis).mockResolvedValue({ ...result, storeVersion: 2, skippedGroupIds: [] });
        const recover = (service as unknown as { recoverStaleAnalysis(message: string): Promise<void> })
            .recoverStaleAnalysis.bind(service);

        await recover("Store version conflict");

        expect(service.decisions()["one-password:test:new"].desiredTitle).toBeUndefined();
        expect(service.decisions()["one-password:test:new"].removeTags).toEqual([]);
        expect(service.error()).toContain("旧处置计划已失效");
    });
});

function createService(): { service: WorkflowService; api: any } {
    const api = {
        session: signal(sessionResponse()),
        loadSession: vi.fn(),
        loadAnalysis: vi.fn(),
        createPlan: vi.fn(),
        startScan: vi.fn(),
        startActionExecution: vi.fn(),
        streamScanEvents: vi.fn(),
        streamActionExecutionEvents: vi.fn(),
    };
    const router = { navigate: vi.fn() };
    return { service: new WorkflowService(api as never, router as never), api };
}

function sessionResponse(): any {
    return {
        token: "test",
        mode: ClientAppMode.BrowserDev,
        accountName: "test",
        apiBaseUrl: "",
        enableMutations: true,
        hasServiceAccountToken: false,
        supportsDesktopAuth: true,
        idleShutdownMs: 0,
        capabilities: {
            staticUi: false,
            canShutdown: false,
            supportsHeartbeat: false,
            supportsIdleShutdown: false,
            supportsDesktopAuth: true,
            shell: ClientShell.Browser,
        },
    };
}

function defaultDecisions() {
    return {
        "one-password:test:new": {
            itemId: "one-password:test:new",
            disposition: ItemDisposition.Keep,
            targetContainerId: "private",
            removeTags: [],
        },
        "one-password:test:old": {
            itemId: "one-password:test:old",
            disposition: ItemDisposition.Archive,
            targetContainerId: "archive",
            removeTags: [],
        },
    };
}

function actionPlan(): ActionPlanDto {
    const step = {
        actionId: "archive-old",
        groupId: "group-1",
        sourceItemId: "one-password:test:old",
        provider: ItemProvider.OnePassword,
        kind: ActionKind.Archive,
        sequence: 0,
        dependsOnActionIds: [],
        label: "归档旧项目",
        detail: "归档旧项目",
    };
    return {
        planId: "plan-1",
        planHash: "plan-hash-1",
        storeSnapshotId: "snapshot-1",
        storeVersion: 1,
        groups: [{
            groupId: "group-1",
            items: [{
                itemId: "one-password:test:old",
                disposition: ItemDisposition.Archive,
                intent: { itemId: "one-password:test:old", disposition: ItemDisposition.Archive, removeTags: [] },
                steps: [step],
            }],
            steps: [step],
            warnings: [],
            blockers: [],
        }],
        warnings: [],
        blockers: [],
        requiresExplicitDeleteConfirmation: false,
        statistics: { groupCount: 1, itemCount: 1, stepCount: 1, mutationStepCount: 1 },
        realExecutionSupported: true,
    };
}

function scanResult(): ScanResult {
    return {
        scanId: "snapshot-1",
        storeVersion: 1,
        scannedAt: "2026-07-16T00:00:00.000Z",
        analyzedAt: "2026-07-16T00:00:01.000Z",
        vaults: [
            { id: "private", name: "Private" },
            { id: "archive", name: "Archive" },
        ],
        items: [
            item("one-password:test:new", "new", "Private", "private"),
            item("one-password:test:old", "old", "Archive", "archive"),
        ],
        groups: [{
            id: "group-1",
            itemIds: ["one-password:test:new", "one-password:test:old"],
            reasons: [],
            recommendedKeepIds: ["one-password:test:new"],
            recommendedKeepReasons: [],
        }],
    };
}

function item(id: string, externalId: string, vaultName: string, vaultId: string) {
    return {
        id,
        onePasswordItemId: externalId,
        vaultId,
        vaultName,
        title: "Example",
        category: ItemCategory.Login,
        urls: ["https://example.com"],
        usernames: ["user@example.com"],
        tags: [],
        fieldCount: 2,
        hasPassword: true,
        hasTotp: false,
        hasPasskey: false,
        hasAttachments: false,
        hasNotes: false,
        comparableFields: [],
    };
}
