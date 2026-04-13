import path from "node:path";
import {
  extractFaceEmbeddingsFromImage,
  type FaceEmbeddingResult,
} from "../imageProcessing/faceEmbedding.ts";
import { type FaceTag } from "./fileRecord.type.ts";
import { type IndexDatabase } from "./indexDatabase.ts";
import { waitForBackgroundTasksEnabled } from "../common/backgroundTasksControl.ts";
import { measureOperation } from "../observability/requestTrace.ts";

let isProcessingFaceMetadata = false;

type FaceMetadataProcessingStats = {
  processed: number;
  workerSuccess: number;
  fallbackCount: number;
  workerFailures: number;
};

let faceMetadataProcessingStats: FaceMetadataProcessingStats = {
  processed: 0,
  workerSuccess: 0,
  fallbackCount: 0,
  workerFailures: 0,
};

export const isFaceMetadataProcessingActive = () => isProcessingFaceMetadata;

export const getFaceMetadataProcessingStats = () => ({
  active: isProcessingFaceMetadata,
  ...faceMetadataProcessingStats,
});

type Dimensions = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type PersonProfile = {
  id: string;
  name?: string;
  embedding: number[];
};

const stripLeadingSlash = (value: string) => value.replace(/^\\?\//, "");

const clamp = (value: number, min = 0, max = 1) => Math.min(Math.max(value, min), max);

const normalizeDimensions = (area: {
  x: number;
  y: number;
  width: number;
  height: number;
}): Dimensions => ({
  x: clamp(area.x),
  y: clamp(area.y),
  width: clamp(area.width),
  height: clamp(area.height),
});

const toEmbedding = (dimensions: Dimensions): number[] => {
  const { x, y, width, height } = dimensions;
  const cx = x + width / 2;
  const cy = y + height / 2;
  const area = width * height;
  const aspect = height > 0 ? width / height : 1;

  return [x, y, width, height, cx, cy, area, aspect];
};

const dotProduct = (left: number[], right: number[]) =>
  left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);

const magnitude = (values: number[]) =>
  Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));

const cosineSimilarity = (left: number[], right: number[]) => {
  const denominator = magnitude(left) * magnitude(right);
  if (!Number.isFinite(denominator) || denominator === 0) {
    return 0;
  }
  return dotProduct(left, right) / denominator;
};

const buildQuality = (
  dimensions: Dimensions,
  imageDimensions?: { width?: number; height?: number },
) => {
  const imageWidth = imageDimensions?.width ?? 4_000;
  const imageHeight = imageDimensions?.height ?? 3_000;
  const faceWidthPx = dimensions.width * imageWidth;
  const faceHeightPx = dimensions.height * imageHeight;
  const effectiveResolution = Math.max(0, Math.min(faceWidthPx, faceHeightPx));
  const overall = clamp((effectiveResolution - 64) / 256, 0, 1);
  const sharpness = clamp(Math.sqrt(overall), 0, 1);

  return {
    overall,
    sharpness,
    effectiveResolution,
  };
};

const preferredHeightForQuality = (quality: {
  overall?: number;
  effectiveResolution?: number;
}) => {
  const overall = quality.overall ?? 0;
  const effectiveResolution = quality.effectiveResolution ?? 0;

  if (overall >= 0.8 && effectiveResolution >= 160) {
    return 224;
  }
  if (overall >= 0.5 && effectiveResolution >= 96) {
    return 320;
  }
  return 480;
};

const applySuggestion = (
  tag: FaceTag,
  profiles: PersonProfile[],
  nowIso: string,
): FaceTag => {
  if (tag.status === "confirmed" || tag.person || profiles.length === 0) {
    return tag;
  }

  const embedding =
    tag.featureDescription && typeof tag.featureDescription === "object"
      ? ((tag.featureDescription as { embedding?: unknown }).embedding as
          | number[]
          | undefined)
      : undefined;

  if (!Array.isArray(embedding) || embedding.length === 0) {
    return tag;
  }

  const ranked = profiles
    .map((profile) => ({
      profile,
      confidence: cosineSimilarity(embedding, profile.embedding),
    }))
    .sort((a, b) => b.confidence - a.confidence);

  const best = ranked[0];
  if (!best || best.confidence < 0.85) {
    return tag;
  }

  return {
    ...tag,
    suggestion: {
      personId: best.profile.id,
      confidence: Number(best.confidence.toFixed(4)),
      modelVersion: "placeholder-seed-v1",
      suggestedAt: nowIso,
    },
  };
};

