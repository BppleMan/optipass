import {
  DuplicateGroup,
  DuplicateReason,
  DuplicateRule,
  ItemSummary,
  RecommendedKeepReason
} from "./model.js";
import {
  normalizeComparableUrl,
  normalizeLooseText,
  normalizeTitle,
  normalizeUrlHost,
  normalizeUsername,
  stableGroupId
} from "./normalize.js";

interface IndexedReason {
  rule: DuplicateRule;
  key: string;
  label: string;
  itemId: string;
}

class DisjointSet {
  private readonly parent = new Map<string, string>();

  add(id: string): void {
    if (!this.parent.has(id)) {
      this.parent.set(id, id);
    }
  }

  find(id: string): string {
    const parent = this.parent.get(id);
    if (!parent || parent === id) {
      return id;
    }
    const root = this.find(parent);
    this.parent.set(id, root);
    return root;
  }

  union(a: string, b: string): void {
    this.add(a);
    this.add(b);
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) {
      this.parent.set(rootB, rootA);
    }
  }

  groups(): string[][] {
    const out = new Map<string, string[]>();
    for (const id of this.parent.keys()) {
      const root = this.find(id);
      const bucket = out.get(root) ?? [];
      bucket.push(id);
      out.set(root, bucket);
    }
    return Array.from(out.values()).filter((ids) => ids.length > 1);
  }
}

export interface DuplicateOptions {
  minTitleLength?: number;
}

export function findDuplicateGroups(items: ItemSummary[], options: DuplicateOptions = {}): DuplicateGroup[] {
  const minTitleLength = options.minTitleLength ?? 3;
  const itemById = new Map(items.map((item) => [item.id, item]));
  const reasons = new Map<string, IndexedReason[]>();

  const addReason = (reason: IndexedReason): void => {
    const bucket = reasons.get(reason.key) ?? [];
    bucket.push(reason);
    reasons.set(reason.key, bucket);
  };

  for (const item of items) {
    const title = normalizeTitle(item.title);
    if (title.length >= minTitleLength) {
      addReason({
        rule: "title",
        key: `title:${title}`,
        label: `标题相同：${item.title}`,
        itemId: item.id
      });
    }

    for (const rawUrl of item.urls) {
      const comparableUrl = normalizeComparableUrl(rawUrl);
      if (comparableUrl) {
        addReason({
          rule: "url",
          key: `url:${comparableUrl}`,
          label: `URL 相同：${comparableUrl}`,
          itemId: item.id
        });
      }

      const urlHost = normalizeUrlHost(rawUrl);
      for (const username of item.usernames) {
        const normalizedUsername = normalizeUsername(username);
        if (urlHost && normalizedUsername) {
          addReason({
            rule: "username-url",
            key: `username-url:${normalizedUsername}@${urlHost}`,
            label: `用户名 + 站点相同：${normalizedUsername}@${urlHost}`,
            itemId: item.id
          });
        }
      }
    }

    for (const field of item.comparableFields) {
      if (field.normalizedValueHash) {
        addReason({
          rule: "secret",
          key: `secret:${field.kind}:${field.normalizedValueHash}`,
          label: `敏感字段指纹相同：${field.label}`,
          itemId: item.id
        });
      } else if (field.normalizedValue) {
        const normalized = normalizeLooseText(field.normalizedValue);
        if (normalized.length >= 3) {
          addReason({
            rule: "field",
            key: `field:${field.kind}:${normalized}`,
            label: `字段值相同：${field.label}`,
            itemId: item.id
          });
        }
      }
    }
  }

  const ds = new DisjointSet();
  const duplicateReasons: DuplicateReason[] = [];

  for (const bucket of reasons.values()) {
    const uniqueIds = Array.from(new Set(bucket.map((reason) => reason.itemId)));
    if (uniqueIds.length < 2) {
      continue;
    }

    uniqueIds.forEach((id) => ds.add(id));
    for (let index = 1; index < uniqueIds.length; index += 1) {
      ds.union(uniqueIds[0], uniqueIds[index]);
    }

    const first = bucket[0];
    duplicateReasons.push({
      rule: first.rule,
      key: first.key,
      label: first.label,
      itemIds: uniqueIds
    });
  }

  return ds
    .groups()
    .map((itemIds) => {
      const groupReasons = duplicateReasons.filter((reason) =>
        reason.itemIds.some((id) => itemIds.includes(id))
      );
      const groupItems = itemIds.map((id) => itemById.get(id)).filter((item): item is ItemSummary => Boolean(item));
      const recommendedKeepReasons = recommendKeepItemsWithReasons(groupItems);
      const recommendedKeepIds = recommendedKeepReasons.map((reason) => reason.itemId);

      return {
        id: stableGroupId(itemIds),
        itemIds: itemIds.sort((a, b) => scoreItem(itemById.get(b)) - scoreItem(itemById.get(a))),
        reasons: groupReasons,
        recommendedKeepIds,
        recommendedKeepReasons,
        confidence: confidenceFor(groupReasons)
      };
    })
    .sort((a, b) => b.itemIds.length - a.itemIds.length || b.reasons.length - a.reasons.length);
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

function confidenceFor(reasons: DuplicateReason[]): DuplicateGroup["confidence"] {
  if (reasons.some((reason) => reason.rule === "secret" || reason.rule === "username-url")) {
    return "high";
  }
  if (reasons.some((reason) => reason.rule === "url")) {
    return "medium";
  }
  return "low";
}
