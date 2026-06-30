#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";

const args = parseArgs(process.argv.slice(2));

if (!args.dom || !args.figma) {
  console.error("Usage: node scripts/figma-fidelity.mjs --dom dom-style.json --figma figma-inspect.json [--out report.json]");
  process.exit(2);
}

const domRoot = JSON.parse(await readFile(args.dom, "utf8"));
const figmaRoot = unwrapFigmaNode(JSON.parse(await readFile(args.figma, "utf8")));

const report = compareTrees(domRoot, figmaRoot);

if (args.out) {
  await writeFile(args.out, `${JSON.stringify(report, null, 2)}\n`);
}

console.log(formatSummary(report));

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) {
      continue;
    }
    result[value.slice(2)] = values[index + 1];
    index += 1;
  }
  return result;
}

function unwrapFigmaNode(input) {
  return input?.result?.node ?? input?.node ?? input;
}

function compareTrees(domRootNode, figmaRootNode) {
  const domNodes = flattenDom(domRootNode);
  const figmaNodes = flattenFigma(figmaRootNode);
  const paths = Array.from(new Set([...domNodes.keys(), ...figmaNodes.keys()])).sort(comparePath);
  const findings = [];

  for (const path of paths) {
    const dom = domNodes.get(path);
    const figma = figmaNodes.get(path);
    if (!dom || !figma) {
      findings.push({
        severity: "structure",
        path,
        message: dom ? "Figma node missing for DOM path" : "DOM node missing for Figma path"
      });
      continue;
    }

    compareGeometry(path, dom, figma, findings);
    compareText(path, dom, figma, findings);
    compareColor(path, dom, figma, findings);
    compareGradient(path, dom, figma, findings);
    compareShadow(path, dom, figma, findings);
    compareTypography(path, dom, figma, findings);
  }

  return {
    domNodeCount: domNodes.size,
    figmaNodeCount: figmaNodes.size,
    findingCount: findings.length,
    findings
  };
}

function flattenDom(root) {
  const result = new Map();
  visit(root, "0");
  return result;

  function visit(node, path) {
    result.set(path, node);
    const children = Array.isArray(node.children) ? node.children : [];
    for (const [index, child] of children.entries()) {
      visit(child, `${path}.${index}`);
    }
  }
}

function flattenFigma(root) {
  const result = new Map();
  visit(root, "0");
  return result;

  function visit(node, path) {
    result.set(path, node);
    const children = Array.isArray(node.children) ? node.children : [];
    for (const [index, child] of children.entries()) {
      visit(child, `${path}.${index}`);
    }
  }
}

function compareGeometry(path, dom, figma, findings) {
  const domRect = dom.rect ?? {};
  const tolerance = path === "0" ? 1 : 2;
  compareNumber(path, "width", domRect.width, figma.width, tolerance, findings);
  compareNumber(path, "height", domRect.height, figma.height, tolerance, findings);
}

function compareText(path, dom, figma, findings) {
  const domText = normalizeText(dom.text);
  const figmaText = normalizeText(figma.text?.characters);
  if (domText && figmaText && domText !== figmaText) {
    findings.push({
      severity: "content",
      path,
      property: "text",
      dom: domText,
      figma: figmaText,
      message: "Text content differs"
    });
  }
}

function compareColor(path, dom, figma, findings) {
  const domBackground = normalizeCssColor(css(dom, "background-color"));
  const figmaFill = firstSolidFill(figma.fills);
  if (domBackground && figmaFill && domBackground !== figmaFill) {
    findings.push({
      severity: "style",
      path,
      property: "background/fill",
      dom: domBackground,
      figma: figmaFill,
      message: "Background color differs from Figma fill"
    });
  }

  const domColor = normalizeCssColor(css(dom, "color"));
  const figmaTextFill = figma.text ? firstSolidFill(figma.fills) : undefined;
  if (domColor && figmaTextFill && domColor !== figmaTextFill) {
    findings.push({
      severity: "style",
      path,
      property: "text color",
      dom: domColor,
      figma: figmaTextFill,
      message: "Text color differs"
    });
  }
}

function compareTypography(path, dom, figma, findings) {
  if (!figma.text) {
    return;
  }
  const domFontSize = parseCssPixels(css(dom, "font-size"));
  const figmaFontSize = typeof figma.text.fontSize === "number" ? figma.text.fontSize : undefined;
  compareNumber(path, "fontSize", domFontSize, figmaFontSize, 1, findings);

  const domLineHeight = parseCssPixels(css(dom, "line-height"));
  const figmaLineHeight = figmaLineHeightPixels(figma.text.lineHeight, figmaFontSize);
  compareNumber(path, "lineHeight", domLineHeight, figmaLineHeight, 1.5, findings);
}