const buildDeterministicFallbackTags = (options: {
  relativePath: string;
  regions?: Array<{
    name?: string;
    type?: string;
    area?: { x: number; y: number; width: number; height: number };
  }>;
  personInImage?: string[];
  imageDimensions?: { width?: number; height?: number };
  defaultSource: "seed-known" | "auto-detected";
}): FaceTag[] => {
  const { relativePath, regions, personInImage, imageDimensions, defaultSource } = options;
  const people = personInImage ?? [];
  const regionList = regions ?? [];
  const nowIso = new Date().toISOString();

  return regionList.flatMap((region, index) => {
    if (!region.area) {
      return [];
    }

    const regionName = region.name?.trim();
    const matchedPersonName =
      regionName && regionName.length > 0
        ? regionName
        : people.length > 0
          ? people[Math.min(index, people.length - 1)]
          : undefined;

    const faceTag = {
      faceId: `${relativePath}#seed-${index}`,
      dimensions: normalizeDimensions(region.area),
      featureDescription: undefined,
      person: matchedPersonName
        ? { id: `name:${matchedPersonName.toLowerCase()}`, name: matchedPersonName }
        : null,
      source: defaultSource,
      status: matchedPersonName ? ("confirmed" as const) : ("unverified" as const),
      detectedAt: nowIso,
      quality: buildQuality(normalizeDimensions(region.area), imageDimensions),
    } satisfies FaceTag;

    const embedding = toEmbedding(faceTag.dimensions);

    const enrichedFaceTag: FaceTag = {
      ...faceTag,
      featureDescription: {
        seed: true,
        type: region.type ?? "region",
        embedding,
      },
      thumbnail: {
        preferredHeight: preferredHeightForQuality(faceTag.quality ?? {}),
        cropVersion: "v1",
      },
    };

    return [enrichedFaceTag];
  });
};

const toFaceTagsFromEmbeddings = (options: {
  relativePath: string;
  faces: FaceEmbeddingResult[];
  regions?: Array<{
    name?: string;
    area?: { x: number; y: number; width: number; height: number };
  }>;
  personInImage?: string[];
  defaultSource: "seed-known" | "auto-detected";
}): FaceTag[] => {
  const { relativePath, faces, regions, personInImage, defaultSource } = options;
  const people = personInImage ?? [];
  const nowIso = new Date().toISOString();

  return faces.map((face, index) => {
    const matchedRegionName = regions?.[index]?.name?.trim();
    const matchedPersonName =
      matchedRegionName && matchedRegionName.length > 0
        ? matchedRegionName
        : people.length > 0
          ? people[Math.min(index, people.length - 1)]
          : undefined;

    const quality = {
      overall: face.quality.overall,
      sharpness: face.quality.sharpness,
      effectiveResolution: face.quality.effectiveResolution,
    };

    return {
      faceId: `${relativePath}#worker-${index}`,
      dimensions: face.dimensions,
      featureDescription: {
        worker: "python-opencv-hog",
        embedding: face.embedding,
      },
      person: matchedPersonName
        ? { id: `name:${matchedPersonName.toLowerCase()}`, name: matchedPersonName }
        : null,
      source: defaultSource,
      status: matchedPersonName ? ("confirmed" as const) : ("unverified" as const),
      detectedAt: nowIso,
      quality,
      thumbnail: {
        preferredHeight: preferredHeightForQuality(quality),
        cropVersion: "v1",
      },
    } satisfies FaceTag;
  });
};

const collectConfirmedProfiles = (tags: FaceTag[]): PersonProfile[] =>
  tags
    .filter((tag) => tag.status === "confirmed" && Boolean(tag.person?.id))
    .flatMap((tag) => {
      const embedding =
        tag.featureDescription && typeof tag.featureDescription === "object"
          ? ((tag.featureDescription as { embedding?: unknown }).embedding as
              | number[]
              | undefined)
          : undefined;

      if (!Array.isArray(embedding) || embedding.length === 0 || !tag.person?.id) {
        return [];
      }

      return [
        {
          id: tag.person.id,
          name: tag.person.name,
          embedding,
        },
      ];
    });

