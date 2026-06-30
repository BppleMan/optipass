import { randomUUID } from "node:crypto";
import { findDuplicateGroups, ItemSummary, ScanResult, VaultSummary } from "@optimize-password/core";

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
    category: "login",
    createdAt: "2025-12-01T12:00:00.000Z",
    updatedAt: "2026-06-01T12:00:00.000Z",
    urls: ["https://github.com/login"],
    usernames: ["alice@example.com"],
    tags: ["dev"],
    fieldCount: 5,
    hasPassword: true,
    hasTotp: true,
    hasPasskey: false,
    hasAttachments: false,
    hasNotes: true,
    comparableFields: [
      { label: "username", kind: "username", normalizedValue: "alice@example.com" },
      { label: "password", kind: "secret", normalizedValueHash: "mock-github-work-secret" }
    ]
  },
  {
    id: "vault-work:github-2",
    onePasswordItemId: "github-2",
    vaultId: "vault-work",
    vaultName: "Work",
    title: "github copy",
    category: "login",
    createdAt: "2024-05-01T12:00:00.000Z",
    updatedAt: "2026-05-15T12:00:00.000Z",
    urls: ["github.com/login"],
    usernames: ["alice@example.com"],
    tags: ["imported"],
    fieldCount: 3,
    hasPassword: true,
    hasTotp: false,
    hasPasskey: false,
    hasAttachments: false,
    hasNotes: false,
    comparableFields: [
      { label: "username", kind: "username", normalizedValue: "alice@example.com" },
      { label: "password", kind: "secret", normalizedValueHash: "mock-github-secret" }
    ]
  },
  {
    id: "vault-personal:aws-1",
    onePasswordItemId: "aws-1",
    vaultId: "vault-personal",
    vaultName: "Personal",
    title: "AWS root",
    category: "api-credential",
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
      { label: "access key", kind: "text", normalizedValue: "AKIA-MOCK-KEY" },
      { label: "secret key", kind: "secret", normalizedValueHash: "mock-aws-secret" }
    ]
  },
  {
    id: "vault-archive:aws-2",
    onePasswordItemId: "aws-2",
    vaultId: "vault-archive",
    vaultName: "Archive",
    title: "AWS root",
    category: "api-credential",
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
      { label: "access key", kind: "text", normalizedValue: "AKIA-MOCK-KEY" },
      { label: "secret key", kind: "secret", normalizedValueHash: "mock-aws-secret" }
    ]
  },
  {
    id: "vault-work:note-1",
    onePasswordItemId: "note-1",
    vaultId: "vault-work",
    vaultName: "Work",
    title: "VPN recovery note",
    category: "secure-note",
    createdAt: "2026-02-01T12:00:00.000Z",
    updatedAt: "2026-02-01T12:00:00.000Z",
    urls: [],
    usernames: [],
    tags: ["vpn"],
    fieldCount: 1,
    hasPassword: false,
    hasTotp: false,
    hasPasskey: false,
    hasAttachments: false,
    hasNotes: true,
    comparableFields: [{ label: "note", kind: "text", normalizedValue: "vpn recovery note" }]
  }
];

export function createMockScanResult(): ScanResult {
  return {
    scanId: randomUUID(),
    scannedAt: new Date().toISOString(),
    vaults,
    items,
    groups: findDuplicateGroups(items)
  };
}
