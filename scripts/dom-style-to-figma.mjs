#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";

const args = parseArgs(process.argv.slice(2));
const namedColors = {
  black: { color: "#000000" },
  white: { color: "#ffffff" },
  transparent: undefined
};

if (!args.dom || !args.out) {
  console.error("Usage: node scripts/dom-style-to-figma.mjs --dom dom-style.json --out render-request.json [--name Name] [--request-id id] [--max-depth 8]");
  process.exit(2);
}

const root = JSON.parse(await readFile(args.dom, "utf8"));
const maxDepth = Number.isFinite(Number(args["max-depth"])) ? Number(args["max-depth"]) : 8;
const documentName = args.name ?? inferDocumentName(root);
const rootNode = convertElement(root, null, "dom-0", 0, maxDepth, true);
const request = {
  requestId: args["request-id"] ?? slug(documentName),
  document: {
    version: 1,
    name: documentName,
    nodes: [rootNode],
    selection: [rootNode.id],
    viewport: "selection"
  }
};

await writeFile(args.out, `${JSON.stringify(request, null, 2)}\n`);
console.log(`Wrote ${args.out}`);
console.log(`Root ${rootNode.width}x${rootNode.height}, ${countNodes(rootNode)} Figma DSL nodes`);

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

function convertElement(node, parent, id, depth, maxDepthValue, isRoot = false) {
  const rect = normalizeRect(node.rect);
  const parentRect = normalizeRect(parent?.rect);
  const style = node.style ?? {};
  const x = isRoot ? 0 : round(rect.x - parentRect.x);
  const y = isRoot ? 0 : round(rect.y - parentRect.y);
  const width = Math.max(1, round(rect.width));
  const height = Math.max(1, round(rect.height));
  const children = Array.isArray(node.children) ? node.children : [];
  const renderableChildren = children
    .map((child, index) => ({ child, index }))
    .filter(({ child }) => shouldRenderElement(child));

  if (isCheckbox(node)) {
    return checkboxDslForElement(node, { x, y, width, height }, id, nodeName(node, id));
  }

  if (shouldRenderAsTextNode(node, renderableChildren, isRoot)) {
    return textDslForElement(node, { x, y, width, height }, id, nodeName(node, id));
  }

  const figmaNode = compact({
    id,
    type: "frame",
    name: nodeName(node, id),
    x,
    y,
    width,
    height,
    fills: elementFills(node, isRoot),
    strokes: elementStrokes(node),
    strokeWeight: elementStrokeWeight(node),
    effects: parseBoxShadow(css(style, "box-shadow")),
    cornerRadius: parseRadius(css(style, "border-radius")),
    opacity: parseOpacity(css(style, "opacity")),
    clipsContent: css(style, "overflow") === "hidden",
    children: []
  });

  if (depth < maxDepthValue) {
    for (const { child, index } of renderableChildren) {
      figmaNode.children.push(convertElement(child, node, `${id}-${index}`, depth + 1, maxDepthValue));
    }
  }

  const textNode = textDslForElement(node, { x: 0, y: 0, width, height }, `${id}-text`);
  if (textNode) {
    figmaNode.children.push(textNode);
  }
  const selectArrow = selectArrowDslForElement(node, { width, height }, `${id}-select-arrow`);
  if (selectArrow) {
    figmaNode.children.push(selectArrow);
  }

  if (figmaNode.children.length === 0) {
    delete figmaNode.children;
  }

  return figmaNode;
}

function shouldRenderAsTextNode(node, renderableChildren, isRoot) {
  if (isRoot || renderableChildren.length > 0 || !nodeText(node)) {
    return false;
  }
  if (textInsetX(node) !== 0 || textInsetY(node) !== 0) {
    return false;
  }
  return !hasFrameVisuals(node, false);
}

function hasFrameVisuals(node, isRoot) {
  const style = node.style ?? {};
  return Boolean(
    hasPaints(elementFills(node, isRoot)) ||
      elementStrokes(node) ||
      elementStrokeWeight(node) ||
      parseBoxShadow(css(style, "box-shadow")) ||
      parseRadius(css(style, "border-radius")) ||
      css(style, "overflow") === "hidden"
  );
}

