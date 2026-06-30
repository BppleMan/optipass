#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { deflateSync, inflateSync } from "node:zlib";

const args = parseArgs(process.argv.slice(2));
const execFileAsync = promisify(execFile);
var crcTable;

if (!args.source || !args.target) {
  console.error("Usage: node scripts/figma-image-diff.mjs --source browser.png --target figma.png|figma-export.json [--diff diff.png] [--out report.json] [--threshold 6] [--tile-size 160] [--top-regions 12] [--samples '100,100;200,200']");
  process.exit(2);
}

const threshold = Number.isFinite(Number(args.threshold)) ? Number(args.threshold) : 6;
const tileSize = Number.isFinite(Number(args["tile-size"])) ? Number(args["tile-size"]) : 0;
const topRegionCount = Number.isFinite(Number(args["top-regions"])) ? Number(args["top-regions"]) : 0;
const samples = parseSamples(args.samples);
const cleanupDirs = [];

try {
  const source = decodePng(await loadImageAsPngBytes(args.source, cleanupDirs));
  const target = decodePng(await loadImageAsPngBytes(args.target, cleanupDirs));
  const report = compareImages(source, target, threshold, { tileSize, topRegionCount });
  if (samples.length > 0) {
    report.samples = samplePixels(source, target, samples);
  }

  if (args.diff) {
    await writeFile(args.diff, encodePng(report.overlapWidth, report.overlapHeight, report.diffPixels));
  }
  delete report.diffPixels;

  if (args.out) {
    await writeFile(args.out, `${JSON.stringify(report, null, 2)}\n`);
  }

  console.log(formatReport(report));
} finally {
  await Promise.all(cleanupDirs.map((dir) => rm(dir, { recursive: true, force: true })));
}

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

function parseSamples(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return [];
  }
  return value
    .split(";")
    .map((sample) => sample.trim().split(",").map((part) => Number.parseInt(part.trim(), 10)))
    .filter((parts) => parts.length === 2 && parts.every((part) => Number.isFinite(part)))
    .map(([x, y]) => ({ x, y }));
}

async function loadImageAsPngBytes(path, cleanupDirs) {
  const bytes = await readFile(path);
  const text = bytes.toString("utf8").trim();
  if (text.startsWith("{")) {
    const json = JSON.parse(text);
    const dataUrl = json?.result?.image?.data ?? json?.image?.data ?? json?.data;
    return normalizeToPngBytes(decodeDataUrl(dataUrl, path), cleanupDirs, extensionForDataUrl(dataUrl));
  }
  if (text.startsWith("data:image/")) {
    return normalizeToPngBytes(decodeDataUrl(text, path), cleanupDirs, extensionForDataUrl(text));
  }
  return normalizeToPngBytes(bytes, cleanupDirs, extensionForMagic(bytes));
}

function decodeDataUrl(dataUrl, path) {
  if (typeof dataUrl !== "string") {
    throw new Error(`${path} does not contain a Figma image data URL`);
  }
  const match = /^data:image\/(png|jpeg|jpg);base64,(.+)$/i.exec(dataUrl);
  if (!match) {
    throw new Error(`${path} is not a supported image data URL`);
  }
  return Buffer.from(match[2], "base64");
}

async function normalizeToPngBytes(bytes, cleanupDirs, extension) {
  if (isPng(bytes)) {
    return bytes;
  }

  const dir = await mkdtemp(join(tmpdir(), "figma-image-diff-"));
  cleanupDirs.push(dir);
  const inputPath = join(dir, `input.${extension}`);
  const outputPath = join(dir, "output.png");
  await writeFile(inputPath, bytes);
  await execFileAsync("sips", ["-s", "format", "png", inputPath, "--out", outputPath]);
  return readFile(outputPath);
}

function extensionForDataUrl(dataUrl) {
  return /^data:image\/jpe?g;/i.test(dataUrl) ? "jpg" : "png";
}

function extensionForMagic(bytes) {
  if (isPng(bytes)) return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "jpg";
  return "img";
}

function isPng(bytes) {
  return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
}

