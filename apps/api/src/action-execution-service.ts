import {
    ActionExecutionEventKind,
    ActionExecutionStatus,
    ActionKind,
    ActionPlan,
    ActionStepStatus,
    DryRunSpeedMultiplier,
    ExecutionMode,
    ExecutionControlDecision,
    ItemAction,
    ItemProvider,
    ItemStore,
    ScanResult,
    StoreState,
} from "@optimize-password/core";

export interface ExecutionBackendResolver {
    getStore(): ItemStore;
    supportsReal(action: ItemAction): boolean;
    apply(action: ItemAction, targetStore: ItemStore, mode: ExecutionMode): Promise<{
        mutation: import("@optimize-password/core").BackendMutationResult;
        resultingVersion: number;
    }>;
}

export interface ExecutionAnalysisResolver {
    analyze(store: ItemStore): ScanResult;
}

export interface ActionExecutionEvent {
    kind: ActionExecutionEventKind;
    executionId: string;
    actionId?: string;
    status?: ActionStepStatus;
    message: string;
}

export interface ActionExecutionRequest {
    executionId: string;
    plan: ActionPlan;
    mode: ExecutionMode;
    dryRunSpeedMultiplier?: DryRunSpeedMultiplier;
    onEvent?: (event: ActionExecutionEvent) => void;
    control?: ActionExecutionControl;
}

export interface ActionExecutionResult {
    executionId: string;
    mode: ExecutionMode;
    succeeded: boolean;
    storeVersion: number;
    analysis: ScanResult;
    itemIdMappings: Record<string, string>;
    status: ActionExecutionStatus;
}

export class ActionExecutionControl {
    private pauseRequested = false;
    private stopRequested = false;
    private readonly resumeWaiters = new Set<() => void>();

    public pause(): void {
        this.pauseRequested = true;
    }

    public resume(): void {
        this.pauseRequested = false;
        for (const resume of this.resumeWaiters) {
            resume();
        }
        this.resumeWaiters.clear();
    }

    public stop(): void {
        this.stopRequested = true;
        this.resume();
    }

    public isPaused(): boolean {
        return this.pauseRequested && !this.stopRequested;
    }

    public isStopRequested(): boolean {
        return this.stopRequested;
    }

    public async beforeStep(): Promise<ExecutionControlDecision> {
        if (this.stopRequested) {
            return ExecutionControlDecision.Stop;
        }
        if (this.pauseRequested) {
            await new Promise<void>((resolve) => this.resumeWaiters.add(resolve));
        }
        return this.stopRequested ? ExecutionControlDecision.Stop : ExecutionControlDecision.Continue;
    }
}

export class ActionExecutionService {
    public constructor(
        private readonly repository: ExecutionBackendResolver,
        private readonly analysis: ExecutionAnalysisResolver,
    ) {
    }

