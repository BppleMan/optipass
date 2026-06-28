import { createHash, randomUUID } from "node:crypto";
import sdk from "@1password/sdk";
import type { FileAttributes, Item, ItemCreateParams, ItemField, ItemFile, ItemSection, Website } from "@1password/sdk";
import {
  ComparableField,
  findDuplicateGroups,
  ItemCategory,
  ItemSummary,
  ScanResult,
  VaultSummary
} from "@optimize-password/core";

type OnePasswordClient = Awaited<ReturnType<typeof sdk.createClient>>;
type RawItem = Item;

interface CachedRawItem {
  item: RawItem;
  onePasswordItemId: string;
  vaultId: string;
}

export interface ScanOptions {
  serviceAccountToken?: string;
  accountName?: string;
}

export class OnePasswordService {
  private client?: OnePasswordClient;
  private authCacheKey?: string;
  private rawItems = new Map<string, CachedRawItem>();

  async scan(options: ScanOptions): Promise<ScanResult> {
    const client = await this.getClient(options);
    const vaults = await collectAsync(await client.vaults.list({ decryptDetails: true }), (vault) => ({
      id: String(readAny(vault, "id") ?? ""),
      name: String(readAny(vault, "title", "name") ?? "Untitled vault")
    }));

    const summaries: ItemSummary[] = [];
    this.rawItems.clear();

    for (const vault of vaults) {
      if (!vault.id) {
        continue;
      }

      const overviews = await client.items.list(vault.id);
      const itemIds = overviews.map((overview) => String(readAny(overview, "id") ?? "")).filter(Boolean);

      for (const batch of chunks(itemIds, 100)) {
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
        }
      }
    }

    return {
      scanId: randomUUID(),
      scannedAt: new Date().toISOString(),
      vaults,
      items: summaries,
      groups: findDuplicateGroups(summaries)
    };
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
      throw new Error(`Cannot migrate ${appItemId}; scan cache does not contain full item data.`);
    }

    const source = cached.item;
    const rawItemId = cached.onePasswordItemId;
    const sourceVaultId = cached.vaultId;
    const sourceFiles = readArray<ItemFile>(source, "files");
    const sourceDocument = readAny(source, "document") as FileAttributes | undefined;
    const files = await Promise.all(
      sourceFiles.map(async (file) => {
        if (!file.attributes || !file.sectionId || !file.fieldId) {
          throw new Error(`Cannot migrate ${appItemId}; file attachment metadata is incomplete.`);
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

  clearCache(): void {
    this.rawItems.clear();
  }

  private async getClient(options: ScanOptions): Promise<OnePasswordClient> {
    const auth = options.serviceAccountToken
      ? options.serviceAccountToken
      : options.accountName
        ? new sdk.DesktopAuth(options.accountName)
        : undefined;

    if (!auth) {
      throw new Error("Missing 1Password authentication details.");
    }

    const authCacheKey = typeof auth === "string" ? `service:${auth}` : `desktop:${auth.accountName}`;
    if (this.client && this.authCacheKey === authCacheKey) {
      return this.client;
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
      throw new Error("1Password client is not initialized. Run a scan first.");
    }
    return this.client;
  }
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
    hasTotp: fields.some((field) => fieldType(field).includes("totp")),
    hasPasskey: fields.some((field) => fieldType(field).includes("passkey")),
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
