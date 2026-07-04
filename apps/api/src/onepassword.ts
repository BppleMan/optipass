import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import sdk from "@1password/sdk";
import type { FileAttributes, Item, ItemCreateParams, ItemField, ItemFile, ItemSection, Website } from "@1password/sdk";
import {
  ComparableField,
  ItemCategory,
  ItemSummary,
  RevealedCredentialField,
  ScanProgressEvent,
  ScanSnapshot,
  summarizeVaults,
  VaultScanSummary,
  VaultSummary
} from "@optimize-password/core";

type OnePasswordClient = Awaited<ReturnType<typeof sdk.createClient>>;
type RawItem = Item;
const maxGetAllBatchSize = 50;
const sdkSlowLogMs = readPositiveInteger(process.env.OP_SDK_SLOW_LOG_MS, 15_000);
const execFileAsync = promisify(execFile);
const maxConcurrentVaultScans = 3;

interface CachedRawItem {
  item: RawItem;
  onePasswordItemId: string;
  vaultId: string;
}

export interface ScanOptions {
  scanId?: string;
  serviceAccountToken?: string;
  accountName?: string;
  onProgress?: (event: ScanProgressEvent) => void;
}

export class OnePasswordService {
  private client?: OnePasswordClient;
  private authCacheKey?: string;
  private rawItems = new Map<string, CachedRawItem>();

  async scan(options: ScanOptions): Promise<ScanSnapshot> {
    const scanId = options.scanId ?? randomUUID();
    try {
      return await this.scanOnce({ ...options, scanId });
    } catch (error) {
      if (!isRecoverableClientError(error)) {
        throw error;
      }

      this.clearCache();
      options.onProgress?.({
        type: "progress",
        progress: {
          scanId,
          phase: "scanning",
          totalVaults: 0,
          scannedVaults: 0,
          totalItems: 0,
          scannedItems: 0,
          vaults: [],
          message: "1Password 授权会话已失效，正在重新建立连接。"
        }
      });
      return this.scanOnce({ ...options, scanId });
    }
  }

  private async scanOnce(options: ScanOptions & { scanId: string }): Promise<ScanSnapshot> {
    const scanId = options.scanId;
    const scannedAt = new Date().toISOString();
    let vaults: VaultSummary[] = [];
    const summaries: ItemSummary[] = [];
    const discoveredItemCounts = new Map<string, number>();
    let totalItems = 0;
    let scannedVaults = 0;

    const emit = (type: ScanProgressEvent["type"], message?: string, scan?: ScanSnapshot): void => {
      options.onProgress?.({
        type,
        scan,
        progress: {
          scanId,
          phase: type === "completed" ? "completed" : type === "failed" ? "failed" : "scanning",
          totalVaults: vaults.length,
          scannedVaults,
          totalItems,
          scannedItems: summaries.length,
          vaults:
            type === "completed"
              ? summarizeVaults(vaults, summaries)
              : summarizeVaultProgress(vaults, summaries, discoveredItemCounts),
          message
        }
      });
    };

    emit("started", "正在连接 1Password Desktop App。");
    const client = await this.getClient(options, (message) => emit("progress", message));
    emit("progress", "正在读取保险库列表。");

    const vaultOverviews = await withSdkTrace(client.vaults.list({ decryptDetails: true }), "读取保险库列表");
    vaults = await collectAsync(vaultOverviews, (vault) => ({
      id: String(readAny(vault, "id") ?? ""),
      name: String(readAny(vault, "title", "name") ?? "Untitled vault")
    }));

    const itemIdsByVault = new Map<string, string[]>();
    const scanVaults = vaults.filter((vault) => vault.id);
    this.rawItems.clear();
    let skippedItems = 0;
    let skippedVaultItemLists = 0;

    const vaultConcurrency = options.serviceAccountToken ? maxConcurrentVaultScans : 1;

    await mapConcurrent(scanVaults, vaultConcurrency, async (vault) => {
      emit("progress", `正在读取 ${vault.name} 的项目列表。`);
      const itemIds = await this.readItemIds(client, vault, (message) => {
        skippedVaultItemLists += 1;
        emit("progress", message);
      });
      itemIdsByVault.set(vault.id, itemIds);
      discoveredItemCounts.set(vault.id, itemIds.length);
      totalItems += itemIds.length;
      emit("progress", `已发现 ${vault.name} 中的 ${itemIds.length} 个项目。`);
    });

    if (skippedVaultItemLists > 0 && totalItems === 0) {
      throw new Error(`已发现 ${vaults.length} 个保险库，但无法读取任何项目列表。请确认 1Password Desktop App 已解锁并允许 Optipass 读取数据。`);
    }

    await mapConcurrent(scanVaults, vaultConcurrency, async (vault) => {
      const itemIds = itemIdsByVault.get(vault.id) ?? [];

      const batches = chunks(itemIds, maxGetAllBatchSize);
      for (const [batchIndex, batch] of batches.entries()) {
        emit("progress", `正在读取 ${vault.name} 的项目详情（${batchIndex + 1}/${batches.length}）。`);
        const items = await this.readItemsBatch(client, vault, batch, (message) => {
          skippedItems += 1;
          emit("progress", message);
        });
        for (const item of items) {
          const rawItemId = item.id;
          const appItemId = toAppItemId(vault.id, rawItemId);
          this.rawItems.set(appItemId, {
            item,
            onePasswordItemId: rawItemId,
            vaultId: vault.id
          });
          summaries.push(toItemSummary(item, vault, rawItemId, appItemId));
          emit("progress", `正在读取 ${vault.name}。`);
        }
      }
      scannedVaults += 1;
      emit("progress", `已读取 ${vault.name}。`);
    });

    const scan = {
      scanId,
      scannedAt,
      vaults,
      items: summaries
    };
    emit("completed", completionMessage(skippedItems, skippedVaultItemLists), scan);
    return scan;
  }

