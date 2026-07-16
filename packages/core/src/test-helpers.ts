import { ItemAnalysisMaterial, ItemSummary } from "./model.js";

export function item(overrides: Partial<ItemSummary>): ItemSummary {
  if (!overrides.id || !overrides.title) {
    throw new Error("测试 Item 必须提供 id 和 title。");
  }
  return {
    onePasswordItemId: overrides.id,
    vaultId: "vault-a",
    vaultName: "Private",
    category: "login",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    urls: [],
    usernames: [],
    tags: [],
    fieldCount: 2,
    hasPassword: false,
    hasTotp: false,
    hasPasskey: false,
    hasAttachments: false,
    hasNotes: false,
    comparableFields: [],
    ...overrides
  };
}

export function analysis(overrides: Partial<ItemAnalysisMaterial> = {}): ItemAnalysisMaterial {
  return {
    ...overrides
  };
}
