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

export interface ScanResult {
  scanId: string;
  scannedAt: string;
  vaults: VaultSummary[];
  items: ItemSummary[];
  groups: DuplicateGroup[];
}

export interface ItemDecision {
  itemId: string;
  keep: boolean;
  targetVaultId?: string;
  deleteMode?: "archive" | "delete";
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
      type: "archive" | "delete";
      itemId: string;
      vaultId: string;
    }
  | {
      type: "copy-to-vault-and-archive-source";
      itemId: string;
      vaultId: string;
      targetVaultId: string;
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
  affectedVaultIds: string[];
}