  async archive(vaultId: string, onePasswordItemId: string): Promise<void> {
    const client = await this.requireClient();
    await client.items.archive(vaultId, onePasswordItemId);
  }

  async delete(vaultId: string, onePasswordItemId: string): Promise<void> {
    const client = await this.requireClient();
    await client.items.delete(vaultId, onePasswordItemId);
  }

  async copyToVaultAndArchiveSource(appItemId: string, targetVaultId: string): Promise<void> {
    const client = await this.requireClient();
    const cached = this.rawItems.get(appItemId);
    if (!cached) {
      throw new Error(`无法迁移 ${appItemId}：扫描缓存中没有完整项目数据。`);
    }

    const source = cached.item;
    const rawItemId = cached.onePasswordItemId;
    const sourceVaultId = cached.vaultId;
    const sourceFiles = readArray<ItemFile>(source, "files");
    const sourceDocument = readAny(source, "document") as FileAttributes | undefined;
    const files = await Promise.all(
      sourceFiles.map(async (file) => {
        if (!file.attributes || !file.sectionId || !file.fieldId) {
          throw new Error(`无法迁移 ${appItemId}：文件附件元数据不完整。`);
        }

        return {
          name: file.attributes.name,
          content: await client.items.files.read(sourceVaultId, rawItemId, file.attributes),
          sectionId: file.sectionId,
          fieldId: file.fieldId
        };
      })
    );
    const document = sourceDocument
      ? {
          name: sourceDocument.name,
          content: await client.items.files.read(sourceVaultId, rawItemId, sourceDocument)
        }
      : undefined;
    const createParams: ItemCreateParams = {
      category: source.category,
      vaultId: targetVaultId,
      title: String(readAny(source, "title") ?? "Untitled item"),
      fields: readArray<ItemField>(source, "fields"),
      sections: readArray<ItemSection>(source, "sections"),
      notes: String(readAny(source, "notes") ?? ""),
      tags: readArray<string>(source, "tags").map(String),
      websites: readArray<Website>(source, "websites"),
      files,
      document
    };
    await client.items.create(createParams);
    await client.items.archive(sourceVaultId, rawItemId);
  }

  async revealCredentials(appItemId: string): Promise<RevealedCredentialField[]> {
    const cached = this.rawItems.get(appItemId);
    if (!cached) {
      throw new Error(`无法显示凭据材料：扫描缓存中没有 ${appItemId} 的完整项目数据。`);
    }

    return readArray<ItemField>(cached.item, "fields")
      .filter((field) => isCredentialField(field))
      .map((field) => ({
        label: String(readAny(field, "title", "label", "id") ?? "credential"),
        value: String(readAny(field, "value") ?? ""),
        fieldType: fieldType(field)
      }))
      .filter((field) => field.value.length > 0);
  }

