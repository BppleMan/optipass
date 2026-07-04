export function normalizeTitle(title: string): string {
  return title
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\s+\((copy|duplicate|old|new|backup|备份|副本)\)$/g, "")
    .replace(/\s+-\s+(copy|duplicate|old|new|backup|备份|副本)$/g, "")
    .trim();
}

export function normalizeUsername(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
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

export function normalizeDuplicateFullUrl(raw: string): string | undefined {
  const value = raw.trim();
  if (!value) {
    return undefined;
  }

  const withProtocol = /^[a-z][a-z\d+\-.]*:\/\//i.test(value) ? value : `https://${value}`;

  try {
    const url = new URL(withProtocol);
    const protocol = url.protocol.toLowerCase();
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const port = defaultPort(url) ? "" : url.port ? `:${url.port}` : "";
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    return `${protocol}//${host}${port}${pathname}${url.search}${url.hash}`;
  } catch {
    return normalizeLooseText(value).replace(/\/+$/, "");
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
  return `dup_${itemIds.slice().sort().join("_").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80)}`;
}

function defaultPort(url: URL): boolean {
  return (url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443");
}
