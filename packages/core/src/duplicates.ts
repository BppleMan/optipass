import {
  DuplicateCandidateClass,
  DuplicateGroup,
  DuplicateReason,
  ItemAnalysisMaterial,
  ItemSummary,
  RecommendedKeepReason
} from "./model.js";
import {
  normalizeDuplicateFullUrl,
  normalizeSimilarUrl,
  stableGroupId
} from "./normalize.js";

interface DuplicateDraft {
  candidateClass: DuplicateCandidateClass;
  itemIds: string[];
  reasons: DuplicateReason[];
  confidence: DuplicateGroup["confidence"];
}

interface LoginAnchorBucket {
  key: string;
  label: string;
  itemIds: string[];
}

export interface DuplicateOptions {}

export function findDuplicateGroups(items: ItemSummary[], options: DuplicateOptions = {}): DuplicateGroup[] {
  void options;
  const usedItemIds = new Set<string>();

  const exactGroups = buildExactDuplicateGroups(items);
  markUsed(usedItemIds, exactGroups);

  const similarGroups = selectExclusiveGroups(
    buildSimilarLoginGroups(items.filter((item) => item.category === "login" && !usedItemIds.has(item.id))),
    new Set(),
    items
  );
  markUsed(usedItemIds, similarGroups);

  const deleteSuggestionGroups = buildDeleteSuggestionGroups(
    items.filter((item) => !usedItemIds.has(item.id) && isDeleteSuggestionItem(item))
  );

  return [
    ...exactGroups,
    ...similarGroups,
    ...deleteSuggestionGroups
  ]
    .map((draft) => toDuplicateGroup(draft, items))
    .sort(compareGroups);
}

export function recommendKeepItems(items: ItemSummary[]): string[] {
  return recommendKeepItemsWithReasons(items).map((reason) => reason.itemId);
}

export function recommendKeepItemsWithReasons(items: ItemSummary[]): RecommendedKeepReason[] {
  if (items.length === 0) {
    return [];
  }

  const sorted = items.slice().sort((a, b) => scoreItem(b) - scoreItem(a));
  const topScore = scoreItem(sorted[0]);
  const topItems = sorted.filter((item) => topScore - scoreItem(item) <= 8);

  if (topItems.length > 1 && topItems.some((item) => item.hasTotp || item.hasAttachments || item.hasPasskey)) {
    return topItems.map((item) => toRecommendedKeepReason(item));
  }

  return [toRecommendedKeepReason(sorted[0])];
}

function buildExactDuplicateGroups(items: ItemSummary[]): DuplicateDraft[] {
  const buckets = new Map<string, string[]>();

  for (const item of items) {
    const fingerprint = exactItemFingerprint(item);
    const itemIds = buckets.get(fingerprint) ?? [];
    itemIds.push(item.id);
    buckets.set(fingerprint, itemIds);
  }

  return Array.from(buckets.values())
    .map(uniqueSorted)
    .filter((itemIds) => itemIds.length >= 2)
    .map((itemIds) => ({
      candidateClass: "exact-duplicate",
      itemIds,
      reasons: [exactItemReason(itemIds)],
      confidence: "high"
    }));
}

function buildSimilarLoginGroups(items: ItemSummary[]): DuplicateDraft[] {
  const buckets = new Map<string, LoginAnchorBucket>();

  const addToBucket = (bucket: Omit<LoginAnchorBucket, "itemIds">, itemId: string): void => {
    const existing = buckets.get(bucket.key) ?? { ...bucket, itemIds: [] };
    if (!existing.itemIds.includes(itemId)) {
      existing.itemIds.push(itemId);
    }
    buckets.set(bucket.key, existing);
  };

  for (const item of items) {
    const identities = accountIdentities(item);
    const urls = similarUrls(item);

    for (const identity of identities) {
      for (const url of urls) {
        addToBucket({
          key: `login-similar-url:${url}\u0000${identity}`,
          label: `相似 URL + 身份相同：${identity}@${url}`
        }, item.id);
      }
    }
  }

  const byItemSet = new Map<string, DuplicateDraft>();

  for (const bucket of buckets.values()) {
    const itemIds = uniqueSorted(bucket.itemIds);
    if (itemIds.length < 2) {
      continue;
    }

    const reason: DuplicateReason = {
      rule: "username-url",
      key: bucket.key,
      label: bucket.label,
      itemIds
    };
    const itemSetKey = itemIds.join("\u0000");
    const existing = byItemSet.get(itemSetKey);

    if (existing) {
      existing.reasons.push(reason);
      continue;
    }

    byItemSet.set(itemSetKey, {
      candidateClass: "similar-login",
      itemIds,
      reasons: [reason],
      confidence: "high"
    });
  }

  return Array.from(byItemSet.values());
}

