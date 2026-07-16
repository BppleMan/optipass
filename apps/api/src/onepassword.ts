import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import sdk from "@1password/sdk";
import type { FileAttributes, Item, ItemCreateParams, ItemField, ItemFile, ItemListFilter, ItemSection, Website } from "@1password/sdk";
import {
  ComparableField,
  ComparableFieldKind,
  ItemCategory,
  ItemFieldKind,
  ItemFieldSensitivity,
  ItemPatch,
  ItemSummary,
  RevealedCredentialField,
  ScanProgressEvent,
  ScanPhase,
  ScanProgressEventType,
  ScanSnapshot,
  summarizeVaults,
  VaultScanSummary,
  VaultSummary
} from "@optimize-password/core";

export interface ItemStateSnapshot {
  activeIds: string[];
  archivedIds: string[];
}

export interface CopyToVaultResult {
  createdItemId: string;
}

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

export interface OnePasswordCanonicalMaterial {
  sections: Array<{ id: string; label: string }>;
  fields: Array<{ id: string; sectionId?: string; label: string; kind: ItemFieldKind; sensitivity: ItemFieldSensitivity; value?: string }>;
  attachments: Array<{ id: string; name: string; mediaType?: string; size?: number }>;
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
          phase: type === ScanProgressEventType.Completed ? ScanPhase.Completed
            : type === ScanProgressEventType.Failed ? ScanPhase.Failed : ScanPhase.Scanning,
          startedAt: scannedAt,
          finishedAt: type === ScanProgressEventType.Completed || type === ScanProgressEventType.Failed ? new Date().toISOString() : undefined,
          totalVaults: vaults.length,
          scannedVaults,
          totalItems,
          scannedItems: summaries.length,
          vaults:
            type === ScanProgressEventType.Completed
              ? summarizeVaults(vaults, summaries)
              : summarizeVaultProgress(vaults, summaries, discoveredItemCounts),
          message
        }
      });
    };

    emit(ScanProgressEventType.Started, "正在连接 1Password Desktop App。");
    const client = await this.getClient(options, (message) => emit(ScanProgressEventType.Progress, message));
    emit(ScanProgressEventType.Progress, "正在读取保险库列表。");
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
      emit(ScanProgressEventType.Progress, `已发现 ${vault.name} 中的 ${itemIds.length} 个项目。`);
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
          emit(ScanProgressEventType.Progress, `正在读取 ${vault.name}。`);
        }
      }
      scannedVaults += 1;
      emit(ScanProgressEventType.Progress, `已读取 ${vault.name}。`);
    }

    const scan = {
      scanId,
      scannedAt,
      durationMs: Date.now() - startedAt,
      vaults,
      items: summaries
    };
    emit(ScanProgressEventType.Completed, "扫描完成，等待手动分析。", scan);
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

  async updateTitle(appItemId: string, title: string): Promise<void> {
    const client = await this.requireClient();
    const cached = this.rawItems.get(appItemId);
    if (!cached) {
      throw new Error(`无法更新 ${appItemId}：扫描缓存中没有完整项目数据。`);
    }

    const latest = await client.items.get(cached.vaultId, cached.onePasswordItemId);
    if (String(readAny(latest, "title") ?? "") === title) {
      return;
    }
    const updated = await client.items.put({ ...latest, title });
    this.rawItems.set(appItemId, { ...cached, item: updated });
  }

  async updateItem(appItemId: string, patch: ItemPatch): Promise<void> {
    const client = await this.requireClient();
    const cached = this.rawItems.get(appItemId);
    if (!cached) {
      throw new Error(`无法更新 ${appItemId}：扫描缓存中没有完整项目数据。`);
    }
    const latest = await client.items.get(cached.vaultId, cached.onePasswordItemId);
    const currentTitle = String(readAny(latest, "title") ?? "");
    const currentTags = readArray<string>(latest, "tags").map(String);
    const nextTitle = patch.title ?? currentTitle;
    const nextTags = patch.tags ?? currentTags;
    if (nextTitle === currentTitle && nextTags.length === currentTags.length && nextTags.every((tag, index) => tag === currentTags[index])) {
      return;
    }
    const updated = await client.items.put({ ...latest, title: nextTitle, tags: nextTags });
    this.rawItems.set(appItemId, { ...cached, item: updated });
  }

  async copyToVaultAndArchiveSource(appItemId: string, targetVaultId: string, removeTags: string[] = [], title?: string): Promise<CopyToVaultResult> {
    const result = await this.copyToVault(appItemId, targetVaultId, removeTags, title);
    const cached = this.rawItems.get(appItemId);
    if (!cached) {
      throw new Error(`无法迁移 ${appItemId}：扫描缓存中没有完整项目数据。`);
    }
    await this.archive(cached.vaultId, cached.onePasswordItemId);
    return result;
  }

  async copyToVault(appItemId: string, targetVaultId: string, removeTags: string[] = [], title?: string): Promise<CopyToVaultResult> {
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
    const sourceDocument = readAny(source, "document") as FileAttributes;
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
      title: title ?? String(readAny(source, "title") ?? "Untitled item"),
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

  canonicalMaterial(appItemId: string): OnePasswordCanonicalMaterial {
    const cached = this.rawItems.get(appItemId);
    if (!cached) {
      throw new Error(`无法建立规范 Item：扫描缓存中没有 ${appItemId} 的完整项目数据。`);
    }
    const sections = readArray<ItemSection>(cached.item, "sections").map((section) => ({
      id: String(readAny(section, "id") ?? ""),
      label: String(readAny(section, "title", "label") ?? ""),
    })).filter((section) => section.id.length > 0);
    const fields = readArray<ItemField>(cached.item, "fields").map((field, index) => {
      const value = String(readAny(field, "value") ?? "");
      const kind = canonicalFieldKind(field);
      return {
        id: String(readAny(field, "id") ?? index),
        sectionId: String(readAny(field, "sectionId") ?? "") || undefined,
        label: String(readAny(field, "title", "label", "id") ?? "field"),
        kind,
        sensitivity: canonicalSensitivity(kind),
        value: value || undefined,
      };
    });
    const attachments = readArray<ItemFile>(cached.item, "files").map((file, index) => ({
      id: String(readAny(file, "id", "fieldId") ?? index),
      name: String(readAny(file.attributes, "name") ?? "attachment"),
      mediaType: String(readAny(file.attributes, "contentPath", "type") ?? "") || undefined,
      size: Number(readAny(file.attributes, "size") ?? 0) || undefined,
    }));
    return { sections, fields, attachments };
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
  return {
    id: appItemId,
    onePasswordItemId: rawItemId,
    vaultId: vault.id,
    vaultName: vault.name,
    title: String(readAny(item, "title") ?? "Untitled item"),
    category: mapOnePasswordCategory(String(readAny(item, "category") ?? "")),
    createdAt: toIsoString(readAny(item, "createdAt")).value,
    updatedAt: toIsoString(readAny(item, "updatedAt")).value,
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
      notesText: notes
    }
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
        kind: ComparableFieldKind.Secret,
        normalizedValueHash: hashValue(value)
      }
    ];
  }

  const lowerLabel = label.toLowerCase();
  if (type.includes("url") || lowerLabel.includes("url") || lowerLabel.includes("website")) {
    return [{ label, kind: ComparableFieldKind.Url, normalizedValue: value }];
  }
  if (type.includes("email") || lowerLabel.includes("email")) {
    return [{ label, kind: ComparableFieldKind.Email, normalizedValue: value }];
  }
  if (lowerLabel.includes("phone") || lowerLabel.includes("mobile")) {
    return [{ label, kind: ComparableFieldKind.Phone, normalizedValue: value }];
  }
  if (isUsernameField(field)) {
    return [{ label, kind: ComparableFieldKind.Username, normalizedValue: value }];
  }
  if (type.includes("credit") || lowerLabel.includes("card")) {
    return [{ label, kind: ComparableFieldKind.Card, normalizedValueHash: hashValue(value) }];
  }
  if (type.includes("text") && value.length <= 128) {
    return [{ label, kind: ComparableFieldKind.Text, normalizedValue: value }];
  }

  return [];
}