    public async execute(request: ActionExecutionRequest): Promise<ActionExecutionResult> {
        const formalStore = this.repository.getStore();
        this.validatePlan(request.plan, formalStore);
        const targetStore = request.mode === ExecutionMode.DryRun ? formalStore.fork() : formalStore;
        const actions = request.plan.groups.flatMap((group) => group.items.flatMap((item) => item.actions));
        if (request.mode === ExecutionMode.Real) {
            this.validateRealCapabilities(actions);
        }
        request.onEvent?.({ kind: ActionExecutionEventKind.Started, executionId: request.executionId, message: "开始执行计划。" });
        const completedActionIds = new Set<string>();
        const itemIdMappings: Record<string, string> = {};

        for (const action of actions) {
            if (request.control && await request.control.beforeStep() === ExecutionControlDecision.Stop) {
                request.onEvent?.({ kind: ActionExecutionEventKind.Stopped, executionId: request.executionId, message: "执行已停止。" });
                return { executionId: request.executionId, mode: request.mode, succeeded: false, status: ActionExecutionStatus.Stopped,
                    storeVersion: targetStore.getVersion(), analysis: this.analysis.analyze(targetStore), itemIdMappings };
            }
            if (action.kind === ActionKind.Keep) {
                completedActionIds.add(action.actionId);
                continue;
            }
            if (action.dependsOnActionIds.some((actionId) => !completedActionIds.has(actionId))) {
                throw new Error(`步骤依赖尚未完成：${ action.presentation.label }`);
            }
            request.onEvent?.({ kind: ActionExecutionEventKind.StepStarted, executionId: request.executionId,
                actionId: action.actionId, status: ActionStepStatus.Running, message: action.presentation.label });
            try {
                const { mutation } = await this.repository.apply(action, targetStore, request.mode);
                if (mutation.createdItem) {
                    itemIdMappings[action.sourceItemId] = mutation.createdItem.id;
                }
                completedActionIds.add(action.actionId);
                request.onEvent?.({ kind: ActionExecutionEventKind.StepCompleted, executionId: request.executionId,
                    actionId: action.actionId, status: ActionStepStatus.Completed, message: action.presentation.label });
                if (request.mode === ExecutionMode.DryRun) {
                    await waitForDryRunPacing(request.dryRunSpeedMultiplier ?? DryRunSpeedMultiplier.One, request.control);
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                if (request.mode === ExecutionMode.Real && targetStore.getState() === StoreState.Ready) {
                    targetStore.markStale(`后端写入结果无法确认：${ message }`);
                }
                request.onEvent?.({ kind: ActionExecutionEventKind.StepFailed, executionId: request.executionId,
                    actionId: action.actionId, status: ActionStepStatus.Failed, message });
                request.onEvent?.({ kind: ActionExecutionEventKind.Failed, executionId: request.executionId, message });
                return { executionId: request.executionId, mode: request.mode, succeeded: false, status: ActionExecutionStatus.Failed,
                    storeVersion: targetStore.getVersion(),
                    analysis: this.analysis.analyze(targetStore), itemIdMappings };
            }
        }

        request.onEvent?.({ kind: ActionExecutionEventKind.Completed, executionId: request.executionId, message: "执行完成。" });
        return { executionId: request.executionId, mode: request.mode, succeeded: true, status: ActionExecutionStatus.Completed,
            storeVersion: targetStore.getVersion(),
            analysis: this.analysis.analyze(targetStore), itemIdMappings };
    }

    private validatePlan(plan: ActionPlan, store: ItemStore): void {
        if (store.getState() !== StoreState.Ready) throw new Error("Item Store 尚未就绪或已经失效，请重新扫描。");
        if (plan.storeSnapshotId !== store.getSnapshotId() || plan.storeVersion !== store.getVersion()) {
            throw new Error("ActionPlan 对应的 Item Store 已发生变化，请重新生成计划。");
        }
        if (plan.blockers.length) throw new Error(plan.blockers.join("\n"));
    }

    private validateRealCapabilities(actions: ItemAction[]): void {
        for (const action of actions) {
            if (!this.repository.supportsReal(action)) {
                throw new Error(`${ providerLabel(action.provider) } Backend 不支持真实${ actionLabel(action.kind) }。`);
            }
        }
    }
}

const dryRunActionDelayMs: Record<DryRunSpeedMultiplier, number> = {
    [DryRunSpeedMultiplier.One]: 0,
    [DryRunSpeedMultiplier.Five]: 200,
    [DryRunSpeedMultiplier.Ten]: 400,
};

async function waitForDryRunPacing(multiplier: DryRunSpeedMultiplier, control?: ActionExecutionControl): Promise<void> {
    let remainingMs = dryRunActionDelayMs[multiplier];
    while (remainingMs > 0 && !control?.isStopRequested() && !control?.isPaused()) {
        const sliceMs = Math.min(remainingMs, 25);
        await new Promise<void>((resolve) => setTimeout(resolve, sliceMs));
        remainingMs -= sliceMs;
    }
}

function actionLabel(kind: ActionKind): string {
    switch (kind) {
        case ActionKind.Keep: return "保留";
        case ActionKind.Create: return "创建";
        case ActionKind.Update: return "更新";
        case ActionKind.Archive: return "归档";
        case ActionKind.Delete: return "删除";
    }
}

function providerLabel(provider: ItemProvider): string {
    return provider === ItemProvider.Csv ? "CSV" : provider;
}
