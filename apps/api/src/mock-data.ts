import { randomUUID } from "node:crypto";
import { ComparableFieldKind, findSimilarityGroups, ItemCategory, ItemSummary, ScanResult, VaultSummary } from "@optimize-password/core";

const vaults: VaultSummary[] = [
  { id: "vault-personal", name: "Personal" },
  { id: "vault-work", name: "Work" },
  { id: "vault-archive", name: "Archive" }
];

const items: ItemSummary[] = [
  {
    id: "vault-personal:github-1",
    onePasswordItemId: "github-1",
    vaultId: "vault-personal",
    vaultName: "Personal",
    title: "GitHub",
    category: ItemCategory.Login,
    createdAt: "2025-12-01T12:00:00.000Z",
    updatedAt: "2026-06-01T12:00:00.000Z",
    urls: ["https://github.com/login"],
    usernames: ["alice@example.com"],
    tags: ["dev", "work", "CSV Import 2025-10-16 12:33 AM"],
    fieldCount: 5,
    hasPassword: true,
    hasTotp: true,
    hasPasskey: false,
    hasAttachments: false,
    hasNotes: true,
    comparableFields: [
      { label: "username", kind: ComparableFieldKind.Username, normalizedValue: "alice@example.com" },
      { label: "password", kind: ComparableFieldKind.Secret, normalizedValueHash: "mock-github-work-secret" }
    ],
    analysis: {
      notesText: "GitHub work account"
    }
  },
  {
    id: "vault-work:github-2",
    onePasswordItemId: "github-2",
    vaultId: "vault-work",
    vaultName: "Work",
    title: "github copy",
    category: ItemCategory.Login,
    createdAt: "2024-05-01T12:00:00.000Z",
    updatedAt: "2026-05-15T12:00:00.000Z",
    urls: ["https://github.com/login/"],
    usernames: ["alice@example.com"],
    tags: ["imported", "work"],
    fieldCount: 3,
    hasPassword: true,
    hasTotp: false,
    hasPasskey: false,
    hasAttachments: false,
    hasNotes: false,
    comparableFields: [
      { label: "username", kind: ComparableFieldKind.Username, normalizedValue: "alice@example.com" },
      { label: "password", kind: ComparableFieldKind.Secret, normalizedValueHash: "mock-github-secret" }
    ]
  },
  {
    id: "vault-personal:aws-1",
    onePasswordItemId: "aws-1",
    vaultId: "vault-personal",
    vaultName: "Personal",
    title: "AWS root",
    category: ItemCategory.ApiCredential,
    createdAt: "2026-01-01T12:00:00.000Z",
    updatedAt: "2026-06-10T12:00:00.000Z",
    urls: ["https://console.aws.amazon.com"],
    usernames: ["ops@example.com"],
    tags: ["cloud"],
    fieldCount: 6,
    hasPassword: true,
    hasTotp: true,
    hasPasskey: false,
    hasAttachments: true,
    hasNotes: true,
    comparableFields: [
      { label: "access key", kind: ComparableFieldKind.Text, normalizedValue: "AKIA-MOCK-KEY" },
      { label: "secret key", kind: ComparableFieldKind.Secret, normalizedValueHash: "mock-aws-secret" }
    ]
  },
  {
    id: "vault-archive:aws-2",
    onePasswordItemId: "aws-2",
    vaultId: "vault-archive",
    vaultName: "Archive",
    title: "AWS root",
    category: ItemCategory.ApiCredential,
    createdAt: "2023-01-01T12:00:00.000Z",
    updatedAt: "2024-01-01T12:00:00.000Z",
    urls: ["https://console.aws.amazon.com"],
    usernames: ["ops@example.com"],
    tags: ["old"],
    fieldCount: 3,
    hasPassword: true,
    hasTotp: false,
    hasPasskey: false,
    hasAttachments: false,
    hasNotes: false,
    comparableFields: [
      { label: "access key", kind: ComparableFieldKind.Text, normalizedValue: "AKIA-MOCK-KEY" },
      { label: "secret key", kind: ComparableFieldKind.Secret, normalizedValueHash: "mock-aws-secret" }
    ]
  },
  {
    id: "vault-personal:linear-1",
    onePasswordItemId: "linear-1",
    vaultId: "vault-personal",
    vaultName: "Personal",
    title: "Linear",
    category: ItemCategory.Login,
    createdAt: "2025-03-01T12:00:00.000Z",
    updatedAt: "2026-02-12T12:00:00.000Z",
    urls: ["https://linear.app/login"],
    usernames: ["alice@example.com"],
    tags: ["product"],
    fieldCount: 4,
    hasPassword: true,
    hasTotp: false,
    hasPasskey: false,
    hasAttachments: false,
    hasNotes: false,
    comparableFields: [
      { label: "username", kind: ComparableFieldKind.Username, normalizedValue: "alice@example.com" },
      { label: "password", kind: ComparableFieldKind.Secret, normalizedValueHash: "mock-linear-secret-new" }
    ]
  },
  {
    id: "vault-work:linear-2",
    onePasswordItemId: "linear-2",
    vaultId: "vault-work",
    vaultName: "Work",
    title: "Linear copy",
    category: ItemCategory.Login,
    createdAt: "2024-03-01T12:00:00.000Z",
    updatedAt: "2025-10-12T12:00:00.000Z",
    urls: ["https://linear.app/login/"],
    usernames: ["alice@example.com"],
    tags: ["imported"],
    fieldCount: 3,
    hasPassword: true,
    hasTotp: false,
    hasPasskey: false,
    hasAttachments: false,
    hasNotes: false,
    comparableFields: [
      { label: "username", kind: ComparableFieldKind.Username, normalizedValue: "alice@example.com" },
      { label: "password", kind: ComparableFieldKind.Secret, normalizedValueHash: "mock-linear-secret-old" }
    ]
  },
  {
    id: "vault-work:note-1",
    onePasswordItemId: "note-1",
    vaultId: "vault-work",
    vaultName: "Work",
    title: "VPN recovery note",
    category: ItemCategory.SecureNote,
    createdAt: "2026-02-01T12:00:00.000Z",
    updatedAt: "2026-02-01T12:00:00.000Z",
    urls: [],
    usernames: [],
    tags: ["vpn"],
    fieldCount: 3,
    hasPassword: false,
    hasTotp: false,
    hasPasskey: false,
    hasAttachments: false,
    hasNotes: true,
    comparableFields: [
      { label: "note", kind: ComparableFieldKind.Text, normalizedValue: "vpn recovery note" },
      { label: "support email", kind: ComparableFieldKind.Email, normalizedValue: "vpn@example.com" },
      { label: "support phone", kind: ComparableFieldKind.Phone, normalizedValue: "13800000000" }
    ],
    analysis: {
      notesText: "vpn recovery note"
    }
  }
];

export function createMockScanResult(): ScanResult {
  return {
    scanId: randomUUID(),
    scannedAt: new Date().toISOString(),
    storeVersion: 1,
    analyzedAt: new Date().toISOString(),
    vaults,
    items,
    groups: findSimilarityGroups(items)
  };
}