function decodePng(buffer) {
  assertPngSignature(buffer);

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette;
  let transparency;
  const idatChunks = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const data = buffer.subarray(dataStart, dataEnd);
    offset = dataEnd + 4;

    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "PLTE") {
      palette = data;
    } else if (type === "tRNS") {
      transparency = data;
    } else if (type === "IDAT") {
      idatChunks.push(data);
    } else if (type === "IEND") {
      break;
    }
  }

  if (bitDepth !== 8) {
    throw new Error(`Unsupported PNG bit depth: ${bitDepth}`);
  }
  if (interlace !== 0) {
    throw new Error("Interlaced PNGs are not supported");
  }

  const channels = channelsForColorType(colorType);
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idatChunks));
  const unpacked = unfilter(raw, width, height, channels, stride);
  const pixels = toRgba(unpacked, width, height, colorType, palette, transparency);

  return { width, height, pixels };
}

function assertPngSignature(buffer) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let index = 0; index < signature.length; index += 1) {
    if (buffer[index] !== signature[index]) {
      throw new Error("Input is not a PNG file");
    }
  }
}

function channelsForColorType(colorType) {
  if (colorType === 0 || colorType === 3) return 1;
  if (colorType === 2) return 3;
  if (colorType === 4) return 2;
  if (colorType === 6) return 4;
  throw new Error(`Unsupported PNG color type: ${colorType}`);
}

function unfilter(raw, width, height, channels, stride) {
  const output = Buffer.alloc(height * stride);
  let inputOffset = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = raw[inputOffset];
    inputOffset += 1;
    const rowOffset = y * stride;
    const previousRowOffset = (y - 1) * stride;

    for (let x = 0; x < stride; x += 1) {
      const value = raw[inputOffset + x];
      const left = x >= channels ? output[rowOffset + x - channels] : 0;
      const up = y > 0 ? output[previousRowOffset + x] : 0;
      const upLeft = y > 0 && x >= channels ? output[previousRowOffset + x - channels] : 0;

      if (filter === 0) output[rowOffset + x] = value;
      else if (filter === 1) output[rowOffset + x] = (value + left) & 0xff;
      else if (filter === 2) output[rowOffset + x] = (value + up) & 0xff;
      else if (filter === 3) output[rowOffset + x] = (value + Math.floor((left + up) / 2)) & 0xff;
      else if (filter === 4) output[rowOffset + x] = (value + paeth(left, up, upLeft)) & 0xff;
      else throw new Error(`Unsupported PNG filter: ${filter}`);
    }

    inputOffset += stride;
  }

  return output;
}

function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upLeftDistance = Math.abs(estimate - upLeft);
  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) return left;
  if (upDistance <= upLeftDistance) return up;
  return upLeft;
}

function toRgba(bytes, width, height, colorType, palette, transparency) {
  const pixels = Buffer.alloc(width * height * 4);
  let inputOffset = 0;
  let outputOffset = 0;

  for (let index = 0; index < width * height; index += 1) {
    if (colorType === 0) {
      const gray = bytes[inputOffset];
      inputOffset += 1;
      pixels[outputOffset++] = gray;
      pixels[outputOffset++] = gray;
      pixels[outputOffset++] = gray;
      pixels[outputOffset++] = 255;
    } else if (colorType === 2) {
      pixels[outputOffset++] = bytes[inputOffset++];
      pixels[outputOffset++] = bytes[inputOffset++];
      pixels[outputOffset++] = bytes[inputOffset++];
      pixels[outputOffset++] = 255;
    } else if (colorType === 3) {
      const paletteIndex = bytes[inputOffset++];
      const paletteOffset = paletteIndex * 3;
      pixels[outputOffset++] = palette?.[paletteOffset] ?? 0;
      pixels[outputOffset++] = palette?.[paletteOffset + 1] ?? 0;
      pixels[outputOffset++] = palette?.[paletteOffset + 2] ?? 0;
      pixels[outputOffset++] = transparency?.[paletteIndex] ?? 255;
    } else if (colorType === 4) {
      const gray = bytes[inputOffset++];
      pixels[outputOffset++] = gray;
      pixels[outputOffset++] = gray;
      pixels[outputOffset++] = gray;
      pixels[outputOffset++] = bytes[inputOffset++];
    } else if (colorType === 6) {
      pixels[outputOffset++] = bytes[inputOffset++];
      pixels[outputOffset++] = bytes[inputOffset++];
      pixels[outputOffset++] = bytes[inputOffset++];
      pixels[outputOffset++] = bytes[inputOffset++];
    }
  }

  return pixels;
}