function shouldRenderElement(node) {
  const rect = normalizeRect(node.rect);
  if (rect.width <= 0 || rect.height <= 0) {
    return false;
  }
  const style = node.style ?? {};
  if (css(style, "display") === "none" || css(style, "visibility") === "hidden") {
    return false;
  }
  return true;
}

function textDslForElement(domNode, box, id, name = undefined) {
  const text = nodeText(domNode);
  if (!text) {
    return undefined;
  }

  const style = domNode.style ?? {};
  const fontSize = parsePixels(css(style, "font-size")) ?? 12;
  const lineHeight = parseLineHeight(css(style, "line-height"), fontSize);
  const letterSpacing = parseLetterSpacing(css(style, "letter-spacing"));
  const color = parseColor(css(style, "color")) ?? { color: "#172033" };
  const textAutoResize = textAutoResizeForElement(domNode, fontSize, lineHeight);
  const fixedBox = textAutoResize !== "WIDTH_AND_HEIGHT";
  const alignment = textAlignmentForElement(domNode);

  return compact({
    id,
    type: "text",
    name: name ?? `text / ${text.slice(0, 48)}`,
    text,
    x: box.x + textInsetX(domNode),
    y: box.y + textInsetY(domNode),
    width: fixedBox ? Math.max(1, box.width - textInsetX(domNode) * 2) : undefined,
    height: fixedBox ? Math.max(fontSize, box.height - textInsetY(domNode) * 2) : undefined,
    fills: [{ type: "solid", color: color.color, opacity: color.opacity }],
    fontName: "Inter",
    fontStyle: fontStyleForWeight(css(style, "font-weight")),
    fontSize,
    lineHeight,
    letterSpacing,
    textAlignHorizontal: alignment.horizontal,
    textAlignVertical: alignment.vertical,
    textAutoResize
  });
}

function textAutoResizeForElement(domNode, fontSize, lineHeight) {
  const style = domNode.style ?? {};
  if (usesFixedTextBox(domNode)) {
    return "NONE";
  }
  if (
    css(style, "white-space") === "nowrap" ||
    css(style, "text-overflow") === "ellipsis" ||
    css(style, "display") === "inline" ||
    css(style, "width") === "auto"
  ) {
    return "WIDTH_AND_HEIGHT";
  }
  if (isSingleLineTextBox(domNode, fontSize, lineHeight)) {
    return "WIDTH_AND_HEIGHT";
  }
  return "HEIGHT";
}

function textAlignmentForElement(domNode) {
  if (usesCenteredTextBox(domNode)) {
    return { horizontal: "CENTER", vertical: "CENTER" };
  }
  if (isButton(domNode)) {
    return {
      horizontal: textAlignHorizontal(css(domNode.style ?? {}, "text-align")),
      vertical: "CENTER"
    };
  }
  return {
    horizontal: textAlignHorizontal(css(domNode.style ?? {}, "text-align")),
    vertical: "TOP"
  };
}

function usesFixedTextBox(domNode) {
  return usesCenteredTextBox(domNode) || isButton(domNode);
}

function usesCenteredTextBox(domNode) {
  const display = css(domNode.style ?? {}, "display");
  return display.includes("grid") || display.includes("flex");
}

function checkboxDslForElement(domNode, box, id, name) {
  const checked = domNode.checked === true;
  const size = Math.max(1, Math.min(box.width, box.height));
  const node = compact({
    id,
    type: "frame",
    name,
    x: box.x,
    y: box.y,
    width: size,
    height: size,
    fills: [{ type: "solid", color: checked ? "#1167d8" : "#ffffff" }],
    strokes: [{ type: "solid", color: checked ? "#1167d8" : "#d7deea" }],
    strokeWeight: 1,
    cornerRadius: 2,
    children: checked
      ? [
          {
            id: `${id}-check`,
            type: "text",
            name: "text / check",
            text: "✓",
            x: 3,
            y: 1,
            fills: [{ type: "solid", color: "#ffffff" }],
            fontName: "Inter",
            fontStyle: "Bold",
            fontSize: 11,
            lineHeight: { unit: "PIXELS", value: 14 },
            textAutoResize: "WIDTH_AND_HEIGHT"
          }
        ]
      : undefined
  });
  return node;
}

