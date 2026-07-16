import { randomUUID } from "node:crypto";
import {
    ActionMappingRequest,
    ActionMappingResult,
    ArchiveItemAction,
    ArchiveItemCommand,
    BackendCapabilities,
    BackendMutationResult,
    BackendReadRequest,
    BackendReadResult,
    BackendVerificationRequest,
    BackendVerificationResult,
    CanonicalItem,
    CreateItemAction,
    CreateItemCommand,
    DeleteItemAction,
    DeleteItemCommand,
    ItemBackend,
    ItemCategory,
    ItemDisposition,
    ItemFieldKind,
    ItemFieldSensitivity,
    ItemIdentityKind,
    ItemLifecycleState,
    ItemPatch,
    ItemProvider,
    ItemStore,
    KeepItemAction,
    UpdateItemAction,
    UpdateItemCommand,
    VerificationSeverity,
} from "@optimize-password/core";
import { canonicalItemId } from "./onepassword-backend.js";

const expectedHeaders = ["Title", "Url", "Username", "Password", "OTPAuth", "Favorite", "Archived", "Tags", "Notes"];

export class CsvItemBackend implements ItemBackend {
    public getProvider(): ItemProvider {
        return ItemProvider.Csv;
    }

    public getCapabilities(): BackendCapabilities {
        return {
            supportsCreate: false,
            supportsUpdate: false,
            supportsArchive: false,
            supportsDelete: false,
            supportsAtomicContainerChange: false,
            supportsCopy: false,
            supportsAttachments: false,
            supportsPasskeys: false,
            supportsSecretFields: true,
        };
    }

    public async readAll(request: BackendReadRequest): Promise<BackendReadResult> {
        if (!request.sourceContent) {
            throw new Error("CSV 扫描缺少文件内容。");
        }
        const rows = parseCsv(request.sourceContent);
        if (rows.length === 0) {
            throw new Error("CSV 文件为空。");
        }
        assertHeaders(rows[0]);
        const accountId = request.accountId || request.sourceName || "csv-import";
        const container = {
            provider: ItemProvider.Csv,
            accountId,
            containerId: `csv:${ accountId }`,
            name: request.sourceName || "1Password CSV",
        };
        const items = rows.slice(1)
            .filter((row) => row.some((value) => value.trim().length > 0))
            .map((row, index) => toCanonicalItem(row, index + 2, accountId, container));
        items.forEach((item, index) => request.onProgress?.(`正在读取 CSV：${ item.title }`, index + 1));
        return { provider: ItemProvider.Csv, accountId, items, containers: [container] };
    }

    public async create(_command: CreateItemCommand, _sourceItem: CanonicalItem): Promise<BackendMutationResult> {
        throw readOnlyError();
    }

    public async update(_command: UpdateItemCommand, _currentItem: CanonicalItem): Promise<BackendMutationResult> {
        throw readOnlyError();
    }

    public async archive(_command: ArchiveItemCommand, _currentItem: CanonicalItem): Promise<BackendMutationResult> {
        throw readOnlyError();
    }

    public async delete(_command: DeleteItemCommand, _currentItem: CanonicalItem): Promise<BackendMutationResult> {
        throw readOnlyError();
    }

    public async verify(_request: BackendVerificationRequest): Promise<BackendVerificationResult> {
        return { ok: false, severity: VerificationSeverity.Critical, message: "CSV Backend 不支持真实写回。" };
    }

    public async map(request: ActionMappingRequest): Promise<ActionMappingResult> {
        const { draft, groupId, item } = request;
        const actions = [];
        const desiredTitle = draft.desiredTitle?.trim();
        const tags = item.tags.filter((tag) => !draft.removeTags.includes(tag));
        if (draft.targetContainerId && draft.targetContainerId !== item.container.containerId) {
            actions.push(new CreateItemAction(
                randomUUID(), groupId, item.id, ItemProvider.Csv, request.startingSequence, [],
                { label: `模拟复制「${ item.title }」`, detail: "CSV 仅支持在 dry-run Store 中模拟迁移" },
                { sourceItemId: item.id, targetContainerId: draft.targetContainerId, desiredTitle, removeTags: draft.removeTags },
            ));
        } else if (draft.disposition === ItemDisposition.Delete) {
            actions.push(new DeleteItemAction(randomUUID(), groupId, item.id, ItemProvider.Csv, request.startingSequence, [],
                { label: `模拟删除「${ item.title }」`, detail: "CSV 仅支持 dry-run" }, { itemId: item.id }));
        } else if (draft.disposition === ItemDisposition.Archive) {
            actions.push(new ArchiveItemAction(randomUUID(), groupId, item.id, ItemProvider.Csv, request.startingSequence, [],
                { label: `模拟归档「${ item.title }」`, detail: "CSV 仅支持 dry-run" }, { itemId: item.id }));
        } else if ((desiredTitle && desiredTitle !== item.title) || tags.length !== item.tags.length) {
            const patch: ItemPatch = { tags };
            if (desiredTitle && desiredTitle !== item.title) {
                patch.title = desiredTitle;
            }
            actions.push(new UpdateItemAction(randomUUID(), groupId, item.id, ItemProvider.Csv, request.startingSequence, [],
                { label: `模拟更新「${ item.title }」`, detail: "CSV 仅支持 dry-run" },
                { itemId: item.id, patch }));
        } else {
            actions.push(new KeepItemAction(randomUUID(), groupId, item.id, ItemProvider.Csv, request.startingSequence,
                { label: `保留「${ item.title }」`, detail: "不修改 item" }));
        }
        return {
            actions,
            blockers: [],
            warnings: ["CSV 是只读扫描源；这些步骤只能 dry-run，不能写回原文件。"],
            affectedItemIds: [item.id],
        };
    }

