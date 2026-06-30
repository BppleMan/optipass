#!/usr/bin/env node

import { writeFile } from "node:fs/promises";

const args = parseArgs(process.argv.slice(2));
const bridge = trimTrailingSlash(args.bridge ?? "http://127.0.0.1:18080");
const maxDepth = parsePositiveInteger(args.maxDepth ?? "8", "max-depth");
const pauseMs = parsePositiveInteger(args.pauseMs ?? "20", "pause-ms");

if (!args.out || (!args.nodeId && !args.name)) {
  console.error(
    "Usage: node scripts/figma-crawl-inspect.mjs --node-id 1:2|--name NAME --out figma-inspect.json [--bridge http://127.0.0.1:18080] [--max-depth 8]"
  );
  process.exit(2);
}

const rootTarget = args.nodeId ? { nodeId: args.nodeId } : { name: args.name };
const visited = new Set();
const root = await crawlNode(rootTarget, 0);
const output = {
  requestId: `crawl-inspect-${Date.now()}`,
  connected: true,
  ok: true,
  result: { node: root },
  crawl: {
    bridge,
    rootTarget,
    maxDepth,
    nodeCount: visited.size
  }
};

await writeFile(args.out, `${JSON.stringify(output, null, 2)}\n`);
console.log(`Wrote ${visited.size} nodes to ${args.out}`);

async function crawlNode(target, depth) {
  const node = await inspectOne(target);
  if (typeof node.id !== "string") {
    throw new Error(`Inspect result is missing node id for ${JSON.stringify(target)}`);
  }
  if (visited.has(node.id)) {
    return { ...node, children: [] };
  }
  visited.add(node.id);

  const childRefs = Array.isArray(node.children) ? node.children : [];
  if (depth >= maxDepth || childRefs.length === 0) {
    return node;
  }

  const children = [];
  for (const childRef of childRefs) {
    if (!childRef || typeof childRef.id !== "string") {
      children.push(childRef);
      continue;
    }
    await delay(pauseMs);
    children.push(await crawlNode({ nodeId: childRef.id }, depth + 1));
  }

  return { ...node, children };
}

async function inspectOne(target) {
  const requestId = `crawl-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const response = await fetch(`${bridge}/api/figma/commands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requestId,
      command: {
        type: "node.inspect",
        target,
        depth: 1,
        childMode: "summary"
      }
    })
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error ?? `Inspect failed with HTTP ${response.status}`);
  }
  const node = payload.result?.node;
  if (!node) {
    throw new Error(`Inspect response ${requestId} did not include a node`);
  }
  return node;
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) {
      continue;
    }
    const key = toCamelCase(value.slice(2));
    result[key] = values[index + 1];
    index += 1;
  }
  return result;
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, character) => character.toUpperCase());
}

function parsePositiveInteger(value, label) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return parsed;
}

function trimTrailingSlash(value) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