function selectArrowDslForElement(domNode, box, id) {
  if (!isSelect(domNode)) {
    return undefined;
  }
  const arrowWidth = 7;
  const arrowHeight = 4;
  return {
    id,
    type: "vector",
    name: "select arrow",
    x: round(Math.max(0, box.width - 13)),
    y: round(Math.max(0, (box.height - arrowHeight) / 2)),
    width: arrowWidth,
    height: arrowHeight,
    fills: [],
    strokes: [{ type: "solid", color: "#4f5662" }],
    strokeWeight: 1.2,
    vectorPaths: [
      {
        windingRule: "NONE",
        data: `M0 0 L${arrowWidth / 2} ${arrowHeight} L${arrowWidth} 0`
      }
    ]
  };
}

function isSingleLineTextBox(domNode, fontSize, lineHeight) {
  const rect = normalizeRect(domNode.rect);
  const effectiveLineHeight = lineHeightPixels(lineHeight, fontSize);
  return rect.height > 0 && rect.height <= effectiveLineHeight * 1.12;
}

function lineHeightPixels(lineHeight, fontSize) {
  if (lineHeight && lineHeight.unit === "PIXELS" && typeof lineHeight.value === "number") {
    return lineHeight.value;
  }
  if (lineHeight && lineHeight.unit === "PERCENT" && typeof lineHeight.value === "number") {
    return (fontSize * lineHeight.value) / 100;
  }
  return fontSize * 1.45;
}

function elementFills(node, isRoot) {
  const gradient = parseLinearGradient(css(node.style ?? {}, "background-image"));
  if (gradient) {
    return [gradient];
  }

  const background = parseColor(css(node.style ?? {}, "background-color"));
  if (background) {
    return [{ type: "solid", color: background.color, opacity: background.opacity }];
  }
  if (isRoot) {
    return [{ type: "solid", color: "#f5f7fb" }];
  }
  return [];
}

function hasPaints(paints) {
  return Array.isArray(paints) && paints.length > 0;
}

function elementStrokes(node) {
  if (!elementStrokeWeight(node)) {
    return undefined;
  }
  const color = parseColor(
    css(node.style ?? {}, "border-color") ||
      css(node.style ?? {}, "border-top-color") ||
      css(node.style ?? {}, "border-right-color") ||
      css(node.style ?? {}, "border-bottom-color") ||
      css(node.style ?? {}, "border-left-color")
  );
  return color ? [{ type: "solid", color: color.color, opacity: color.opacity }] : undefined;
}

function elementStrokeWeight(node) {
  const style = node.style ?? {};
  const widths = [
    css(style, "border-top-width"),
    css(style, "border-right-width"),
    css(style, "border-bottom-width"),
    css(style, "border-left-width")
  ].map(parsePixels).filter((value) => typeof value === "number" && value > 0);
  return widths.length > 0 ? Math.max(...widths) : undefined;
}

function parseColor(value) {
  if (!value || value === "transparent" || value === "rgba(0, 0, 0, 0)") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized in namedColors) {
    return namedColors[normalized];
  }

  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(normalized);
  if (hex) {
    const raw = hex[1].length === 3 ? hex[1].split("").map((part) => part + part).join("") : hex[1];
    return { color: `#${raw.toLowerCase()}` };
  }

  const rgb = /^rgba?\(([^)]+)\)$/i.exec(normalized);
  if (!rgb) {
    return undefined;
  }

  const parts = rgb[1].split(",").map((part) => Number.parseFloat(part.trim()));
  const alpha = parts.length >= 4 ? parts[3] : 1;
  if (alpha <= 0) {
    return undefined;
  }
  return {
    color: rgbToHex(parts[0], parts[1], parts[2]),
    opacity: alpha < 1 ? alpha : undefined
  };
}

