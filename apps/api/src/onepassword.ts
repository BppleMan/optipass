import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import sdk from "@1password/sdk";
import type { FileAttributes, Item, ItemCreateParams, ItemField, ItemFile, ItemListFilter, ItemSection, Website } from "@1password/sdk";
import {
  ComparableField,
  ItemCategory,
  ItemSummary,
  normalizeDuplicateFullUrl,
  normalizeSimilarUrl,
  RevealedCredentialField,
  ScanProgressEvent,
  ScanSnapshot,
  summarizeVaults,
  VaultScanSummary,
  VaultSummary
} from "@optimize-password/core";
import type { CopyToVaultResult, ItemStateSnapshot } from "./app.js";

type OnePasswordClient = Awaited<ReturnType<typeof sdk.createClient>>;
type RawItem = Item;
const maxGetAllBatchSize = 50;
const sdkSlowLogMs = readPositiveInteger(process.env.OP_SDK_SLOW_LOG_MS, 15_000);
const execFileAsync = promisify(execFile);

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
    const startedAt = Date.now();
    const scannedAt = new Date(startedAt).toISOString();
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
          startedAt: scannedAt,
          finishedAt: type === "completed" || type === "failed" ? new Date().toISOString() : undefined,
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
    vaults = await collectAsync(await client.vaults.list({ decryptDetails: true }), (vault) => ({
      id: String(readAny(vault, "id") ?? ""),
      name: String(readAny(vault, "title", "name") ?? "Untitled vault")
    }));

    const itemIdsByVault = new Map<string, string[]>();
    this.rawItems.clear();

    for (const vault of vaults) {
      if (!vault.id) {
        continue;
      }

      const overviews = await client.items.list(vault.id);
      const itemIds = overviews.map((overview) => String(readAny(overview, "id") ?? "")).filter(Boolean);
      itemIdsByVault.set(vault.id, itemIds);
      discoveredItemCounts.set(vault.id, itemIds.length);
      totalItems += itemIds.length;
      emit("progress", `已发现 ${vault.name} 中的 ${itemIds.length} 个项目。`);
    }

    for (const vault of vaults) {
      const itemIds = itemIdsByVault.get(vault.id) ?? [];
      if (!vault.id) {
        continue;
      }

      for (const batch of chunks(itemIds, maxGetAllBatchSize)) {
        const response = await client.items.getAll(vault.id, batch);
        for (const itemResponse of response.individualResponses) {
          if (!itemResponse.content) {
            continue;
          }

          const item = itemResponse.content;
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
    }

    const scan = {
      scanId,
      scannedAt,
      durationMs: Date.now() - startedAt,
      vaults,
      items: summaries
    };
    emit("completed", "扫描完成，等待手动分析。", scan);
    return scan;
  }

  async archive(vaultId: string, onePasswordItemId: string): Promise<void> {
    const client = await this.requireClient();
    await client.items.archive(vaultId, onePasswordItemId);
    this.rawItems.delete(toAppItemId(vaultId, onePasswordItemId));
  }

  async delete(vaultId: string, onePasswordItemId: string): Promise<void> {
    const client = await this.requireClient();
    await client.items.delete(vaultId, onePasswordItemId);
    this.rawItems.delete(toAppItemId(vaultId, onePasswordItemId));
  }

  async removeTags(appItemId: string, removeTags: string[]): Promise<void> {
    const client = await this.requireClient();
    const cached = this.rawItems.get(appItemId);
    if (!cached) {
      throw new Error(`无法更新 ${appItemId}：扫描缓存中没有完整项目数据。`);
    }

    const latest = await client.items.get(cached.vaultId, cached.onePasswordItemId);
    const removeSet = new Set(removeTags);
    const currentTags = readArray<string>(latest, "tags").map(String);
    const nextTags = currentTags.filter((tag) => !removeSet.has(tag));
    if (nextTags.length === currentTags.length) {
      return;
    }

    const updated = await client.items.put({ ...latest, tags: nextTags });
    this.rawItems.set(appItemId, { ...cached, item: updated });
  }

  async copyToVaultAndArchiveSource(appItemId: string, targetVaultId: string, removeTags: string[] = []): Promise<CopyToVaultResult> {
    const client = await this.requireClient();
    const cached = this.rawItems.get(appItemId);
    if (!cached) {
      throw new Error(`无法迁移 ${appItemId}：扫描缓存中没有完整项目数据。`);
    }

    const rawItemId = cached.onePasswordItemId;
    const sourceVaultId = cached.vaultId;
    const source = await client.items.get(sourceVaultId, rawItemId);
    const removeTagSet = new Set(removeTags);
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
      tags: readArray<string>(source, "tags").map(String).filter((tag) => !removeTagSet.has(tag)),
      websites: readArray<Website>(source, "websites"),
      files,
      document
    };
    const created = await client.items.create(createParams);
    const createdItemId = String(readAny(created, "id") ?? "");
    if (!createdItemId) {
      throw new Error(`无法迁移 ${appItemId}：目标保险库的新 item 缺少 ID。`);
    }
    await client.items.archive(sourceVaultId, rawItemId);
    this.rawItems.delete(appItemId);
    this.rawItems.set(toAppItemId(targetVaultId, createdItemId), {
      item: created,
      onePasswordItemId: createdItemId,
      vaultId: targetVaultId
    });
    return { createdItemId };
  }

  async listItemStates(vaultId: string): Promise<ItemStateSnapshot> {
    const client = await this.requireClient();
    const activeFilter: ItemListFilter = {
      type: "ByState",
      content: {
        active: true,
        archived: false
      }
    };
    const archivedFilter: ItemListFilter = {
      type: "ByState",
      content: {
        active: false,
        archived: true
      }
    };
    const [activeOverviews, archivedOverviews] = await Promise.all([
      withSdkTrace(client.items.list(vaultId, activeFilter), `读取保险库 ${vaultId} 的活跃项目列表`),
      withSdkTrace(client.items.list(vaultId, archivedFilter), `读取保险库 ${vaultId} 的归档项目列表`)
    ]);
    return {
      activeIds: activeOverviews.map((overview) => String(readAny(overview, "id") ?? "")).filter(Boolean),
      archivedIds: archivedOverviews.map((overview) => String(readAny(overview, "id") ?? "")).filter(Boolean)
    };
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

}

