import {
    ArchiveItemAction,
    CanonicalItem,
    CreateItemAction,
    ItemCategory,
    ItemCapability,
    ItemDisposition,
    ItemFieldKind,
    ItemFieldSensitivity,
    ItemLifecycleState,
    ItemProvider,
    ItemStoreSnapshot,
    ScanPhase,
    ScanProgressEventType,
    StoreState,
    UpdateItemAction,
} from "@optimize-password/core";
import { describe, expect, it, vi } from "vitest";
import { OnePasswordItemBackend } from "./onepassword-backend.js";
import { OnePasswordService } from "./onepassword.js";

describe("OnePasswordItemBackend", () => {
    it("将 1Password 扫描中的保险库进度完整转发给 API", async () => {
        const service = new OnePasswordService();
        vi.spyOn(service, "scan").mockImplementation(async (options) => {
            options.onProgress?.({
                type: ScanProgressEventType.Progress,
                progress: {
                    scanId: "delegate-scan",
                    phase: ScanPhase.Scanning,
                    totalVaults: 1,
                    scannedVaults: 0,
                    totalItems: 2,
                    scannedItems: 0,
                    vaults: [{ id: "vault-1", name: "Private", itemCount: 2, categoryCounts: {} }],
                    message: "已发现 Private 中的 2 个项目。",
                },
            });
            return {
                scanId: "delegate-scan",
                scannedAt: "2026-07-16T00:00:00.000Z",
                vaults: [{ id: "vault-1", name: "Private" }],
                items: [],
            };
        });
        const onProgress = vi.fn();

        await new OnePasswordItemBackend(service).readAll({ accountId: "test", onProgress });

        expect(onProgress).toHaveBeenCalledWith(
            "已发现 Private 中的 2 个项目。",
            0,
            expect.objectContaining({
                totalVaults: 1,
                vaults: [expect.objectContaining({ id: "vault-1", name: "Private", itemCount: 2 })],
            }),
        );
    });

    it("只移除标签时不会生成空 title 补丁", async () => {
        const backend = new OnePasswordItemBackend(new OnePasswordService());
        const item = createItem();

        const result = await backend.map({
            snapshot: createSnapshot(item),
            groupId: "group-1",
            startingSequence: 0,
            item,
            draft: {
                itemId: item.id,
                disposition: ItemDisposition.Keep,
                removeTags: ["legacy"],
            },
        });

        expect(result.actions).toHaveLength(1);
        expect(result.actions[0]).toBeInstanceOf(UpdateItemAction);
        expect((result.actions[0] as UpdateItemAction).command.patch).toEqual({ tags: ["keep"] });
    });

    it("跨保险库迁移展开为有依赖关系的创建和归档步骤", async () => {
        const backend = new OnePasswordItemBackend(new OnePasswordService());
        const item = createItem();

        const result = await backend.map({
            snapshot: createSnapshot(item),
            groupId: "group-1",
            startingSequence: 0,
            item,
            draft: {
                itemId: item.id,
                disposition: ItemDisposition.Keep,
                targetContainerId: "vault-2",
                removeTags: [],
            },
        });

        expect(result.actions[0]).toBeInstanceOf(CreateItemAction);
        expect(result.actions[1]).toBeInstanceOf(ArchiveItemAction);
        expect(result.actions[1].dependsOnActionIds).toEqual([result.actions[0].actionId]);
    });

    it("含 Passkey 的跨保险库迁移在规划阶段形成 blocker", async () => {
        const backend = new OnePasswordItemBackend(new OnePasswordService());
        const item = createItem();
        item.fields.push({
            id: "passkey",
            label: "Passkey",
            kind: ItemFieldKind.Passkey,
            sensitivity: ItemFieldSensitivity.Secret,
        });

        const result = await backend.map({
            snapshot: createSnapshot(item),
            groupId: "group-1",
            startingSequence: 0,
            item,
            draft: {
                itemId: item.id,
                disposition: ItemDisposition.Keep,
                targetContainerId: "vault-2",
                removeTags: [],
            },
        });

        expect(result.blockers).toEqual(["含 Passkey 的 item 不支持跨保险库迁移：Example"]);
    });

    it("扫描到 Passkey 时不声明复制和跨容器能力", async () => {
        const service = new OnePasswordService();
        vi.spyOn(service, "scan").mockResolvedValue({
            scanId: "scan-1",
            scannedAt: "2026-07-16T00:00:00.000Z",
            vaults: [{ id: "vault-1", name: "Private" }],
            items: [{
                id: "vault-1:item-1",
                onePasswordItemId: "item-1",
                vaultId: "vault-1",
                vaultName: "Private",
                title: "Passkey item",
                category: ItemCategory.Login,
                urls: [],
                usernames: [],
                tags: [],
                fieldCount: 1,
                hasPassword: false,
                hasTotp: false,
                hasPasskey: true,
                hasAttachments: false,
                hasNotes: false,
                comparableFields: [],
            }],
        });
        vi.spyOn(service, "canonicalMaterial").mockReturnValue({
            sections: [],
            fields: [{
                id: "passkey",
                label: "Passkey",
                kind: ItemFieldKind.Passkey,
                sensitivity: ItemFieldSensitivity.Secret,
            }],
            attachments: [],
        });

        const result = await new OnePasswordItemBackend(service).readAll({ accountId: "account" });

        expect(result.items[0].capabilities).not.toContain(ItemCapability.Copy);
        expect(result.items[0].capabilities).not.toContain(ItemCapability.ChangeContainer);
    });
});

function createItem(): CanonicalItem {
    const container = {
        provider: ItemProvider.OnePassword,
        accountId: "account",
        containerId: "vault-1",
        name: "Private",
    };
    return {
        id: "one-password:account:item-1",
        source: {
            provider: ItemProvider.OnePassword,
            accountId: "account",
            externalItemId: "item-1",
        },
        container,
        revision: 1,
        lifecycleState: ItemLifecycleState.Active,
        category: ItemCategory.Login,
        title: "Example",
        identities: [],
        urls: [],
        tags: ["legacy", "keep"],
        sections: [],
        fields: [],
        attachments: [],
        capabilities: [],
    };
}

function createSnapshot(item: CanonicalItem): ItemStoreSnapshot {
    return {
        snapshotId: "snapshot-1",
        version: 1,
        state: StoreState.Ready,
        createdAt: "2026-07-16T00:00:00.000Z",
        sourceProvider: ItemProvider.OnePassword,
        items: [item],
        containers: [item.container, { ...item.container, containerId: "vault-2", name: "Target" }],
    };
}