function compareGradient(path, dom, figma, findings) {
  const domGradient = firstCssLinearGradient(css(dom, "background-image"));
  const figmaGradient = firstFigmaLinearGradient(figma.fills);
  if (!domGradient && !figmaGradient) {
    return;
  }
  if (domGradient && !figmaGradient) {
    findings.push({
      severity: "style",
      path,
      property: "background gradient",
      dom: domGradient,
      figma: null,
      message: "DOM linear gradient is missing in Figma fills"
    });
    return;
  }
  if (!domGradient && figmaGradient) {
    findings.push({
      severity: "style",
      path,
      property: "background gradient",
      dom: null,
      figma: figmaGradient,
      message: "Figma gradient is not present in DOM"
    });
    return;
  }

  const domStops = domGradient.stops;
  const figmaStops = figmaGradient.stops;
  if (domStops.length !== figmaStops.length || domStops.some((stop, index) => stop.color !== figmaStops[index]?.color)) {
    findings.push({
      severity: "style",
      path,
      property: "background gradient",
      dom: domGradient,
      figma: figmaGradient,
      message: "Gradient stops differ"
    });
  }
}

function firstCssLinearGradient(value) {
  if (!value || value === "none") {
    return undefined;
  }
  const match = /^linear-gradient\((.+)\)$/i.exec(value.trim());
  if (!match) {
    return undefined;
  }
  const parts = splitCssList(match[1]);
  if (parts.length < 2) {
    return undefined;
  }
  const firstPart = parts[0].trim().toLowerCase();
  const directionConsumesFirstPart = firstPart.startsWith("to ") || firstPart.endsWith("deg");
  const stopParts = directionConsumesFirstPart ? parts.slice(1) : parts;
  const stops = stopParts
    .map((part) => {
      const colorMatch = /(rgba?\([^)]+\)|#[0-9a-f]{3,8}\b|[a-z]+)\s*(.*)$/i.exec(part.trim());
      const color = normalizeCssColor(colorMatch?.[1] ?? "");
      return color ? { color } : undefined;
    })
    .filter(Boolean);
  return stops.length >= 2 ? { stops } : undefined;
}

function firstFigmaLinearGradient(fills) {
  if (!Array.isArray(fills)) {
    return undefined;
  }
  const fill = fills.find((entry) => entry?.type === "GRADIENT_LINEAR" || entry?.type === "linear-gradient");
  if (!fill) {
    return undefined;
  }
  const rawStops = fill.gradientStops ?? fill.stops ?? [];
  const stops = rawStops
    .map((stop) => ({
      color: normalizeCssColor(stop.color) ?? normalizeRgbObject(stop.color)
    }))
    .filter((stop) => stop.color);
  return stops.length >= 2 ? { stops } : undefined;
}

function compareShadow(path, dom, figma, findings) {
  const domShadow = firstCssShadow(css(dom, "box-shadow"));
  const figmaShadow = firstFigmaShadow(figma.effects);
  if (!domShadow && !figmaShadow) {
    return;
  }
  if (domShadow && !figmaShadow) {
    findings.push({
      severity: "style",
      path,
      property: "shadow",
      dom: domShadow,
      figma: null,
      message: "DOM shadow is missing in Figma effects"
    });
    return;
  }
  if (!domShadow && figmaShadow) {
    findings.push({
      severity: "style",
      path,
      property: "shadow",
      dom: null,
      figma: figmaShadow,
      message: "Figma shadow is not present in DOM"
    });
    return;
  }

  const checks = [
    ["offsetX", 1],
    ["offsetY", 1],
    ["radius", 1.5],
    ["spread", 1]
  ];
  for (const [property, tolerance] of checks) {
    compareNumber(path, `shadow.${property}`, domShadow[property] ?? 0, figmaShadow[property] ?? 0, tolerance, findings);
  }
  if (domShadow.type !== figmaShadow.type || domShadow.color !== figmaShadow.color) {
    findings.push({
      severity: "style",
      path,
      property: "shadow",
      dom: domShadow,
      figma: figmaShadow,
      message: "Shadow style differs"
    });
  }
}

function firstCssShadow(value) {
  if (!value || value === "none") {
    return undefined;
  }
  const shadow = splitCssList(value)[0];
  if (!shadow) {
    return undefined;
  }
  const inset = /\binset\b/i.test(shadow);
  const withoutInset = shadow.replace(/\binset\b/gi, "").trim();
  const colorMatch = /(rgba?\([^)]+\)|#[0-9a-f]{3,8}\b)/i.exec(withoutInset);
  const color = normalizeCssColor(colorMatch?.[1] ?? "");
  if (!color) {
    return undefined;
  }
  const lengthPart = colorMatch
    ? `${withoutInset.slice(0, colorMatch.index)} ${withoutInset.slice(colorMatch.index + colorMatch[0].length)}`
    : withoutInset;
  const lengths = lengthPart
    .trim()
    .split(/\s+/)
    .map(parseCssPixels)
    .filter((part) => typeof part === "number");
  if (lengths.length < 2) {
    return undefined;
  }
  return {
    type: inset ? "inner-shadow" : "drop-shadow",
    color,
    offsetX: lengths[0],
    offsetY: lengths[1],
    radius: lengths[2] ?? 0,
    spread: lengths[3] ?? 0
  };
}