export const onePasswordLimits = {
  maxGetAllBatchSize
};

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
  const analysisIdentityValues = uniqueSorted([
    ...usernames,
    ...comparableFields
      .filter((field) => field.kind === "username" || field.kind === "email" || field.kind === "phone")
      .map((field) => field.normalizedValue ?? "")
  ].filter((value) => value.length > 0));

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
    comparableFields,
    analysis: {
      notesText: notes,
      notesValueHash: hashRawValue(notes),
      exactUrlKeys: uniqueSorted(urls.map((url) => normalizeDuplicateFullUrl(url)).filter((url): url is string => Boolean(url))),
      similarUrlKeys: uniqueSorted(urls.map((url) => normalizeSimilarUrl(url)).filter((url): url is string => Boolean(url))),
      identityValues: analysisIdentityValues,
      fieldSignatures: fields.map((field) => exactFieldSignature(field)).sort()
    }
  };
}

function exactFieldSignature(field: ItemField): string {
  const label = String(readAny(field, "title", "label", "id") ?? "field");
  const value = String(readAny(field, "value") ?? "");
  return JSON.stringify({
    label,
    fieldType: fieldType(field),
    credentialKind: exactFieldCredentialKind(field),
    valueHash: hashRawValue(value)
  });
}

function exactFieldCredentialKind(field: ItemField): string {
  const type = fieldType(field);
  if (isSignInWithField(field)) {
    return "passkey";
  }
  if (type.includes("totp")) {
    return "totp";
  }
  if (isPasswordField(field)) {
    return "password";
  }
  if (type.includes("concealed") || type.includes("secret")) {
    return "secret";
  }
  return "non-credential";
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

function hashRawValue(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
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
