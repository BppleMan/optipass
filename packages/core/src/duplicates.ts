import {
  DuplicateCandidateClass,
  DuplicateGroup,
  DuplicateReason,
  ItemSummary,
  RecommendedKeepReason
} from "./model.js";
import {
  normalizeDuplicateFullUrl,
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
  const deleteSuggestionItemIds = new Set(
    items.filter((item) => isDeleteSuggestionItem(item)).map((item) => item.id)
  );

  const drafts = [
    ...buildLoginIdentityGroups(items.filter((item) => item.category === "login" && !deleteSuggestionItemIds.has(item.id))),
    ...buildDeleteSuggestionGroups(items.filter((item) => deleteSuggestionItemIds.has(item.id)))
  ];

  return drafts
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

function buildLoginIdentityGroups(items: ItemSummary[]): DuplicateDraft[] {
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
    const urls = duplicateFullUrls(item);

    for (const identity of identities) {
      for (const url of urls) {
        addToBucket({
          key: `login-full-url:${url}\u0000${identity}`,
          label: `完整 URL + 用户名相同：${identity}@${url}`
        }, item.id);
      }
    }
  }

  const itemById = new Map(items.map((item) => [item.id, item]));
  const byItemSet = new Map<string, DuplicateDraft>();

  for (const bucket of buckets.values()) {
    const itemIds = uniqueSorted(bucket.itemIds);
    if (itemIds.length < 2) {
      continue;
    }

    const groupItems = itemIds.map((id) => itemById.get(id)).filter((item): item is ItemSummary => Boolean(item));
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
      if (existing.candidateClass !== "exact-duplicate" && isExactLoginDuplicateGroup(groupItems)) {
        existing.candidateClass = "exact-duplicate";
        existing.confidence = "high";
        existing.reasons.push(exactCredentialReason(itemIds));
      }
      continue;
    }

    const exact = isExactLoginDuplicateGroup(groupItems);
    byItemSet.set(itemSetKey, {
      candidateClass: exact ? "exact-duplicate" : "similar-login",
      itemIds,
      reasons: exact ? [reason, exactCredentialReason(itemIds)] : [reason],
      confidence: "high"
    });
  }

  return removeStrictSubsetGroups(Array.from(byItemSet.values()));
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
  return uniqueSorted([
    ...item.usernames,
    ...item.comparableFields
      .filter((field) => field.kind === "username" || field.kind === "email" || field.kind === "phone")
      .map((field) => field.normalizedValue ?? "")
  ].map((value) => value.trim()).filter(Boolean));
}

function duplicateFullUrls(item: ItemSummary): string[] {
  return uniqueSorted(item.urls.map((url) => normalizeDuplicateFullUrl(url)).filter((url): url is string => Boolean(url)));
}

function isExactLoginDuplicateGroup(items: ItemSummary[]): boolean {
  if (items.length < 2 || items.some((item) => item.category !== "login")) {
    return false;
  }

  const firstIdentitySet = accountIdentities(items[0]).join("\u0000");
  const firstUrlSet = duplicateFullUrls(items[0]).join("\u0000");
  const firstCredentialSet = credentialFingerprint(items[0]);
  if (!firstIdentitySet || !firstUrlSet || !firstCredentialSet) {
    return false;
  }

  return items.every((item) =>
    accountIdentities(item).join("\u0000") === firstIdentitySet &&
    duplicateFullUrls(item).join("\u0000") === firstUrlSet &&
    credentialFingerprint(item) === firstCredentialSet
  );
}

function credentialHashes(item: ItemSummary): string[] {
  return uniqueSorted(item.comparableFields
    .filter((field) => field.kind === "secret" && field.normalizedValueHash)
    .map((field) => field.normalizedValueHash!));
}

function credentialFingerprint(item: ItemSummary): string | undefined {
  const hashes = credentialHashes(item);
  if (hashes.length === 0) {
    return undefined;
  }

  return [
    `secret:${hashes.join("\u0001")}`,
    `password:${item.hasPassword ? "1" : "0"}`,
    `totp:${item.hasTotp ? "1" : "0"}`,
    `passkey:${item.hasPasskey ? "1" : "0"}`
  ].join("\u0000");
}

function exactCredentialReason(itemIds: string[]): DuplicateReason {
  return {
    rule: "credential-material",
    key: `credential-material:${itemIds.join("\u0000")}`,
    label: "用户名、完整 URL 与凭据材料均相同",
    itemIds
  };
}

function removeStrictSubsetGroups(groups: DuplicateDraft[]): DuplicateDraft[] {
  const sorted = groups.slice().sort((a, b) =>
    b.itemIds.length - a.itemIds.length ||
    confidenceRank(b.confidence) - confidenceRank(a.confidence) ||
    classRank(b.candidateClass) - classRank(a.candidateClass)
  );
  const selected: DuplicateDraft[] = [];

  for (const group of sorted) {
    if (selected.some((candidate) => isStrictSubset(group.itemIds, candidate.itemIds))) {
      continue;
    }
    selected.push(group);
  }

  return selected;
}

function isStrictSubset(candidate: string[], container: string[]): boolean {
  return candidate.length < container.length && candidate.every((id) => container.includes(id));
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
    case "similar-login":
      return 4;
    case "exact-duplicate":
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