function compareImages(source, target, threshold, options = {}) {
  const overlapWidth = Math.min(source.width, target.width);
  const overlapHeight = Math.min(source.height, target.height);
  const diffPixels = Buffer.alloc(overlapWidth * overlapHeight * 4);
  const tileStats = createTileStats(overlapWidth, overlapHeight, options.tileSize);
  let mismatchedPixels = 0;
  let totalChannelDelta = 0;
  let maxChannelDelta = 0;

  for (let y = 0; y < overlapHeight; y += 1) {
    for (let x = 0; x < overlapWidth; x += 1) {
      const sourceOffset = (y * source.width + x) * 4;
      const targetOffset = (y * target.width + x) * 4;
      const diffOffset = (y * overlapWidth + x) * 4;
      let pixelMismatch = false;
      let pixelChannelDelta = 0;

      for (let channel = 0; channel < 4; channel += 1) {
        const delta = Math.abs(source.pixels[sourceOffset + channel] - target.pixels[targetOffset + channel]);
        pixelChannelDelta += delta;
        totalChannelDelta += delta;
        maxChannelDelta = Math.max(maxChannelDelta, delta);
        if (delta > threshold) {
          pixelMismatch = true;
        }
      }

      if (pixelMismatch) {
        mismatchedPixels += 1;
        diffPixels[diffOffset] = 255;
        diffPixels[diffOffset + 1] = 0;
        diffPixels[diffOffset + 2] = 90;
        diffPixels[diffOffset + 3] = 255;
      } else {
        diffPixels[diffOffset] = faded(source.pixels[sourceOffset]);
        diffPixels[diffOffset + 1] = faded(source.pixels[sourceOffset + 1]);
        diffPixels[diffOffset + 2] = faded(source.pixels[sourceOffset + 2]);
        diffPixels[diffOffset + 3] = 255;
      }

      recordTilePixel(tileStats, x, y, pixelMismatch, pixelChannelDelta);
    }
  }

  const totalPixels = overlapWidth * overlapHeight;
  const topRegions = summarizeTopRegions(tileStats, options.topRegionCount);
  return {
    source: { width: source.width, height: source.height },
    target: { width: target.width, height: target.height },
    overlapWidth,
    overlapHeight,
    sizeMismatch: source.width !== target.width || source.height !== target.height,
    threshold,
    totalPixels,
    mismatchedPixels,
    mismatchRatio: round(totalPixels === 0 ? 0 : mismatchedPixels / totalPixels),
    meanChannelDelta: round(totalPixels === 0 ? 0 : totalChannelDelta / (totalPixels * 4)),
    normalizedMeanDelta: round(totalPixels === 0 ? 0 : totalChannelDelta / (totalPixels * 4 * 255)),
    maxChannelDelta,
    topRegions,
    diffPixels
  };
}

function createTileStats(width, height, tileSize) {
  if (!Number.isFinite(tileSize) || tileSize <= 0) {
    return undefined;
  }
  const columns = Math.ceil(width / tileSize);
  const rows = Math.ceil(height / tileSize);
  return {
    tileSize,
    columns,
    rows,
    tiles: Array.from({ length: rows * columns }, (_, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const x = column * tileSize;
      const y = row * tileSize;
      return {
        x,
        y,
        width: Math.min(tileSize, width - x),
        height: Math.min(tileSize, height - y),
        totalPixels: 0,
        mismatchedPixels: 0,
        channelDelta: 0
      };
    })
  };
}

function recordTilePixel(tileStats, x, y, pixelMismatch, pixelChannelDelta) {
  if (!tileStats) {
    return;
  }
  const column = Math.floor(x / tileStats.tileSize);
  const row = Math.floor(y / tileStats.tileSize);
  const tile = tileStats.tiles[row * tileStats.columns + column];
  tile.totalPixels += 1;
  tile.channelDelta += pixelChannelDelta;
  if (pixelMismatch) {
    tile.mismatchedPixels += 1;
  }
}

