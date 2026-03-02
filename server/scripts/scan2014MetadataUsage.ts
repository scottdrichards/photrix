/* eslint-disable @typescript-eslint/no-explicit-any */
import exifr from "exifr";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { getExifMetadataFromFile, walkFiles } from "../src/fileHandling/fileUtils.ts";

type ScriptArgs = {
  folder: string;
  sampleSize: number;
  output: string;
};

const defaultOutputPath = path.resolve(process.cwd(), "scripts", "metadata_usage_2014_report.json");

const parseArgs = (argv: string[]): ScriptArgs => {
  const getValue = (flag: string) => {
    const index = argv.findIndex((arg) => arg === flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  const folder = getValue("--folder");
  if (!folder) {
    throw new Error("Missing required argument --folder. Example: --folder \\\\TRUENAS\\Pictures and Videos READONLY\\2014");
  }

  const sampleSizeRaw = getValue("--sample-size") ?? "300";
  const sampleSize = Number.parseInt(sampleSizeRaw, 10);
  if (!Number.isFinite(sampleSize) || sampleSize <= 0) {
    throw new Error(`Invalid --sample-size value: ${sampleSizeRaw}`);
  }

  const output = path.resolve(getValue("--output") ?? defaultOutputPath);
  return { folder: path.resolve(folder), sampleSize, output };
};

const pickRandomItems = <T>(items: readonly T[], count: number): T[] => {
  if (count >= items.length) {
    return [...items];
  }

  const copied = [...items];
  for (let i = copied.length - 1; i > 0; i--) {
    const randomIndex = Math.floor(Math.random() * (i + 1));
    [copied[i], copied[randomIndex]] = [copied[randomIndex], copied[i]];
  }
  return copied.slice(0, count);
};

const isPopulated = (value: unknown): boolean => {
  if (value === null || value === undefined) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  return true;
};

const incrementCount = (counter: Record<string, number>, key: string) => {
  counter[key] = (counter[key] ?? 0) + 1;
};

const toSortedUsage = (counts: Record<string, number>, total: number) =>
  Object.entries(counts)
    .map(([key, count]) => ({
      key,
      count,
      percentOfSample: Number(((count / total) * 100).toFixed(2)),
    }))
    .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key));

const extractSemanticKeys = (rawMetadata: Record<string, unknown>) => {
  const semanticCandidates = [
    "Keywords",
    "dc:subject",
    "lr:hierarchicalSubject",
    "Subject",
    "XPKeywords",
    "xmp:Label",
    "Label",
    "xmp:Rating",
    "Rating",
    "PersonInImage",
    "RegionPersonDisplayName",
    "mwg-rs:RegionInfo",
    "mwg-rs:RegionList",
    "mwg-rs:Regions",
  ];

  return semanticCandidates.filter((key) => isPopulated(rawMetadata[key]));
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));

  console.log(`[scan] collecting files under: ${args.folder}`);
  const allFiles = [...walkFiles(args.folder)];
  if (!allFiles.length) {
    throw new Error(`No files found under ${args.folder}`);
  }

  const sampledFiles = pickRandomItems(allFiles, args.sampleSize);
  console.log(`[scan] found ${allFiles.length} files, sampling ${sampledFiles.length}`);

  const standardizedKeyCounts: Record<string, number> = {};
  const rawFieldCoverageCounts: Record<string, number> = {};
  const rawFieldPopulatedCounts: Record<string, number> = {};
  const semanticKeyCounts: Record<string, number> = {};
  const tagValueCounts: Record<string, number> = {};
  const sampleBreakdown: Array<{
    filePath: string;
    extension: string;
    standardizedKeys: string[];
    semanticKeys: string[];
    rawKeyCount: number;
  }> = [];

  let rawParseSuccessCount = 0;
  let rawParseFailureCount = 0;

  for (let index = 0; index < sampledFiles.length; index += 1) {
    const fullPath = sampledFiles[index];
    if ((index + 1) % 10 === 0 || index === 0) {
      console.log(`[scan] parsing ${index + 1}/${sampledFiles.length}: ${fullPath}`);
    }

    const standardized = await getExifMetadataFromFile(fullPath);
    const standardizedKeys = Object.entries(standardized)
      .filter(([, value]) => isPopulated(value))
      .map(([key]) => key)
      .sort((left, right) => left.localeCompare(right));

    standardizedKeys.forEach((key) => incrementCount(standardizedKeyCounts, key));

    const tags = standardized.tags;
    if (Array.isArray(tags)) {
      tags
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .map((value) => value.trim())
        .forEach((value) => incrementCount(tagValueCounts, value));
    }

    let rawMetadata: Record<string, unknown> = {};
    try {
      rawMetadata = (await exifr.parse(fullPath, {
        translateValues: false,
        xmp: true,
        ifd0: {},
        exif: {},
        gps: {},
        iptc: true,
        tiff: true,
        interop: true,
        jfif: true,
        makerNote: true,
      })) as Record<string, unknown>;
      rawParseSuccessCount += 1;
    } catch {
      rawParseFailureCount += 1;
    }

    const rawEntries = Object.entries(rawMetadata);
    rawEntries.forEach(([key]) => incrementCount(rawFieldCoverageCounts, key));

    const rawKeys = rawEntries
      .filter(([, value]) => isPopulated(value))
      .map(([key]) => key)
      .sort((left, right) => left.localeCompare(right));
    rawKeys.forEach((key) => incrementCount(rawFieldPopulatedCounts, key));

    const semanticKeys = extractSemanticKeys(rawMetadata);
    semanticKeys.forEach((key) => incrementCount(semanticKeyCounts, key));

    sampleBreakdown.push({
      filePath: fullPath,
      extension: path.extname(fullPath).toLowerCase(),
      standardizedKeys,
      semanticKeys,
      rawKeyCount: rawKeys.length,
    });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    folderScanned: args.folder,
    totalFilesFound: allFiles.length,
    sampledFileCount: sampledFiles.length,
    parseStats: {
      rawParseSuccessCount,
      rawParseFailureCount,
    },
    standardizedMetadataUsage: toSortedUsage(standardizedKeyCounts, sampledFiles.length),
    semanticMetadataUsage: toSortedUsage(semanticKeyCounts, sampledFiles.length),
    rawMetadataFieldCoverage: toSortedUsage(rawFieldCoverageCounts, sampledFiles.length),
    rawMetadataFieldPopulation: toSortedUsage(rawFieldPopulatedCounts, sampledFiles.length),
    rawMetadataFieldsChecked: Object.keys(rawFieldCoverageCounts).sort((left, right) => left.localeCompare(right)),
    topTagValues: Object.entries(tagValueCounts)
      .map(([value, count]) => ({ value, count }))
      .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value))
      .slice(0, 100),
    sampledFiles: sampleBreakdown,
  };

  await writeFile(args.output, JSON.stringify(report, null, 2), "utf8");
  console.log(`[scan] report written to ${args.output}`);
};

main().catch((error) => {
  console.error(`[scan] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});