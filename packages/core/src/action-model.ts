import {
    ActionKind,
    CanonicalItem,
    ItemDisposition,
    ItemPatch,
    ItemProvider,
    ItemStoreSnapshot,
    VerificationSeverity,
} from "./domain.js";
import type { ItemStore } from "./item-store.js";
import type { ScanProgress } from "./model.js";

export interface ActionDraftItem {
    itemId: string;
    disposition: ItemDisposition;
    desiredTitle?: string;
    targetContainerId?: string;
    removeTags: string[];
}

export interface ActionDraftGroup {
    groupId: string;
    items: ActionDraftItem[];
}

export interface ActionDraft {
    storeSnapshotId: string;
    storeVersion: number;
    groups: ActionDraftGroup[];
}

export interface ActionPresentation {
    label: string;
    detail: string;
    sourceLabel?: string;
    targetLabel?: string;
}

export abstract class ItemAction {
    protected constructor(
        public readonly actionId: string,
        public readonly groupId: string,
        public readonly sourceItemId: string,
        public readonly provider: ItemProvider,
        public readonly kind: ActionKind,
        public readonly sequence: number,
        public readonly dependsOnActionIds: string[],
        public readonly presentation: ActionPresentation,
    ) {
    }
}

export class KeepItemAction extends ItemAction {
    public constructor(actionId: string, groupId: string, sourceItemId: string, provider: ItemProvider, sequence: number, presentation: ActionPresentation) {
        super(actionId, groupId, sourceItemId, provider, ActionKind.Keep, sequence, [], presentation);
    }
}

export interface CreateItemCommand {
    sourceItemId: string;
    targetContainerId: string;
    desiredTitle?: string;
    removeTags: string[];
}

export interface UpdateItemCommand {
    itemId: string;
    patch: ItemPatch;
}

export interface ArchiveItemCommand {
    itemId: string;
}

export interface DeleteItemCommand {
    itemId: string;
}

export class CreateItemAction extends ItemAction {
    public constructor(
        actionId: string,
        groupId: string,
        sourceItemId: string,
        provider: ItemProvider,
        sequence: number,
        dependsOnActionIds: string[],
        presentation: ActionPresentation,
        public readonly command: CreateItemCommand,
    ) {
        super(actionId, groupId, sourceItemId, provider, ActionKind.Create, sequence, dependsOnActionIds, presentation);
    }
}

export class UpdateItemAction extends ItemAction {
    public constructor(
        actionId: string,
        groupId: string,
        sourceItemId: string,
        provider: ItemProvider,
        sequence: number,
        dependsOnActionIds: string[],
        presentation: ActionPresentation,
        public readonly command: UpdateItemCommand,
    ) {
        super(actionId, groupId, sourceItemId, provider, ActionKind.Update, sequence, dependsOnActionIds, presentation);
    }
}

export class ArchiveItemAction extends ItemAction {
    public constructor(
        actionId: string,
        groupId: string,
        sourceItemId: string,
        provider: ItemProvider,
        sequence: number,
        dependsOnActionIds: string[],
        presentation: ActionPresentation,
        public readonly command: ArchiveItemCommand,
    ) {
        super(actionId, groupId, sourceItemId, provider, ActionKind.Archive, sequence, dependsOnActionIds, presentation);
    }
}

export class DeleteItemAction extends ItemAction {
    public constructor(
        actionId: string,
        groupId: string,
        sourceItemId: string,
        provider: ItemProvider,
        sequence: number,
        dependsOnActionIds: string[],
        presentation: ActionPresentation,
        public readonly command: DeleteItemCommand,
    ) {
        super(actionId, groupId, sourceItemId, provider, ActionKind.Delete, sequence, dependsOnActionIds, presentation);
    }
}

export interface ActionStepDto {
    actionId: string;
    groupId: string;
    sourceItemId: string;
    provider: ItemProvider;
    kind: ActionKind;
    sequence: number;
    dependsOnActionIds: string[];
    label: string;
    detail: string;
    sourceLabel?: string;
    targetLabel?: string;
}

export interface ActionMappingRequest {
    snapshot: ItemStoreSnapshot;
    groupId: string;
    startingSequence: number;
    draft: ActionDraftItem;
    item: CanonicalItem;
}

export interface ActionMappingResult {
    actions: ItemAction[];
    blockers: string[];
    warnings: string[];
    affectedItemIds: string[];
}

export interface BackendCapabilities {
    supportsCreate: boolean;
    supportsUpdate: boolean;
    supportsArchive: boolean;
    supportsDelete: boolean;
    supportsAtomicContainerChange: boolean;
    supportsCopy: boolean;
    supportsAttachments: boolean;
    supportsPasskeys: boolean;
    supportsSecretFields: boolean;
}

