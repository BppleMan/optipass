import { ItemCategory } from "./domain.js";

export { ItemCategory } from "./domain.js";

export enum SimilarityRule {
    AccountIdentityUrl = "account-identity-url",
    TitleUrl = "title-url",
}

export enum ComparableFieldKind {
    Username = "username",
    Url = "url",
    Email = "email",
    Phone = "phone",
    Text = "text",
    Secret = "secret",
    Card = "card",
    Unknown = "unknown",
}

export interface VaultSummary {
  id: string;
  name: string;
}

export interface ComparableField {
  label: string;
  kind: ComparableFieldKind;
  normalizedValueHash?: string;
  normalizedValue?: string;
}

export interface ItemAnalysisMaterial {
  /** Internal-only raw note text for local search. API responses must strip this material. */
  notesText?: string;
}

export interface ItemSummary {
  /** Internal stable id used by this app, normally `${vaultId}:${onePasswordItemId}`. */
  id: string;
  onePasswordItemId: string;
  vaultId: string;
  vaultName: string;
  title: string;
  category: ItemCategory;
  createdAt?: string;
  updatedAt?: string;
  urls: string[];
  usernames: string[];
  tags: string[];
  fieldCount: number;
  hasPassword: boolean;
  hasTotp: boolean;
  hasPasskey: boolean;
  hasAttachments: boolean;
  hasNotes: boolean;
  comparableFields: ComparableField[];
  analysis?: ItemAnalysisMaterial;
}

export interface SimilarityReason {
  rule: SimilarityRule;
  label: string;
  itemIds: string[];
}

export interface SimilarityGroup {
  id: string;
  itemIds: string[];
  reasons: SimilarityReason[];
  recommendedKeepIds: string[];
  recommendedKeepReasons: RecommendedKeepReason[];
}

export interface RecommendedKeepReason {
  itemId: string;
  score: number;
  labels: string[];
}

export interface ScanSnapshot {
  scanId: string;
  scannedAt: string;
  durationMs?: number;
  vaults: VaultSummary[];
  items: ItemSummary[];
}

export interface ScanResult extends ScanSnapshot {
  storeVersion: number;
  analyzedAt: string;
  groups: SimilarityGroup[];
}

export enum ScanPhase {
    Idle = "idle",
    Scanning = "scanning",
    Completed = "completed",
    Failed = "failed",
}

export enum DashboardCategory {
    Login = "login",
    SecureNote = "secure-note",
    CreditCard = "credit-card",
    Document = "document",
    Password = "password",
    ApiCredential = "api-credential",
    Database = "database",
    SshKey = "ssh-key",
    Identity = "identity",
    Server = "server",
    SoftwareLicense = "software-license",
    Other = "other",
}

export interface DashboardCategoryDefinition {
  id: DashboardCategory;
  label: string;
  categories: ItemCategory[];
}

export interface VaultScanSummary {
  id: string;
  name: string;
  itemCount: number;
  categoryCounts: Record<DashboardCategory, number>;
}

export interface ScanProgress {
  scanId: string;
  phase: ScanPhase;
  startedAt?: string;
  finishedAt?: string;
  totalVaults: number;
  scannedVaults: number;
  totalItems: number;
  scannedItems: number;
  vaults: VaultScanSummary[];
  message?: string;
  error?: string;
}

export enum ScanProgressEventType {
    Started = "started",
    Progress = "progress",
    Completed = "completed",
    Failed = "failed",
}

export interface ScanProgressEvent {
  type: ScanProgressEventType;
  progress: ScanProgress;
  scan?: ScanSnapshot;
  error?: string;
}

export interface RevealedCredentialField {
  label: string;
  value: string;
  fieldType: string;
}

export interface RevealCredentialsResponse {
  scanId: string;
  itemId: string;
  fields: RevealedCredentialField[];
  expiresInSeconds: number;
}

export const dashboardCategoryDefinitions: DashboardCategoryDefinition[] = [
  { id: DashboardCategory.Login, label: "登录信息", categories: [ItemCategory.Login] },
  { id: DashboardCategory.SecureNote, label: "安全备注", categories: [ItemCategory.SecureNote] },
  { id: DashboardCategory.CreditCard, label: "信用卡片", categories: [ItemCategory.CreditCard] },
  { id: DashboardCategory.Document, label: "文档", categories: [ItemCategory.Document] },
  { id: DashboardCategory.Password, label: "密码", categories: [ItemCategory.Password] },
  { id: DashboardCategory.ApiCredential, label: "API 凭据", categories: [ItemCategory.ApiCredential] },
  { id: DashboardCategory.Database, label: "数据库", categories: [ItemCategory.Database] },
  { id: DashboardCategory.SshKey, label: "SSH 密钥", categories: [ItemCategory.SshKey] },
  { id: DashboardCategory.Identity, label: "身份标识", categories: [ItemCategory.Identity] },
  { id: DashboardCategory.Server, label: "服务器", categories: [ItemCategory.Server] },
  { id: DashboardCategory.SoftwareLicense, label: "软件许可", categories: [ItemCategory.SoftwareLicense] },
  { id: DashboardCategory.Other, label: "其它", categories: [] }
];

export function dashboardCategoryFor(category: ItemCategory): DashboardCategory {
  return dashboardCategoryDefinitions.find((definition) => definition.categories.includes(category))?.id ?? DashboardCategory.Other;
}

export function emptyDashboardCategoryCounts(): Record<DashboardCategory, number> {
  return dashboardCategoryDefinitions.reduce(
    (counts, definition) => ({
      ...counts,
      [definition.id]: 0
    }),
    {} as Record<DashboardCategory, number>
  );
}

export function summarizeVaults(vaults: VaultSummary[], items: ItemSummary[]): VaultScanSummary[] {
  const summaries = new Map<string, VaultScanSummary>();
  for (const vault of vaults) {
    summaries.set(vault.id, {
      id: vault.id,
      name: vault.name,
      itemCount: 0,
      categoryCounts: emptyDashboardCategoryCounts()
    });
  }

  for (const item of items) {
    const summary = summaries.get(item.vaultId);
    if (!summary) {
      continue;
    }
    const category = dashboardCategoryFor(item.category);
    summary.itemCount += 1;
    summary.categoryCounts[category] += 1;
  }

  return Array.from(summaries.values());
}
