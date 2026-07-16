import {
    ActionPlanningService,
    BackendReadRequest,
    CanonicalItem,
    ComparableFieldKind,
    findSimilarityGroups,
    ItemBackend,
    ItemBackendResolver,
    ItemCategory,
    ItemFieldKind,
    ItemLifecycleState,
    ItemProvider,
    ItemStore,
    ItemStoreSnapshot,
    ItemSummary,
    ScanResult,
    VaultSummary,
} from "@optimize-password/core";
import { ActionExecutionService } from "./action-execution-service.js";
import { ItemRepositoryService } from "./item-repository.js";

export class ItemBackendRegistry implements ItemBackendResolver {
    private readonly backends = new Map<ItemProvider, ItemBackend>();

    public register(backend: ItemBackend): void {
        this.backends.set(backend.getProvider(), backend);
    }

    public get(provider: ItemProvider): ItemBackend {
        const backend = this.backends.get(provider);
        if (!backend) {
            throw new Error(`没有为 ${ provider } 注册 Item Backend。`);
        }
        return backend;
    }

    public has(provider: ItemProvider): boolean {
        return this.backends.has(provider);
    }

    public clear(): void {
        for (const backend of this.backends.values()) {
            backend.clearSession();
        }
    }
}

export class ItemSynchronizationService {
    public constructor(
        private readonly repository: ItemRepositoryService,
        private readonly backends: ItemBackendRegistry,
    ) {
    }

    public async synchronize(
        provider: ItemProvider,
        accountId: string,
        accountName?: string,
        serviceAccountToken?: string,
        onProgress?: BackendReadRequest["onProgress"],
        sourceName?: string,
        sourceContent?: string,
    ): Promise<ItemStoreSnapshot> {
        const result = await this.backends.get(provider).readAll({
            accountId,
            accountName,
            serviceAccountToken,
            onProgress,
            sourceName,
            sourceContent,
        });
        return this.repository.replace(result.provider, result.items, result.containers);
    }

    public clear(): void {
        this.repository.clear();
        this.backends.clear();
    }
}

export class SimilarityAnalysisService {
    public analyze(store: ItemStore): ScanResult {
        const snapshot = store.createSnapshot();
        const items = store.listActive().map(toItemSummary);
        const vaults = uniqueContainers(snapshot.items).map((container) => ({ id: container.containerId, name: container.name }));
        const scannedAt = snapshot.createdAt;
        return {
            scanId: snapshot.snapshotId,
            storeVersion: snapshot.version,
            scannedAt,
            analyzedAt: new Date().toISOString(),
            vaults,
            items,
            groups: findSimilarityGroups(items),
        };
    }
}

export interface AnalysisWorkspace {
    tabId: string;
    analysis: ScanResult;
    skippedGroupIds: string[];
}

export interface AnalysisWorkspaceLookup {
    found: boolean;
    workspace?: AnalysisWorkspace;
}

export class AnalysisWorkspaceService {
    private readonly workspaces = new Map<string, AnalysisWorkspace>();

    public constructor(private readonly analysis: SimilarityAnalysisService) {
    }

    public analyze(tabId: string, store: ItemStore): AnalysisWorkspace {
        const workspace = { tabId, analysis: this.analysis.analyze(store), skippedGroupIds: [] };
        this.workspaces.set(tabId, workspace);
        return structuredClone(workspace);
    }

    public getRequired(tabId: string): AnalysisWorkspace {
        const workspace = this.workspaces.get(tabId);
        if (!workspace) {
            throw new Error("还没有分析结果，请先完成扫描并手动运行分析。");
        }
        return structuredClone(workspace);
    }

    public tryGet(tabId: string): AnalysisWorkspaceLookup {
        const workspace = this.workspaces.get(tabId);
        return workspace ? { found: true, workspace: structuredClone(workspace) } : { found: false };
    }