function parseLinearGradient(value) {
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

  const direction = gradientDirection(parts[0]);
  const stopParts = direction.consumesFirstPart ? parts.slice(1) : parts;
  const stops = stopParts.map((part, index) => parseGradientStop(part, index, stopParts.length)).filter(Boolean);
  if (stops.length < 2) {
    return undefined;
  }

  return {
    type: "linear-gradient",
    from: direction.from,
    stops
  };
}

function gradientDirection(part) {
  const value = part.trim().toLowerCase();
  if (value.startsWith("to ")) {
    if (value.includes("bottom")) return { from: "top", consumesFirstPart: true };
    if (value.includes("top")) return { from: "bottom", consumesFirstPart: true };
    if (value.includes("right")) return { from: "left", consumesFirstPart: true };
    if (value.includes("left")) return { from: "right", consumesFirstPart: true };
  }

  if (value.endsWith("deg")) {
    const angle = ((Number.parseFloat(value) % 360) + 360) % 360;
    if (angle >= 45 && angle < 135) return { from: "left", consumesFirstPart: true };
    if (angle >= 135 && angle < 225) return { from: "top", consumesFirstPart: true };
    if (angle >= 225 && angle < 315) return { from: "right", consumesFirstPart: true };
    return { from: "bottom", consumesFirstPart: true };
  }

  return { from: "top", consumesFirstPart: false };
}

function parseGradientStop(value, index, total) {
  const colorMatch = /(rgba?\([^)]+\)|#[0-9a-f]{3,8}\b|[a-z]+)\s*(.*)$/i.exec(value.trim());
  const color = parseColor(colorMatch?.[1] ?? "");
  if (!color) {
    return undefined;
  }

  const rawPosition = colorMatch?.[2]?.trim();
  let position = total <= 1 ? 0 : index / (total - 1);
  if (rawPosition?.endsWith("%")) {
    position = Number.parseFloat(rawPosition) / 100;
  } else {
    const pixels = parsePixels(rawPosition);
    if (typeof pixels === "number") {
      position = pixels;
    }
  }

  return {
    color: color.color,
    position: Math.max(0, Math.min(1, position))
  };
}

function parseBoxShadow(value) {
  if (!value || value === "none") {
    return undefined;
  }

  const effects = splitCssList(value)
    .map(parseSingleShadow)
    .filter(Boolean);
  return effects.length > 0 ? effects : undefined;
}