  clearCache(): void {
    this.rawItems.clear();
    this.client = undefined;
    this.authCacheKey = undefined;
  }

  private async getClient(options: ScanOptions, onProgress?: (message: string) => void): Promise<OnePasswordClient> {
    const auth = options.serviceAccountToken
      ? options.serviceAccountToken
      : options.accountName
        ? new sdk.DesktopAuth(options.accountName)
        : undefined;

    if (!auth) {
      throw new Error("缺少 1Password 授权信息。");
    }

    const authCacheKey = typeof auth === "string" ? `service:${auth}` : `desktop:${auth.accountName}`;
    if (this.client && this.authCacheKey === authCacheKey) {
      return this.client;
    }

    if (auth instanceof sdk.DesktopAuth) {
      onProgress?.("正在唤起 1Password Desktop App。");
      await openOnePasswordDesktopApp();
      onProgress?.("正在等待 1Password 授权。");
    }

    this.authCacheKey = authCacheKey;
    this.client = await sdk.createClient({
      auth,
      integrationName: "Optimize Password",
      integrationVersion: "0.1.0"
    });
    return this.client;
  }

  private async requireClient(): Promise<OnePasswordClient> {
    if (!this.client) {
      throw new Error("1Password 客户端尚未初始化，请先完成一次真实扫描。");
    }
    return this.client;
  }

  private async readItemIds(
    client: OnePasswordClient,
    vault: VaultSummary,
    onSkipped: (message: string) => void
  ): Promise<string[]> {
    try {
      const overviews = await withSdkTrace(client.items.list(vault.id), `读取 ${vault.name} 的项目列表`);
      return overviews.map((overview) => String(readAny(overview, "id") ?? "")).filter(Boolean);
    } catch (error) {
      onSkipped(`无法读取 ${vault.name} 的项目列表：${errorMessage(error)}`);
      return [];
    }
  }

  private async readItemsBatch(
    client: OnePasswordClient,
    vault: VaultSummary,
    itemIds: string[],
    onSkipped: (message: string) => void
  ): Promise<RawItem[]> {
    try {
      const response = await withSdkTrace(
        client.items.getAll(vault.id, itemIds),
        `批量读取 ${vault.name} 的 ${itemIds.length} 个项目详情`
      );
      const items: RawItem[] = [];
      for (const [index, itemId] of itemIds.entries()) {
        const itemResponse = response.individualResponses[index];
        if (itemResponse?.content) {
          items.push(itemResponse.content);
          continue;
        }
        const item = await this.readSingleItem(
          client,
          vault,
          itemId,
          itemResponse?.error ?? "批量响应缺少项目内容。",
          onSkipped
        );
        if (item) {
          items.push(item);
        }
      }
      return items;
    } catch (error) {
      const items: RawItem[] = [];
      for (const itemId of itemIds) {
        const item = await this.readSingleItem(client, vault, itemId, error, onSkipped);
        if (item) {
          items.push(item);
        }
      }
      return items;
    }
  }

  private async readSingleItem(
    client: OnePasswordClient,
    vault: VaultSummary,
    itemId: string | undefined,
    batchError: unknown,
    onSkipped: (message: string) => void
  ): Promise<RawItem | undefined> {
    if (!itemId) {
      onSkipped(`跳过 ${vault.name} 中一个无法识别 ID 的项目：${errorMessage(batchError)}`);
      return undefined;
    }

    try {
      return await withSdkTrace(client.items.get(vault.id, itemId), `读取 ${vault.name} 项目 ${itemId}`);
    } catch (error) {
      onSkipped(`跳过 ${vault.name} 中一个无法读取的项目：${errorMessage(error) || errorMessage(batchError)}`);
      return undefined;
    }
  }
}

function isRecoverableClientError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  const name = error instanceof Error ? error.name.toLowerCase() : "";
  const text = `${name} ${message}`;
  return (
    text.includes("invalid client id") ||
    text.includes("invalid_client_id") ||
    (text.includes("desktop") && text.includes("session") && text.includes("expired")) ||
    text.includes("ipc operation failed")
  );
}

export const onePasswordLimits = {
  maxGetAllBatchSize,
  sdkSlowLogMs,
  maxConcurrentVaultScans
};