function canonicalFieldKind(field: ItemField): ItemFieldKind {
  const type = fieldType(field);
  const label = String(readAny(field, "title", "label", "id") ?? "").toLowerCase();
  if (isSignInWithField(field)) return ItemFieldKind.Passkey;
  if (type.includes("totp")) return ItemFieldKind.Totp;
  if (isPasswordField(field)) return ItemFieldKind.Password;
  if (type.includes("email") || label.includes("email")) return ItemFieldKind.Email;
  if (isUsernameField(field)) return ItemFieldKind.Username;
  if (type.includes("url") || label.includes("url") || label.includes("website")) return ItemFieldKind.Url;
  if (type.includes("concealed") || type.includes("secret")) return ItemFieldKind.Secret;
  if (type.includes("credit") || label.includes("card")) return ItemFieldKind.Card;
  if (type.includes("text")) return ItemFieldKind.Text;
  return ItemFieldKind.Unknown;
}

function canonicalSensitivity(kind: ItemFieldKind): ItemFieldSensitivity {
  if (kind === ItemFieldKind.Password || kind === ItemFieldKind.Totp || kind === ItemFieldKind.Secret || kind === ItemFieldKind.Card) {
    return ItemFieldSensitivity.Secret;
  }
  return kind === ItemFieldKind.Url || kind === ItemFieldKind.Text ? ItemFieldSensitivity.Public : ItemFieldSensitivity.Private;
}