function parseSingleShadow(value) {
  const normalized = value.trim();
  const inset = /\binset\b/i.test(normalized);
  const withoutInset = normalized.replace(/\binset\b/gi, "").trim();
  const colorMatch = /(rgba?\([^)]+\)|#[0-9a-f]{3,8}\b)/i.exec(withoutInset);
  const color = parseColor(colorMatch?.[1] ?? "");
  if (!color) {
    return undefined;
  }

  const lengthPart = colorMatch
    ? `${withoutInset.slice(0, colorMatch.index)} ${withoutInset.slice(colorMatch.index + colorMatch[0].length)}`
    : withoutInset;
  const lengths = lengthPart
    .trim()
    .split(/\s+/)
    .map(parsePixels)
    .filter((part) => typeof part === "number");

  if (lengths.length < 2) {
    return undefined;
  }

  return compact({
    type: inset ? "inner-shadow" : "drop-shadow",
    color: color.color,
    opacity: color.opacity,
    offsetX: lengths[0],
    offsetY: lengths[1],
    radius: lengths[2] ?? 0,
    spread: lengths[3]
  });
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

function rgbToHex(red, green, blue) {
  return `#${toHex(red)}${toHex(green)}${toHex(blue)}`;
}

function toHex(value) {
  return Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0");
}

function css(style, property) {
  return style[property] ?? style[toCamelCase(property)] ?? "";
}

function toCamelCase(property) {
  return property.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function parsePixels(value) {
  const match = /^(-?\d+(?:\.\d+)?)px$/.exec(String(value ?? "").trim());
  return match ? Number.parseFloat(match[1]) : undefined;
}

function parseRadius(value) {
  const radius = parsePixels(String(value ?? "").split(" ")[0]);
  return radius && radius > 0 ? radius : undefined;
}

function parseOpacity(value) {
  const opacity = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(opacity) && opacity >= 0 && opacity < 1 ? opacity : undefined;
}

function parseLineHeight(value, fontSize) {
  if (!value || value === "normal") {
    return { unit: "AUTO" };
  }
  const pixels = parsePixels(value);
  if (typeof pixels === "number") {
    return { unit: "PIXELS", value: pixels };
  }
  const numeric = Number.parseFloat(value);
  if (Number.isFinite(numeric) && !value.includes("%")) {
    return { unit: "PERCENT", value: (numeric * fontSize * 100) / fontSize };
  }
  if (Number.isFinite(numeric) && value.includes("%")) {
    return { unit: "PERCENT", value: numeric };
  }
  return { unit: "AUTO" };
}

function parseLetterSpacing(value) {
  if (!value || value === "normal") {
    return undefined;
  }
  const pixels = parsePixels(value);
  return typeof pixels === "number" ? { unit: "PIXELS", value: pixels } : undefined;
}

function textAlignHorizontal(value) {
  if (value === "center") return "CENTER";
  if (value === "right" || value === "end") return "RIGHT";
  if (value === "justify") return "JUSTIFIED";
  return "LEFT";
}

function fontStyleForWeight(value) {
  const weight = Number.parseInt(value, 10);
  if (Number.isFinite(weight)) {
    if (weight >= 700) return "Bold";
    if (weight >= 600) return "Semi Bold";
    if (weight >= 500) return "Medium";
  }
  return "Regular";
}

function textInsetX(node) {
  return parsePixels(css(node.style ?? {}, "padding-left")) ?? 0;
}

function textInsetY(node) {
  if (isFormControl(node)) {
    const style = node.style ?? {};
    const fontSize = parsePixels(css(style, "font-size")) ?? 12;
    const lineHeight = lineHeightPixels(parseLineHeight(css(style, "line-height"), fontSize), fontSize);
    return round(Math.max(0, (normalizeRect(node.rect).height - lineHeight) / 2));
  }
  return parsePixels(css(node.style ?? {}, "padding-top")) ?? 0;
}

function normalizeRect(rect) {
  return {
    x: Number(rect?.x ?? 0),
    y: Number(rect?.y ?? 0),
    width: Number(rect?.width ?? 1),
    height: Number(rect?.height ?? 1)
  };
}

function normalizeText(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function nodeText(node) {
  const text = normalizeText(node.text);
  if (text) {
    return text;
  }
  if (isSelect(node)) {
    return normalizeText(node.selectedText) || normalizeText(node.value) || "归档";
  }
  if (isTextInput(node)) {
    return normalizeText(node.value) || normalizeText(node.placeholder);
  }
  return "";
}

function isSelect(node) {
  return String(node.tag ?? "").toLowerCase() === "select";
}

function isTextInput(node) {
  const tag = String(node.tag ?? "").toLowerCase();
  if (tag === "textarea") {
    return true;
  }
  if (tag !== "input") {
    return false;
  }
  const type = String(node.typeAttr ?? "text").toLowerCase();
  return !["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"].includes(type);
}

function isFormControl(node) {
  return isSelect(node) || isTextInput(node);
}

function isButton(node) {
  return String(node.tag ?? "").toLowerCase() === "button";
}

function isCheckbox(node) {
  return String(node.tag ?? "").toLowerCase() === "input" && String(node.typeAttr ?? "").toLowerCase() === "checkbox";
}

function nodeName(node, id) {
  const classes = Array.isArray(node.classes) && node.classes.length ? `.${node.classes.join(".")}` : "";
  const text = nodeText(node);
  return `${id} / ${node.tag ?? "element"}${classes}${text ? ` / ${text.slice(0, 32)}` : ""}`;
}

function inferDocumentName(rootNode) {
  const classes = Array.isArray(rootNode.classes) ? rootNode.classes.join(" ") : "dom";
  return classes.includes("workspace-shell") ? "Optipass DOM / Workbench" : "Optipass DOM / Launch";
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "dom-style-to-figma";
}

function compact(record) {
  const result = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function countNodes(node) {
  return 1 + (node.children ?? []).reduce((total, child) => total + countNodes(child), 0);
}