function completionMessage(skippedItems: number, skippedVaultItemLists: number): string {
  const skippedParts = [];
  if (skippedVaultItemLists > 0) {
    skippedParts.push(`${skippedVaultItemLists} 个无法读取项目列表的保险库`);
  }
  if (skippedItems > 0) {
    skippedParts.push(`${skippedItems} 个无法读取的项目`);
  }
  return skippedParts.length > 0 ? `扫描完成，跳过 ${skippedParts.join("、")}。` : "扫描完成，等待手动分析。";
}

function summarizeVaultProgress(
  vaults: VaultSummary[],
  items: ItemSummary[],
  discoveredItemCounts: Map<string, number>
): VaultScanSummary[] {
  return summarizeVaults(vaults, items).map((summary) => ({
    ...summary,
    itemCount: discoveredItemCounts.get(summary.id) ?? summary.itemCount
  }));
}

export function toAppItemId(vaultId: string, onePasswordItemId: string): string {
  return `${vaultId}:${onePasswordItemId}`;
}

function toItemSummary(item: RawItem, vault: VaultSummary, rawItemId: string, appItemId: string): ItemSummary {
  const fields = readArray<ItemField>(item, "fields");
  const websites = readArray<Website>(item, "websites");
  const urls = websites
    .map((website) => String(readAny(website, "url") ?? ""))
    .filter(Boolean);
  const tags = readArray<string>(item, "tags").map(String);
  const notes = String(readAny(item, "notes") ?? "");
  const files = readArray<ItemFile>(item, "files");

  const usernames = fields
    .filter((field) => isUsernameField(field))
    .map((field) => String(readAny(field, "value") ?? ""))
    .filter(Boolean);

  const comparableFields = fields.flatMap((field) => toComparableField(field));

  return {
    id: appItemId,
    onePasswordItemId: rawItemId,
    vaultId: vault.id,
    vaultName: vault.name,
    title: String(readAny(item, "title") ?? "Untitled item"),
    category: mapOnePasswordCategory(String(readAny(item, "category") ?? "")),
    createdAt: toIsoString(readAny(item, "createdAt")),
    updatedAt: toIsoString(readAny(item, "updatedAt")),
    urls,
    usernames,
    tags,
    fieldCount: fields.length,
    hasPassword: fields.some((field) => isPasswordField(field)),
    hasTotp: fields.some((field) => fieldType(field).includes("totp")),
    hasPasskey: fields.some((field) => isSignInWithField(field)),
    hasAttachments: files.length > 0 || Boolean(readAny(item, "document")),
    hasNotes: notes.trim().length > 0,
    comparableFields
  };
}

function toComparableField(field: ItemField): ComparableField[] {
  const type = fieldType(field);
  const label = String(readAny(field, "title", "label", "id") ?? "field");
  const value = String(readAny(field, "value") ?? "");

  if (!value) {
    return [];
  }

  if (type.includes("concealed") || type.includes("totp") || type.includes("password") || type.includes("secret")) {
    return [
      {
        label,
        kind: "secret",
        normalizedValueHash: hashValue(value)
      }
    ];
  }

  const lowerLabel = label.toLowerCase();
  if (type.includes("url") || lowerLabel.includes("url") || lowerLabel.includes("website")) {
    return [{ label, kind: "url", normalizedValue: value }];
  }
  if (type.includes("email") || lowerLabel.includes("email")) {
    return [{ label, kind: "email", normalizedValue: value }];
  }
  if (lowerLabel.includes("phone") || lowerLabel.includes("mobile")) {
    return [{ label, kind: "phone", normalizedValue: value }];
  }
  if (isUsernameField(field)) {
    return [{ label, kind: "username", normalizedValue: value }];
  }
  if (type.includes("credit") || lowerLabel.includes("card")) {
    return [{ label, kind: "card", normalizedValueHash: hashValue(value) }];
  }
  if (type.includes("text") && value.length <= 128) {
    return [{ label, kind: "text", normalizedValue: value }];
  }

  return [];
}