function firstFigmaShadow(effects) {
  if (!Array.isArray(effects)) {
    return undefined;
  }
  const effect = effects.find((entry) => entry?.type === "DROP_SHADOW" || entry?.type === "INNER_SHADOW");
  if (!effect) {
    return undefined;
  }
  return {
    type: effect.type === "INNER_SHADOW" ? "inner-shadow" : "drop-shadow",
    color: effect.colorHex ?? normalizeRgbObject(effect.color),
    offsetX: effect.offset?.x ?? 0,
    offsetY: effect.offset?.y ?? 0,
    radius: effect.radius ?? 0,
    spread: effect.spread ?? 0
  };
}

function compareNumber(path, property, domValue, figmaValue, tolerance, findings) {
  if (typeof domValue !== "number" || typeof figmaValue !== "number") {
    return;
  }
  const delta = Math.abs(domValue - figmaValue);
  if (delta > tolerance) {
    findings.push({
      severity: property === "width" || property === "height" ? "geometry" : "style",
      path,
      property,
      dom: round(domValue),
      figma: round(figmaValue),
      delta: round(delta),
      message: `${property} differs by ${round(delta)}px`
    });
  }
}

function firstSolidFill(fills) {
  if (!Array.isArray(fills)) {
    return undefined;
  }
  const fill = fills.find((entry) => entry?.type === "SOLID" && entry.visible !== false);
  return fill?.colorHex ?? normalizeRgbObject(fill?.color);
}

function normalizeCssColor(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  if (!value || value === "rgba(0, 0, 0, 0)" || value === "transparent") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "white") {
    return "#ffffff";
  }
  if (normalized === "black") {
    return "#000000";
  }
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(normalized);
  if (hex) {
    return hex[1].length === 3
      ? `#${hex[1].split("").map((part) => part + part).join("")}`
      : normalized;
  }
  const rgba = /^rgba?\(([^)]+)\)$/i.exec(normalized);
  if (!rgba) {
    return normalized;
  }
  const parts = rgba[1].split(",").map((part) => Number.parseFloat(part.trim()));
  if (parts.length >= 4 && parts[3] === 0) {
    return undefined;
  }
  return rgbToHex(parts[0], parts[1], parts[2]);
}

function css(node, property) {
  const style = node?.style ?? {};
  return style[property] ?? style[toCamelCase(property)] ?? "";
}

function toCamelCase(property) {
  return property.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function normalizeRgbObject(value) {
  if (!value || typeof value.r !== "number" || typeof value.g !== "number" || typeof value.b !== "number") {
    return undefined;
  }
  return rgbToHex(value.r * 255, value.g * 255, value.b * 255);
}

function rgbToHex(red, green, blue) {
  return `#${toHex(red)}${toHex(green)}${toHex(blue)}`;
}

function toHex(value) {
  return Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0");
}

function parseCssPixels(value) {
  if (!value || value === "normal") {
    return undefined;
  }
  const match = /^(-?\d+(?:\.\d+)?)px$/.exec(value);
  return match ? Number.parseFloat(match[1]) : undefined;
}

function splitCssList(value) {
  const result = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth = Math.max(0, depth - 1);
    } else if (char === "," && depth === 0) {
      result.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  result.push(value.slice(start).trim());
  return result.filter(Boolean);
}

function figmaLineHeightPixels(lineHeight, fontSize) {
  if (!lineHeight || typeof fontSize !== "number") {
    return undefined;
  }
  if (lineHeight.unit === "PIXELS" && typeof lineHeight.value === "number") {
    return lineHeight.value;
  }
  if (lineHeight.unit === "PERCENT" && typeof lineHeight.value === "number") {
    return (lineHeight.value / 100) * fontSize;
  }
  return undefined;
}

function normalizeText(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function comparePath(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const diff = (leftParts[index] ?? -1) - (rightParts[index] ?? -1);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function formatSummary(report) {
  const lines = [
    `DOM nodes: ${report.domNodeCount}`,
    `Figma nodes: ${report.figmaNodeCount}`,
    `Findings: ${report.findingCount}`
  ];
  for (const finding of report.findings.slice(0, 20)) {
    lines.push(`- [${finding.severity}] ${finding.path}: ${finding.message}`);
  }
  if (report.findings.length > 20) {
    lines.push(`- ... ${report.findings.length - 20} more`);
  }
  return lines.join("\n");
}
