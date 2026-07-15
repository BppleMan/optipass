import {
  ItemSummary,
  RecommendedKeepReason,
  SimilarityGroup,
  SimilarityReason,
} from "./model.js";
import {
  normalizeSimilarityIdentity,
  normalizeSimilarityUrl,
  stableGroupId,
} from "./normalize.js";

interface MatchMaterial {
  accountIdentities: Set<string>;
  title?: string;
  urls: Set<string>;
}

interface SimilarityEdge {
  leftIndex: number;
  rightIndex: number;
  reasons: SimilarityReason[];
}

export function findSimilarityGroups(items: ItemSummary[]): SimilarityGroup[] {
  const materials = items.map(toMatchMaterial);
  const parents = items.map((_, index) => index);
  const edges: SimilarityEdge[] = [];

  for (let leftIndex = 0; leftIndex < items.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < items.length; rightIndex += 1) {
      const reasons = similarityReasons(items[leftIndex], materials[leftIndex], items[rightIndex], materials[rightIndex]);
      if (reasons.length === 0) {
        continue;
      }
      union(parents, leftIndex, rightIndex);
      edges.push({ leftIndex, rightIndex, reasons });
    }
  }

  const indexesByRoot = new Map<number, number[]>();
  for (let index = 0; index < items.length; index += 1) {
    const root = findRoot(parents, index);
    const indexes = indexesByRoot.get(root) ?? [];
    indexes.push(index);
    indexesByRoot.set(root, indexes);
  }

  return Array.from(indexesByRoot.values())
    .filter((indexes) => indexes.length >= 2)
    .map((indexes) => toSimilarityGroup(indexes, edges, items))
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

function toMatchMaterial(item: ItemSummary): MatchMaterial {
  const accountIdentities = uniqueSorted([
    ...item.usernames,
    ...item.comparableFields
      .filter((field) => field.kind === "username" || field.kind === "email")
      .map((field) => field.normalizedValue ?? ""),
  ]
    .map(normalizeSimilarityIdentity)
    .filter((value): value is string => Boolean(value)));

  return {
    accountIdentities: new Set(accountIdentities),
    title: normalizeSimilarityIdentity(item.title),
    urls: new Set(uniqueSorted(item.urls
      .map(normalizeSimilarityUrl)
      .filter((value): value is string => Boolean(value)))),
  };
}

function similarityReasons(
  leftItem: ItemSummary,
  left: MatchMaterial,
  rightItem: ItemSummary,
  right: MatchMaterial,
): SimilarityReason[] {
  if (!hasIntersection(left.urls, right.urls)) {
    return [];
  }

  const itemIds = [leftItem.id, rightItem.id].sort();
  const reasons: SimilarityReason[] = [];
  if (hasIntersection(left.accountIdentities, right.accountIdentities)) {
    reasons.push({
      rule: "account-identity-url",
      label: "账号身份相同且 URL 相似",
      itemIds,
    });
  }
  if (left.title && left.title === right.title) {
    reasons.push({
      rule: "title-url",
      label: "标题相同且 URL 相似",
      itemIds,
    });
  }
  return reasons;
}

function toSimilarityGroup(indexes: number[], edges: SimilarityEdge[], items: ItemSummary[]): SimilarityGroup {
  const indexSet = new Set(indexes);
  const groupItems = indexes.map((index) => items[index]);
  const recommendedKeepReasons = recommendKeepItemsWithReasons(groupItems);
  const itemIds = groupItems
    .slice()
    .sort((a, b) => scoreItem(b) - scoreItem(a) || a.id.localeCompare(b.id))
    .map((item) => item.id);

  return {
    id: stableGroupId(itemIds),
    itemIds,
    reasons: edges
      .filter((edge) => indexSet.has(edge.leftIndex) && indexSet.has(edge.rightIndex))
      .flatMap((edge) => edge.reasons),
    recommendedKeepIds: recommendedKeepReasons.map((reason) => reason.itemId),
    recommendedKeepReasons,
  };
}

function findRoot(parents: number[], index: number): number {
  if (parents[index] !== index) {
    parents[index] = findRoot(parents, parents[index]);
  }
  return parents[index];
}

function union(parents: number[], leftIndex: number, rightIndex: number): void {
  const leftRoot = findRoot(parents, leftIndex);
  const rightRoot = findRoot(parents, rightIndex);
  if (leftRoot !== rightRoot) {
    parents[rightRoot] = leftRoot;
  }
}

function hasIntersection(left: Set<string>, right: Set<string>): boolean {
  const [smaller, larger] = left.size <= right.size ? [left, right] : [right, left];
  return Array.from(smaller).some((value) => larger.has(value));
}

function compareGroups(a: SimilarityGroup, b: SimilarityGroup): number {
  return b.itemIds.length - a.itemIds.length || b.reasons.length - a.reasons.length || a.id.localeCompare(b.id);
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

function scoreItem(item: ItemSummary): number {
  const updatedAt = item.updatedAt ? Date.parse(item.updatedAt) : 0;
  const recencyScore = Number.isFinite(updatedAt) ? Math.min(20, updatedAt / 1000 / 60 / 60 / 24 / 365) : 0;

  return (
    item.fieldCount * 4
    + item.urls.length * 2
    + item.usernames.length * 2
    + item.tags.length
    + (item.hasNotes ? 6 : 0)
    + (item.hasTotp ? 18 : 0)
    + (item.hasPasskey ? 18 : 0)
    + (item.hasAttachments ? 16 : 0)
    + recencyScore
  );
}

function toRecommendedKeepReason(item: ItemSummary): RecommendedKeepReason {
  return {
    itemId: item.id,
    score: Math.round(scoreItem(item)),
    labels: recommendationLabels(item),
  };
}

function recommendationLabels(item: ItemSummary): string[] {
  const labels: string[] = [];
  if (item.hasTotp) {
    labels.push("包含一次性密码");
  }
  if (item.hasPasskey) {
    labels.push("包含 Passkey");
  }
  if (item.hasAttachments) {
    labels.push("包含附件");
  }
  if (item.hasNotes) {
    labels.push("包含备注");
  }
  if (item.updatedAt) {
    labels.push("更新时间较新");
  }
  return labels.length > 0 ? labels : ["字段信息更完整"];
}