    public refreshAll(store: ItemStore): void {
        for (const [tabId, current] of this.workspaces) {
            const analysis = this.analysis.analyze(store);
            const groupIds = new Set(analysis.groups.map((group) => group.id));
            this.workspaces.set(tabId, {
                tabId,
                analysis,
                skippedGroupIds: current.skippedGroupIds.filter((groupId) => groupIds.has(groupId)),
            });
        }
    }

    public setSkipped(tabId: string, groupId: string, skipped: boolean): AnalysisWorkspace {
        const workspace = this.getRequired(tabId);
        const ids = new Set(workspace.skippedGroupIds);
        skipped ? ids.add(groupId) : ids.delete(groupId);
        workspace.skippedGroupIds = Array.from(ids);
        this.workspaces.set(tabId, workspace);
        return structuredClone(workspace);
    }

    public clear(): void {
        this.workspaces.clear();
    }
}

export interface ApplicationServices {
    itemRepository: ItemRepositoryService;
    backendRegistry: ItemBackendRegistry;
    synchronization: ItemSynchronizationService;
    analysis: SimilarityAnalysisService;
    workspaces: AnalysisWorkspaceService;
    planning: ActionPlanningService;
    execution: ActionExecutionService;
}

export function createApplicationServices(backends: ItemBackend[]): ApplicationServices {
    const backendRegistry = new ItemBackendRegistry();
    for (const backend of backends) {
        backendRegistry.register(backend);
    }
    const itemRepository = new ItemRepositoryService(backendRegistry);
    const synchronization = new ItemSynchronizationService(itemRepository, backendRegistry);
    const analysis = new SimilarityAnalysisService();
    const workspaces = new AnalysisWorkspaceService(analysis);
    const planning = new ActionPlanningService(itemRepository.getStore(), backendRegistry);
    const execution = new ActionExecutionService(itemRepository, analysis);
    return { itemRepository, backendRegistry, synchronization, analysis, workspaces, planning, execution };
}

export function toItemSummary(item: CanonicalItem): ItemSummary {
    const usernames = item.identities.map((identity) => identity.value);
    const comparableFields = item.fields.map((field) => ({
        label: field.label,
        kind: comparableKind(field.kind),
        normalizedValue: field.normalizedValue,
        normalizedValueHash: field.normalizedValueHash,
    }));
    return {
        id: item.id,
        onePasswordItemId: item.source.externalItemId,
        vaultId: item.container.containerId,
        vaultName: item.container.name,
        title: item.title,
        category: item.category,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        urls: item.urls.map((url) => url.value),
        usernames,
        tags: [...item.tags],
        fieldCount: item.fields.length,
        hasPassword: item.fields.some((field) => field.kind === ItemFieldKind.Password || field.kind === ItemFieldKind.Secret),
        hasTotp: item.fields.some((field) => field.kind === ItemFieldKind.Totp),
        hasPasskey: item.fields.some((field) => field.kind === ItemFieldKind.Passkey),
        hasAttachments: item.attachments.length > 0,
        hasNotes: Boolean(item.notes?.trim()),
        comparableFields,
        analysis: { notesText: item.notes ?? "" },
    };
}

function comparableKind(kind: ItemFieldKind): ItemSummary["comparableFields"][number]["kind"] {
    switch (kind) {
        case ItemFieldKind.Username:
            return ComparableFieldKind.Username;
        case ItemFieldKind.Email:
            return ComparableFieldKind.Email;
        case ItemFieldKind.Phone:
            return ComparableFieldKind.Phone;
        case ItemFieldKind.Url:
            return ComparableFieldKind.Url;
        case ItemFieldKind.Secret:
        case ItemFieldKind.Password:
        case ItemFieldKind.Totp:
        case ItemFieldKind.Passkey:
            return ComparableFieldKind.Secret;
        case ItemFieldKind.Card:
            return ComparableFieldKind.Card;
        case ItemFieldKind.Text:
            return ComparableFieldKind.Text;
        default:
            return ComparableFieldKind.Unknown;
    }
}

function uniqueContainers(items: CanonicalItem[]): CanonicalItem["container"][] {
    return Array.from(new Map(items.map((item) => [item.container.containerId, item.container])).values());
}