export interface BackendReadRequest {
    accountId: string;
    accountName?: string;
    serviceAccountToken?: string;
    sourceName?: string;
    sourceContent?: string;
    onProgress?: (message: string, scannedItems: number, progress?: ScanProgress) => void;
}

export interface BackendReadResult {
    provider: ItemProvider;
    accountId: string;
    items: CanonicalItem[];
    containers: CanonicalItem["container"][];
}

export interface BackendMutationResult {
    createdItem?: CanonicalItem;
    updatedItem?: CanonicalItem;
    removedItemId?: string;
}

export interface BackendVerificationRequest {
    action: ItemAction;
    mutation: BackendMutationResult;
}

export interface BackendVerificationResult {
    ok: boolean;
    severity: VerificationSeverity;
    message: string;
}

export interface ItemBackendCrud {
    getProvider(): ItemProvider;
    getCapabilities(): BackendCapabilities;
    readAll(request: BackendReadRequest): Promise<BackendReadResult>;
    create(command: CreateItemCommand, sourceItem: CanonicalItem): Promise<BackendMutationResult>;
    update(command: UpdateItemCommand, currentItem: CanonicalItem): Promise<BackendMutationResult>;
    archive(command: ArchiveItemCommand, currentItem: CanonicalItem): Promise<BackendMutationResult>;
    delete(command: DeleteItemCommand, currentItem: CanonicalItem): Promise<BackendMutationResult>;
    verify(request: BackendVerificationRequest): Promise<BackendVerificationResult>;
    clearSession(): void;
}

export interface ItemActionMapper {
    map(request: ActionMappingRequest): Promise<ActionMappingResult>;
    simulate(step: ItemAction, store: ItemStore): Promise<BackendMutationResult>;
}

export interface ItemBackend extends ItemBackendCrud, ItemActionMapper {
}

export interface PlannedItemAction {
    itemId: string;
    disposition: ItemDisposition;
    intent: ActionDraftItem;
    actions: ItemAction[];
}

export interface PlannedItemActionDto {
    itemId: string;
    disposition: ItemDisposition;
    intent: ActionDraftItem;
    steps: ActionStepDto[];
}

export interface ActionPlanGroup {
    groupId: string;
    items: PlannedItemAction[];
    steps: ActionStepDto[];
    warnings: string[];
    blockers: string[];
}

export interface ActionPlan {
    planId: string;
    planHash: string;
    storeSnapshotId: string;
    storeVersion: number;
    groups: ActionPlanGroup[];
    warnings: string[];
    blockers: string[];
    requiresExplicitDeleteConfirmation: boolean;
    statistics: ActionPlanStatistics;
}

export interface ActionPlanStatistics {
    groupCount: number;
    itemCount: number;
    stepCount: number;
    mutationStepCount: number;
}

export interface ActionPlanGroupDto {
    groupId: string;
    items: PlannedItemActionDto[];
    steps: ActionStepDto[];
    warnings: string[];
    blockers: string[];
}

export interface ActionPlanDto {
    planId: string;
    planHash: string;
    storeSnapshotId: string;
    storeVersion: number;
    groups: ActionPlanGroupDto[];
    warnings: string[];
    blockers: string[];
    requiresExplicitDeleteConfirmation: boolean;
    statistics: ActionPlanStatistics;
    realExecutionSupported: boolean;
}

export function toActionStepDto(action: ItemAction): ActionStepDto {
    return {
        actionId: action.actionId,
        groupId: action.groupId,
        sourceItemId: action.sourceItemId,
        provider: action.provider,
        kind: action.kind,
        sequence: action.sequence,
        dependsOnActionIds: [...action.dependsOnActionIds],
        label: action.presentation.label,
        detail: action.presentation.detail,
        sourceLabel: action.presentation.sourceLabel,
        targetLabel: action.presentation.targetLabel,
    };
}

export function toActionPlanDto(plan: ActionPlan, realExecutionSupported: boolean): ActionPlanDto {
    return {
        planId: plan.planId,
        planHash: plan.planHash,
        storeSnapshotId: plan.storeSnapshotId,
        storeVersion: plan.storeVersion,
        groups: plan.groups.map((group) => ({
            groupId: group.groupId,
            items: group.items.map((item) => ({
                itemId: item.itemId,
                disposition: item.disposition,
                intent: { ...item.intent, removeTags: [...item.intent.removeTags] },
                steps: item.actions.map(toActionStepDto),
            })),
            steps: group.steps.map((step) => ({ ...step, dependsOnActionIds: [...step.dependsOnActionIds] })),
            warnings: [...group.warnings],
            blockers: [...group.blockers],
        })),
        warnings: [...plan.warnings],
        blockers: [...plan.blockers],
        requiresExplicitDeleteConfirmation: plan.requiresExplicitDeleteConfirmation,
        statistics: { ...plan.statistics },
        realExecutionSupported,
    };
}