function buildDeleteSuggestionGroups(items: ItemSummary[]): DuplicateDraft[] {
  return items.map((item) => {
    const reasons: DuplicateReason[] = [];
    if (!hasAccountIdentity(item)) {
      reasons.push({
        rule: "missing-account-identity",
        key: `delete-suggestion:missing-account-identity:${item.id}`,
        label: "登录项缺少账号身份",
        itemIds: [item.id]
      });
    }
    if (!hasCredentialMaterial(item)) {
      reasons.push({
        rule: "missing-credential-material",
        key: `delete-suggestion:missing-credential-material:${item.id}`,
        label: "登录项缺少密码、一次性密码或登录方式",
        itemIds: [item.id]
      });
    }

    return {
      candidateClass: "delete-suggestion",
      itemIds: [item.id],
      reasons,
      confidence: "low"
    };
  });
}

function toDuplicateGroup(draft: DuplicateDraft, allItems: ItemSummary[]): DuplicateGroup {
  const itemById = new Map(allItems.map((item) => [item.id, item]));
  const groupItems = draft.itemIds.map((id) => itemById.get(id)).filter((item): item is ItemSummary => Boolean(item));
  const recommendedKeepReasons = draft.candidateClass === "delete-suggestion"
    ? []
    : recommendKeepItemsWithReasons(groupItems);

  return {
    id: stableGroupId([draft.candidateClass, ...draft.itemIds]),
    candidateClass: draft.candidateClass,
    itemIds: draft.itemIds.sort((a, b) => scoreItem(itemById.get(b)) - scoreItem(itemById.get(a))),
    reasons: draft.reasons,
    recommendedKeepIds: recommendedKeepReasons.map((reason) => reason.itemId),
    recommendedKeepReasons,
    confidence: draft.confidence
  };
}

function exactItemFingerprint(item: ItemSummary): string {
  const analysis = analysisMaterial(item);
  return JSON.stringify({
    title: item.title,
    category: item.category,
    notesValueHash: analysis.notesValueHash,
    exactUrlKeys: sortedValues(analysis.exactUrlKeys),
    fieldCount: item.fieldCount,
    fieldSignatures: sortedValues(analysis.fieldSignatures),
    hasPassword: item.hasPassword,
    hasTotp: item.hasTotp,
    hasPasskey: item.hasPasskey,
    hasAttachments: item.hasAttachments
  });
}

function analysisMaterial(item: ItemSummary): ItemAnalysisMaterial {
  return {
    notesValueHash: item.analysis?.notesValueHash ?? "",
    exactUrlKeys: item.analysis?.exactUrlKeys ?? duplicateFullUrls(item),
    similarUrlKeys: item.analysis?.similarUrlKeys ?? similarUrlsFromRaw(item.urls),
    identityValues: item.analysis?.identityValues ?? accountIdentitiesFromFields(item),
    fieldSignatures: item.analysis?.fieldSignatures ?? comparableFieldSignatures(item)
  };
}

function comparableFieldSignatures(item: ItemSummary): string[] {
  return item.comparableFields.map((field) => JSON.stringify({
    label: field.label,
    kind: field.kind,
    value: field.normalizedValue ?? "",
    hash: field.normalizedValueHash ?? ""
  })).sort();
}

function exactItemReason(itemIds: string[]): DuplicateReason {
  return {
    rule: "item-fingerprint",
    key: `item-fingerprint:${itemIds.join("\u0000")}`,
    label: "除保险库、时间和标签外，项目内容均相同",
    itemIds
  };
}

function isDeleteSuggestionItem(item: ItemSummary): boolean {
  return item.category === "login" && (!hasAccountIdentity(item) || !hasCredentialMaterial(item));
}

function hasAccountIdentity(item: ItemSummary): boolean {
  return accountIdentities(item).length > 0;
}

function hasCredentialMaterial(item: ItemSummary): boolean {
  return item.hasPassword || credentialHashes(item).length > 0 || item.hasTotp || item.hasPasskey;
}

function accountIdentities(item: ItemSummary): string[] {
  return analysisMaterial(item).identityValues;
}

function accountIdentitiesFromFields(item: ItemSummary): string[] {
  return uniqueSorted([
    ...item.usernames,
    ...item.comparableFields
      .filter((field) => field.kind === "username" || field.kind === "email" || field.kind === "phone")
      .map((field) => field.normalizedValue ?? "")
  ].filter((value) => value.length > 0));
}

function duplicateFullUrls(item: ItemSummary): string[] {
  return uniqueSorted(item.urls.map((url) => normalizeDuplicateFullUrl(url)).filter((url): url is string => Boolean(url)));
}

function similarUrls(item: ItemSummary): string[] {
  return analysisMaterial(item).similarUrlKeys;
}

