export function normalizeSimilarityIdentity(value: string): string | undefined {
  const normalized = value.trim().toLowerCase();
  return normalized || undefined;
}

export function normalizeLooseText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

export function normalizeComparableUrl(raw: string): string | undefined {
  const value = raw.trim();
  if (!value) {
    return undefined;
  }

  const withProtocol = /^[a-z][a-z\d+\-.]*:\/\//i.test(value) ? value : `https://${value}`;

  try {
    const url = new URL(withProtocol);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const pathname = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
    return `${host}${pathname}`;
  } catch {
    return normalizeLooseText(value).replace(/^https?:\/\//, "").replace(/\/+$/, "");
  }
}

export function normalizeSimilarityUrl(raw: string): string | undefined {
  const value = raw.trim();
  if (!value) {
    return undefined;
  }

  try {
    const url = new URL(value);
    if (!url.hostname) {
      return `raw:${value.toLowerCase()}`;
    }
    const protocol = url.protocol.toLowerCase();
    const hostname = url.hostname.toLowerCase();
    const port = url.port ? `:${url.port}` : "";
    const pathname = url.pathname.length > 1 && url.pathname.endsWith("/")
      ? url.pathname.slice(0, -1)
      : url.pathname;
    return `parsed:${protocol}//${hostname}${port}${pathname}`;
  } catch {
    return `raw:${value.toLowerCase()}`;
  }
}

export function normalizeUrlHost(raw: string): string | undefined {
  const comparable = normalizeComparableUrl(raw);
  if (!comparable) {
    return undefined;
  }
  return comparable.split("/")[0];
}

export function stableGroupId(itemIds: string[]): string {
  return `sim_${itemIds.slice().sort().join("_").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80)}`;
}