export const startBackgroundProcessFaceMetadata = (
  database: IndexDatabase,
  onComplete?: () => void,
) => {
  if (isProcessingFaceMetadata) {
    throw new Error("Face metadata processing is already running");
  }

  isProcessingFaceMetadata = true;
  faceMetadataProcessingStats = {
    processed: 0,
    workerSuccess: 0,
    fallbackCount: 0,
    workerFailures: 0,
  };
  let processedCount = 0;
  let restartAtMS = 0;
  let lastReportTime = Date.now();
  const confirmedProfiles: PersonProfile[] = [];

  const processAll = async () => {
    const totalToProcess = await database.countFilesNeedingMetadataUpdate("faceMetadata");
    while (true) {
      await waitForBackgroundTasksEnabled();

      const batch = await database.getFilesNeedingMetadataUpdate("faceMetadata", 100);
      if (batch.length === 0) {
        console.log("[metadata:face] processing complete");
        isProcessingFaceMetadata = false;
        onComplete?.();
        return;
      }

      for (const item of batch) {
        await waitForBackgroundTasksEnabled();
        try {
        await measureOperation(
          "metadata.face.processEntry",
          async () => {
            const isImage = item.mimeType?.startsWith("image/") ?? false;
            if (!isImage) {
              const nowIso = new Date().toISOString();
              await database.addOrUpdateFileData(item.relativePath, {
                faceTags: [],
                faceMetadataProcessedAt: nowIso,
              });

              processedCount++;
              faceMetadataProcessingStats.processed++;
              return;
            }

            const fileRecord = await database.getFileRecord(item.relativePath, [
              "regions",
              "personInImage",
              "dimensionWidth",
              "dimensionHeight",
            ]);
            const hasKnownTagging =
              (fileRecord?.regions?.length ?? 0) > 0 ||
              (fileRecord?.personInImage?.length ?? 0) > 0;

            const fullPath = path.join(
              database.storagePath,
              stripLeadingSlash(item.relativePath),
            );

            let extractedFaces: FaceEmbeddingResult[] = [];
            try {
              extractedFaces = await extractFaceEmbeddingsFromImage({
                imagePath: fullPath,
                regions: fileRecord?.regions
                  ?.map((region) => region.area)
                  .filter(
                    (
                      area,
                    ): area is { x: number; y: number; width: number; height: number } =>
                      Boolean(area),
                  ),
              });
              if (extractedFaces.length > 0) {
                faceMetadataProcessingStats.workerSuccess++;
              }
            } catch (error) {
              faceMetadataProcessingStats.workerFailures++;
              console.warn(
                `[metadata:face] worker extraction failed for ${item.relativePath}, falling back to deterministic embedding: ${error instanceof Error ? error.message : String(error)}`,
              );
            }

            const seededTags =
              extractedFaces.length > 0
                ? toFaceTagsFromEmbeddings({
                    relativePath: item.relativePath,
                    faces: extractedFaces,
                    regions: fileRecord?.regions,
                    personInImage: fileRecord?.personInImage,
                    defaultSource: hasKnownTagging ? "seed-known" : "auto-detected",
                  })
                : buildDeterministicFallbackTags({
                    relativePath: item.relativePath,
                    regions: fileRecord?.regions,
                    personInImage: fileRecord?.personInImage,
                    imageDimensions: {
                      width: fileRecord?.dimensionWidth,
                      height: fileRecord?.dimensionHeight,
                    },
                    defaultSource: hasKnownTagging ? "seed-known" : "auto-detected",
                  });

            if (extractedFaces.length === 0) {
              faceMetadataProcessingStats.fallbackCount++;
            }

            const nowIso = new Date().toISOString();
            const suggestedTags = seededTags.map((tag) =>
              applySuggestion(tag, confirmedProfiles, nowIso),
            );

            confirmedProfiles.push(...collectConfirmedProfiles(suggestedTags));

            await database.addOrUpdateFileData(item.relativePath, {
              faceTags: suggestedTags,
              faceMetadataProcessedAt: nowIso,
            });

            processedCount++;
            faceMetadataProcessingStats.processed++;
          },
          { category: "other", detail: item.relativePath, logWithoutRequest: true },
        );
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          console.error(`[metadata:face] failed to process ${item.relativePath}: ${msg}`);
          await database.addOrUpdateFileData(item.relativePath, {
            faceTags: [],
            faceMetadataProcessedAt: new Date().toISOString(),
          });
        }

        const now = Date.now();
        if (now - lastReportTime > 1000) {
          const percentComplete =
            totalToProcess > 0
              ? ((processedCount / totalToProcess) * 100).toFixed(2)
              : "100.00";
          console.log(
            `[metadata:face] ${percentComplete}% complete. Last processed: ${item.relativePath}`,
          );
          lastReportTime = now;
        }

        while (restartAtMS && restartAtMS > Date.now()) {
          console.log("[metadata:face] paused processing...");
          const timeoutDuration = restartAtMS - Date.now();
          await new Promise((resolve) => setTimeout(resolve, timeoutDuration));
        }
      }
    }
  };

  void processAll();

  const pause = (durationMS: number = 10_000) => {
    const localRestartMs = Date.now() + durationMS;
    restartAtMS = Math.max(restartAtMS, localRestartMs);
  };

  return pause;
};