function similarUrlsFromRaw(urls: string[]): string[] {
  return uniqueSorted(urls.map((url) => normalizeSimilarUrl(url)).filter((url): url is string => Boolean(url)));
}

function credentialHashes(item: ItemSummary): string[] {
  return uniqueSorted(item.comparableFields
    .filter((field) => field.kind === "secret" && field.normalizedValueHash)
    .map((field) => field.normalizedValueHash!));
}

function selectExclusiveGroups(
  groups: DuplicateDraft[],
  initialUsedItemIds: Set<string>,
  allItems: ItemSummary[]
): DuplicateDraft[] {
  const itemById = new Map(allItems.map((item) => [item.id, item]));
  const selected: DuplicateDraft[] = [];
  const usedItemIds = new Set(initialUsedItemIds);

  for (const group of groups.slice().sort((a, b) => compareDraftsForSelection(a, b, itemById))) {
    if (group.itemIds.some((itemId) => usedItemIds.has(itemId))) {
      continue;
    }
    selected.push(group);
    for (const itemId of group.itemIds) {
      usedItemIds.add(itemId);
    }
  }

  return selected;
}

function compareDraftsForSelection(
  a: DuplicateDraft,
  b: DuplicateDraft,
  itemById: Map<string, ItemSummary>
): number {
  return (
    b.itemIds.length - a.itemIds.length ||
    b.reasons.length - a.reasons.length ||
    draftRecommendedScore(b, itemById) - draftRecommendedScore(a, itemById) ||
    stableGroupId([a.candidateClass, ...a.itemIds]).localeCompare(stableGroupId([b.candidateClass, ...b.itemIds]))
  );
}

function draftRecommendedScore(group: DuplicateDraft, itemById: Map<string, ItemSummary>): number {
  return group.itemIds.reduce((sum, itemId) => sum + scoreItem(itemById.get(itemId)), 0);
}

function markUsed(usedItemIds: Set<string>, groups: DuplicateDraft[]): void {
  for (const group of groups) {
    for (const itemId of group.itemIds) {
      usedItemIds.add(itemId);
    }
  }
}

function compareGroups(a: DuplicateGroup, b: DuplicateGroup): number {
  return (
    classRank(b.candidateClass) - classRank(a.candidateClass) ||
    confidenceRank(b.confidence) - confidenceRank(a.confidence) ||
    b.itemIds.length - a.itemIds.length ||
    b.reasons.length - a.reasons.length ||
    a.id.localeCompare(b.id)
  );
}

function classRank(candidateClass: DuplicateCandidateClass): number {
  switch (candidateClass) {
    case "exact-duplicate":
      return 4;
    case "similar-login":
      return 3;
    case "misc-title":
      return 2;
    case "delete-suggestion":
      return 1;
  }
}

function confidenceRank(confidence: DuplicateGroup["confidence"]): number {
  return confidence === "high" ? 3 : confidence === "medium" ? 2 : 1;
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

function sortedValues(values: string[]): string[] {
  return values.slice().sort();
}

function scoreItem(item: ItemSummary | undefined): number {
  if (!item) {
    return 0;
  }

  const updatedAt = item.updatedAt ? Date.parse(item.updatedAt) : 0;
  const recencyScore = Number.isFinite(updatedAt) ? Math.min(20, updatedAt / 1000 / 60 / 60 / 24 / 365) : 0;

  return (
    item.fieldCount * 4 +
    item.urls.length * 2 +
    item.usernames.length * 2 +
    item.tags.length +
    (item.hasNotes ? 6 : 0) +
    (item.hasTotp ? 18 : 0) +
    (item.hasPasskey ? 18 : 0) +
    (item.hasAttachments ? 16 : 0) +
    recencyScore
  );
}

function toRecommendedKeepReason(item: ItemSummary): RecommendedKeepReason {
  return {
    itemId: item.id,
    score: Math.round(scoreItem(item)),
    labels: recommendationLabels(item)
  };
}

function recommendationLabels(item: ItemSummary): string[] {
  const labels: string[] = [];

  if (item.hasTotp) {
    labels.push("含 TOTP");
  }
  if (item.hasPasskey) {
    labels.push("含 Passkey");
  }
  if (item.hasAttachments) {
    labels.push("含附件");
  }
  if (item.hasNotes) {
    labels.push("含备注");
  }
  if (item.fieldCount > 0) {
    labels.push(`字段 ${item.fieldCount}`);
  }
  if (item.urls.length > 0) {
    labels.push(`URL ${item.urls.length}`);
  }
  if (item.tags.length > 0) {
    labels.push(`标签 ${item.tags.length}`);
  }
  if (item.updatedAt) {
    labels.push("最近更新");
  }

  return labels.length > 0 ? labels : ["信息较完整"];
}