export function mapOnePasswordCategory(value: string): ItemCategory {
  const normalized = value.replace(/[\s_-]/g, "").toLowerCase();
  switch (normalized) {
    case "apicredentials":
      return ItemCategory.ApiCredential;
    case "bankaccount":
      return ItemCategory.BankAccount;
    case "creditcard":
      return ItemCategory.CreditCard;
    case "cryptowallet":
      return ItemCategory.CryptoWallet;
    case "database":
      return ItemCategory.Database;
    case "document":
      return ItemCategory.Document;
    case "driverlicense":
      return ItemCategory.DriverLicense;
    case "email":
      return ItemCategory.Email;
    case "identity":
      return ItemCategory.Identity;
    case "login":
      return ItemCategory.Login;
    case "medicalrecord":
      return ItemCategory.MedicalRecord;
    case "membership":
      return ItemCategory.Membership;
    case "outdoorlicense":
      return ItemCategory.OutdoorLicense;
    case "passport":
      return ItemCategory.Passport;
    case "password":
      return ItemCategory.Password;
    case "person":
      return ItemCategory.Person;
    case "rewards":
      return ItemCategory.Rewards;
    case "router":
      return ItemCategory.Router;
    case "securenote":
      return ItemCategory.SecureNote;
    case "server":
      return ItemCategory.Server;
    case "sshkey":
      return ItemCategory.SshKey;
    case "socialsecuritynumber":
      return ItemCategory.SocialSecurityNumber;
    case "softwarelicense":
      return ItemCategory.SoftwareLicense;
    case "unsupported":
      return ItemCategory.Unsupported;
    default:
      return ItemCategory.Unknown;
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


function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

interface StringLookup {
  value?: string;
}

function toIsoString(value: unknown): StringLookup {
  if (value instanceof Date) {
    return { value: value.toISOString() };
  }
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? {} : { value: date.toISOString() };
  }
  return {};
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
  const trace: { slowLog?: ReturnType<typeof setInterval> } = {};
  if (sdkSlowLogMs > 0) {
    trace.slowLog = setInterval(() => {
      console.warn(`[1Password SDK] ${label} 已等待 ${Math.round((Date.now() - started) / 1000)} 秒。`);
    }, sdkSlowLogMs);
  }

  try {
    return await promise;
  } finally {
    if (trace.slowLog) {
      clearInterval(trace.slowLog);
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

function readPositiveInteger(value: unknown, fallback: number): number {
  if (typeof value !== "string" || !value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function collectAsync<T, TInput>(
  value: unknown,
  mapper: (input: TInput) => T
): Promise<T[]> {
  const out: T[] = [];
  for await (const item of asAsyncIterable<TInput>(value)) {
    out.push(mapper(item));
  }
  return out;
}

async function* asAsyncIterable<T>(value: unknown): AsyncIterable<T> {
  if (!value || typeof value !== "object" || !(Symbol.asyncIterator in value) && !(Symbol.iterator in value)) {
    throw new Error("1Password SDK 返回了不可迭代的数据。");
  }
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