    public async simulate(step: import("@optimize-password/core").ItemAction, store: ItemStore): Promise<BackendMutationResult> {
        if (step instanceof CreateItemAction) {
            const source = store.getRequired(step.command.sourceItemId);
            const patch: ItemPatch = { tags: source.tags.filter((tag) => !step.command.removeTags.includes(tag)) };
            if (step.command.desiredTitle) {
                patch.title = step.command.desiredTitle;
            }
            const createdItem = applyPatch({
                ...structuredClone(source),
                id: canonicalItemId(ItemProvider.Csv, source.source.accountId, `dry-run-${ step.actionId }`),
                source: { ...source.source, externalItemId: `dry-run-${ step.actionId }` },
                container: { ...source.container, containerId: step.command.targetContainerId },
            }, patch);
            return { createdItem };
        }
        if (step instanceof UpdateItemAction) {
            return { updatedItem: applyPatch(store.getRequired(step.command.itemId), step.command.patch) };
        }
        if (step instanceof ArchiveItemAction) {
            return { updatedItem: applyPatch(store.getRequired(step.command.itemId), { lifecycleState: ItemLifecycleState.Archived }) };
        }
        if (step instanceof DeleteItemAction) {
            return { removedItemId: step.command.itemId };
        }
        return {};
    }

    public clearSession(): void {
    }
}

export function parseCsv(content: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let value = "";
    let quoted = false;
    const source = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
    for (let index = 0; index < source.length; index += 1) {
        const character = source[index];
        if (quoted) {
            if (character === '"' && source[index + 1] === '"') {
                value += '"';
                index += 1;
            } else if (character === '"') {
                quoted = false;
            } else {
                value += character;
            }
        } else if (character === '"' && value.length === 0) {
            quoted = true;
        } else if (character === ",") {
            row.push(value);
            value = "";
        } else if (character === "\n" || character === "\r") {
            if (character === "\r" && source[index + 1] === "\n") {
                index += 1;
            }
            row.push(value);
            rows.push(row);
            row = [];
            value = "";
        } else {
            value += character;
        }
    }
    if (quoted) {
        throw new Error("CSV 文件包含未闭合的引号。");
    }
    if (value.length > 0 || row.length > 0) {
        row.push(value);
        rows.push(row);
    }
    return rows;
}

function assertHeaders(headers: string[]): void {
    const normalized = headers.map((header) => header.trim());
    if (normalized.length !== expectedHeaders.length || expectedHeaders.some((header, index) => normalized[index] !== header)) {
        throw new Error(`不支持的 CSV 格式。需要 1Password 导出表头：${ expectedHeaders.join(",") }`);
    }
}

function toCanonicalItem(
    row: string[],
    rowNumber: number,
    accountId: string,
    container: CanonicalItem["container"],
): CanonicalItem {
    const [title, url, username, password, otpAuth, _favorite, archived, tags, notes] = expectedHeaders.map((_header, index) => row[index] ?? "");
    const externalItemId = `row-${ rowNumber }`;
    const fields = [];
    if (username.trim()) {
        fields.push({ id: "username", label: "username", kind: username.includes("@") ? ItemFieldKind.Email : ItemFieldKind.Username,
            sensitivity: ItemFieldSensitivity.Private, value: username });
    }
    if (password) {
        fields.push({ id: "password", label: "password", kind: ItemFieldKind.Password,
            sensitivity: ItemFieldSensitivity.Secret, value: password });
    }
    if (otpAuth) {
        fields.push({ id: "otp", label: "one-time password", kind: ItemFieldKind.Totp,
            sensitivity: ItemFieldSensitivity.Secret, value: otpAuth });
    }
    return {
        id: canonicalItemId(ItemProvider.Csv, accountId, externalItemId),
        source: { provider: ItemProvider.Csv, accountId, externalItemId },
        container: structuredClone(container),
        revision: 1,
        lifecycleState: truthy(archived) ? ItemLifecycleState.Archived : ItemLifecycleState.Active,
        category: ItemCategory.Login,
        title: title.trim() || `CSV row ${ rowNumber }`,
        notes,
        identities: username.trim() ? [{ kind: username.includes("@") ? ItemIdentityKind.Email : ItemIdentityKind.Username, value: username }] : [],
        urls: url.trim() ? [{ value: url }] : [],
        tags: tags.split(/[,\r\n]/).map((tag) => tag.trim()).filter(Boolean),
        sections: [],
        fields,
        attachments: [],
        capabilities: [],
    };
}

function truthy(value: string): boolean {
    return ["true", "yes", "1"].includes(value.trim().toLowerCase());
}

function applyPatch(item: CanonicalItem, patch: ItemPatch): CanonicalItem {
    return { ...structuredClone(item), ...structuredClone(patch), revision: item.revision + 1, updatedAt: new Date().toISOString() };
}

function readOnlyError(): Error {
    return new Error("CSV Backend 是只读扫描源，不支持真实写回。");
}