function summarizeTopRegions(tileStats, count) {
  if (!tileStats || !Number.isFinite(count) || count <= 0) {
    return undefined;
  }
  return tileStats.tiles
    .filter((tile) => tile.mismatchedPixels > 0)
    .map((tile) => ({
      x: tile.x,
      y: tile.y,
      width: tile.width,
      height: tile.height,
      totalPixels: tile.totalPixels,
      mismatchedPixels: tile.mismatchedPixels,
      mismatchRatio: round(tile.mismatchedPixels / tile.totalPixels),
      meanChannelDelta: round(tile.channelDelta / (tile.totalPixels * 4))
    }))
    .sort((left, right) => {
      if (right.mismatchedPixels !== left.mismatchedPixels) {
        return right.mismatchedPixels - left.mismatchedPixels;
      }
      return right.meanChannelDelta - left.meanChannelDelta;
    })
    .slice(0, count);
}

function samplePixels(source, target, samples) {
  return samples.map(({ x, y }) => {
    const sourcePixel = rgbaAt(source, x, y);
    const targetPixel = rgbaAt(target, x, y);
    return {
      x,
      y,
      source: sourcePixel,
      target: targetPixel,
      delta: sourcePixel && targetPixel ? sourcePixel.map((value, index) => Math.abs(value - targetPixel[index])) : undefined
    };
  });
}

function rgbaAt(image, x, y) {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) {
    return undefined;
  }
  const offset = (y * image.width + x) * 4;
  return [
    image.pixels[offset],
    image.pixels[offset + 1],
    image.pixels[offset + 2],
    image.pixels[offset + 3]
  ];
}

function faded(value) {
  return Math.round(value * 0.25 + 245 * 0.75);
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc(height * (width * 4 + 1));
  let rawOffset = 0;
  let rgbaOffset = 0;
  for (let y = 0; y < height; y += 1) {
    raw[rawOffset++] = 0;
    rgba.copy(raw, rawOffset, rgbaOffset, rgbaOffset + width * 4);
    rawOffset += width * 4;
    rgbaOffset += width * 4;
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr(width, height)),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function ihdr(width, height) {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = 8;
  data[9] = 6;
  data[10] = 0;
  data[11] = 0;
  data[12] = 0;
  return data;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(8 + data.length + 4);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return chunk;
}

function crc32(buffer) {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function getCrcTable() {
  if (!crcTable) {
    crcTable = Array.from({ length: 256 }, (_, index) => {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      return value >>> 0;
    });
  }
  return crcTable;
}

function round(value) {
  return Math.round(value * 1000000) / 1000000;
}

function formatReport(report) {
  const lines = [
    `Source: ${report.source.width}x${report.source.height}`,
    `Target: ${report.target.width}x${report.target.height}`,
    `Overlap: ${report.overlapWidth}x${report.overlapHeight}`,
    `Size mismatch: ${report.sizeMismatch}`,
    `Mismatched pixels: ${report.mismatchedPixels}/${report.totalPixels}`,
    `Mismatch ratio: ${report.mismatchRatio}`,
    `Mean channel delta: ${report.meanChannelDelta}`,
    `Max channel delta: ${report.maxChannelDelta}`
  ];
  if (Array.isArray(report.topRegions) && report.topRegions.length > 0) {
    lines.push("Top regions:");
    for (const region of report.topRegions) {
      lines.push(
        `  ${region.x},${region.y} ${region.width}x${region.height}: ${region.mismatchedPixels}/${region.totalPixels} (${region.mismatchRatio}), mean ${region.meanChannelDelta}`
      );
    }
  }
  if (Array.isArray(report.samples) && report.samples.length > 0) {
    lines.push("Samples:");
    for (const sample of report.samples) {
      lines.push(
        `  ${sample.x},${sample.y}: source ${JSON.stringify(sample.source)}, target ${JSON.stringify(sample.target)}, delta ${JSON.stringify(sample.delta)}`
      );
    }
  }
  return lines.join("\n");
}