export function mapOnePasswordCategory(value: string): ItemCategory {
  const normalized = value.replace(/[\s_-]/g, "").toLowerCase();
  switch (normalized) {
    case "apicredentials":
      return "api-credential";
    case "bankaccount":
      return "bank-account";
    case "creditcard":
      return "credit-card";
    case "cryptowallet":
      return "crypto-wallet";
    case "database":
      return "database";
    case "document":
      return "document";
    case "driverlicense":
      return "driver-license";
    case "email":
      return "email";
    case "identity":
      return "identity";
    case "login":
      return "login";
    case "medicalrecord":
      return "medical-record";
    case "membership":
      return "membership";
    case "outdoorlicense":
      return "outdoor-license";
    case "passport":
      return "passport";
    case "password":
      return "password";
    case "person":
      return "person";
    case "rewards":
      return "rewards";
    case "router":
      return "router";
    case "securenote":
      return "secure-note";
    case "server":
      return "server";
    case "sshkey":
      return "ssh-key";
    case "socialsecuritynumber":
      return "social-security-number";
    case "softwarelicense":
      return "software-license";
    case "unsupported":
      return "unsupported";
    default:
      return "unknown";
  }
}

function fieldType(field: ItemField): string {
  return String(field.fieldType).toLowerCase();
}

function isUsernameField(field: ItemField): boolean {
  const label = String(readAny(field, "title", "label", "id") ?? "").toLowerCase();
  return label === "username" || label.includes("user name") || label.includes("account");
}

function isPasswordField(field: ItemField): boolean {
  const type = fieldType(field);
  const label = String(readAny(field, "title", "label", "id") ?? "").toLowerCase();
  return (
    !type.includes("totp") &&
    (
      type.includes("concealed") ||
      type.includes("password") ||
      label === "password" ||
      label === "密码"
    )
  );
}

function isCredentialField(field: ItemField): boolean {
  const type = fieldType(field);
  return (
    isPasswordField(field) ||
    type.includes("concealed") ||
    type.includes("totp") ||
    type.includes("secret") ||
    isSignInWithField(field)
  );
}

function isSignInWithField(field: ItemField): boolean {
  const type = fieldType(field);
  const label = String(readAny(field, "title", "label", "id") ?? "").toLowerCase();
  return (
    type.includes("passkey") ||
    type.includes("signinwith") ||
    label.includes("sign in with") ||
    label.includes("login with") ||
    label.includes("登录方式")
  );
}

function hashValue(value: string): string {
  return createHash("sha256").update(value.normalize("NFKC")).digest("base64url");
}

function toIsoString(value: unknown): string | undefined {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  return undefined;
}

function readAny(source: unknown, ...keys: string[]): unknown {
  if (!source || typeof source !== "object") {
    return undefined;
  }
  const record = source as Record<string, unknown>;
  for (const key of keys) {
    if (record[key] !== undefined) {
      return record[key];
    }
  }
  return undefined;
}

function readOptionalString(source: unknown, ...keys: string[]): string | undefined {
  const value = readAny(source, ...keys);
  return value == null ? undefined : String(value);
}

function readArray<T>(source: unknown, key: string): T[] {
  const value = readAny(source, key);
  return Array.isArray(value) ? (value as T[]) : [];
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

async function withSdkTrace<T>(promise: Promise<T>, label: string): Promise<T> {
  const started = Date.now();
  let slowLog: ReturnType<typeof setInterval> | undefined;
  if (sdkSlowLogMs > 0) {
    slowLog = setInterval(() => {
      console.warn(`[1Password SDK] ${label} 已等待 ${Math.round((Date.now() - started) / 1000)} 秒。`);
    }, sdkSlowLogMs);
  }

  try {
    return await promise;
  } finally {
    if (slowLog) {
      clearInterval(slowLog);
    }
  }
}

async function openOnePasswordDesktopApp(): Promise<void> {
  if (process.platform !== "darwin") {
    return;
  }

  try {
    await execFileAsync("open", ["-b", "com.1password.1password"], { timeout: 5_000 });
  } catch (error) {
    console.warn(`[1Password SDK] 无法自动唤起 1Password Desktop App：${errorMessage(error)}`);
  }
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function collectAsync<T, TInput>(
  value: AsyncIterable<TInput> | Iterable<TInput>,
  mapper: (input: TInput) => T
): Promise<T[]> {
  const out: T[] = [];
  for await (const item of asAsyncIterable(value)) {
    out.push(mapper(item));
  }
  return out;
}

async function* asAsyncIterable<T>(value: AsyncIterable<T> | Iterable<T>): AsyncIterable<T> {
  for await (const item of value as AsyncIterable<T>) {
    yield item;
  }
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}

async function mapConcurrent<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(concurrency, 1), items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        await worker(items[index], index);
      }
    })
  );
}
