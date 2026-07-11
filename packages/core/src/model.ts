export type ItemCategory =
  | "api-credential"
  | "bank-account"
  | "credit-card"
  | "crypto-wallet"
  | "database"
  | "document"
  | "driver-license"
  | "email"
  | "identity"
  | "login"
  | "medical-record"
  | "membership"
  | "outdoor-license"
  | "passport"
  | "person"
  | "password"
  | "rewards"
  | "router"
  | "secure-note"
  | "server"
  | "ssh-key"
  | "social-security-number"
  | "software-license"
  | "unsupported"
  | "unknown";

export type DuplicateRule =
  | "title"
  | "url"
  | "username-url"
  | "credential-material"
  | "item-fingerprint"
  | "missing-account-identity"
  | "missing-credential-material";

export type DuplicateCandidateClass =
  | "exact-duplicate"
  | "similar-login"
  | "misc-title"
  | "delete-suggestion";

export interface VaultSummary {
  id: string;
  name: string;
}

export interface ComparableField {
  label: string;
  kind: "username" | "url" | "email" | "phone" | "text" | "secret" | "card" | "unknown";
  normalizedValueHash?: string;
  normalizedValue?: string;
}

export interface ItemAnalysisMaterial {
  /** Internal-only raw note text for local search. API responses must strip this material. */
  notesText?: string;
  notesValueHash: string;
  exactUrlKeys: string[];
  similarUrlKeys: string[];
  identityValues: string[];
  fieldSignatures: string[];
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

export interface DuplicateReason {
  rule: DuplicateRule;
  key: string;
  label: string;
  itemIds: string[];
}

export interface DuplicateGroup {
  id: string;
  candidateClass: DuplicateCandidateClass;
  itemIds: string[];
  reasons: DuplicateReason[];
  recommendedKeepIds: string[];
  recommendedKeepReasons: RecommendedKeepReason[];
  confidence: "high" | "medium" | "low";
}

export interface RecommendedKeepReason {
  itemId: string;
  score: number;
  labels: string[];
}

export interface ScanSnapshot {
  scanId: string;
  scannedAt: string;
  vaults: VaultSummary[];
  items: ItemSummary[];
}

export interface ScanResult extends ScanSnapshot {
  analyzedAt: string;
  groups: DuplicateGroup[];
}

export type ScanPhase = "idle" | "scanning" | "completed" | "failed";

export type DashboardCategory =
  | "login"
  | "secure-note"
  | "credit-card"
  | "document"
  | "password"
  | "api-credential"
  | "database"
  | "ssh-key"
  | "identity"
  | "server"
  | "software-license"
  | "other";

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
  totalVaults: number;
  scannedVaults: number;
  totalItems: number;
  scannedItems: number;
  vaults: VaultScanSummary[];
  message?: string;
  error?: string;
}

export type ScanProgressEventType = "started" | "progress" | "completed" | "failed";

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
  { id: "login", label: "登录信息", categories: ["login"] },
  { id: "secure-note", label: "安全备注", categories: ["secure-note"] },
  { id: "credit-card", label: "信用卡片", categories: ["credit-card"] },
  { id: "document", label: "文档", categories: ["document"] },
  { id: "password", label: "密码", categories: ["password"] },
  { id: "api-credential", label: "API 凭据", categories: ["api-credential"] },
  { id: "database", label: "数据库", categories: ["database"] },
  { id: "ssh-key", label: "SSH 密钥", categories: ["ssh-key"] },
  { id: "identity", label: "身份标识", categories: ["identity"] },
  { id: "server", label: "服务器", categories: ["server"] },
  { id: "software-license", label: "软件许可", categories: ["software-license"] },
  { id: "other", label: "其它", categories: [] }
];

export function dashboardCategoryFor(category: ItemCategory): DashboardCategory {
  return dashboardCategoryDefinitions.find((definition) => definition.categories.includes(category))?.id ?? "other";
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

export interface ItemDecision {
  itemId: string;
  keep: boolean;
  targetVaultId?: string;
  deleteMode?: "archive" | "delete";
  removeTags?: string[];
}

export interface GroupDecision {
  scanId: string;
  groupId: string;
  items: ItemDecision[];
}

export type PlanAction =
  | {
      type: "keep";
      itemId: string;
      vaultId: string;
      targetVaultId: string;
    }
  | {
      type: "update-tags";
      itemId: string;
      vaultId: string;
      removeTags: string[];
    }
  | {
      type: "archive" | "delete";
      itemId: string;
      vaultId: string;
    }
  | {
      type: "copy-to-vault-and-archive-source";
      itemId: string;
      vaultId: string;
      targetVaultId: string;
      removeTags: string[];
    };

export interface ExecutionPlan {
  createdAt: string;
  groupId: string;
  actions: PlanAction[];
  summary: ExecutionPlanSummary;
  warnings: string[];
  blockers: string[];
  requiresExplicitDeleteConfirmation: boolean;
}

export interface ExecutionPlanSummary {
  keep: number;
  archive: number;
  delete: number;
  move: number;
  tagUpdate: number;
  removedTagCount: number;
  affectedVaultIds: string[];
}
