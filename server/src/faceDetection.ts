import { readFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Config, FaceResult, Human as HumanInstance } from "@vladmandic/human";
import sharp from "sharp";

export type FaceDetectionResult = {
  boundingBox: {
    originX: number;
    originY: number;
    width: number;
    height: number;
  };
  keypoints?: Array<{
    x: number;
    y: number;
    label?: string;
  }>;
  score: number;
  embedding?: number[];
};

type HumanConstructor = new (config?: Partial<Config>) => HumanInstance;

type HumanModule = {
  Human?: HumanConstructor;
  default?: HumanConstructor;
};

const require = createRequire(import.meta.url);
const humanEntryPath = require.resolve("@vladmandic/human");
const humanDistPath = path.dirname(humanEntryPath);
const humanRootPath = path.dirname(humanDistPath);
const humanWasmModuleUrl = pathToFileURL(
  path.join(humanDistPath, "human.node-wasm.js"),
).href;
const modelBasePath = pathToFileURL(path.join(humanRootPath, "models") + path.sep).href;
const wasmPath = pathToFileURL(
  path.dirname(
    require.resolve("@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm.wasm"),
  ) + path.sep,
).href;

let humanPromise: Promise<HumanInstance> | undefined;
let fileFetchInstalled = false;

const humanConfig: Partial<Config> = {
  backend: "wasm",
  debug: false,
  async: false,
  warmup: "none",
  modelBasePath,
  wasmPath,
  body: { enabled: false },
  hand: { enabled: false },
  object: { enabled: false },
  gesture: { enabled: false },
  face: {
    enabled: true,
    detector: {
      enabled: true,
      rotation: false,
      maxDetected: 20,
      minConfidence: 0.5,
    },
    mesh: { enabled: true },
    description: {
      enabled: true,
      minConfidence: 0.5,
    },
    iris: { enabled: false },
    emotion: { enabled: false },
    antispoof: { enabled: false },
    liveness: { enabled: false },
  },
};

export const detectFaces = async (imagePath: string): Promise<FaceDetectionResult[]> => {
  try {
    const human = await getHuman();
    const { data, info } = await sharp(imagePath)
      .rotate()
      .removeAlpha()
      .toColorspace("srgb")
      .raw()
      .toBuffer({ resolveWithObject: true });

    if (info.width <= 0 || info.height <= 0 || info.channels !== 3) {
      return [];
    }

    const tensor = human.tf.tensor3d(data, [info.height, info.width, 3]);

    try {
      const result = await human.detect(tensor);
      return result.face.map((face: FaceResult) =>
        toFaceDetectionResult(face, info.width, info.height),
      );
    } finally {
      human.tf.dispose(tensor);
    }
  } catch (error) {
    console.error(`[faceDetection] Failed to detect faces in ${imagePath}:`, error);
    return [];
  }
};

export const computeFaceEmbedding = (face: FaceDetectionResult): number[] | undefined =>
  face.embedding;

export const clusterFaces = (
  faces: Array<{ embedding: number[]; faceId: string; imagePath: string }>,
  threshold = 0.8,
): Map<string, Array<{ faceId: string; imagePath: string }>> => {
  const clusters = new Map<string, Array<{ faceId: string; imagePath: string }>>();
  const assigned = new Set<string>();

  for (let i = 0; i < faces.length; i++) {
    if (assigned.has(faces[i].faceId)) {
      continue;
    }

    const clusterId = `person_${clusters.size}`;
    const cluster: Array<{ faceId: string; imagePath: string }> = [
      { faceId: faces[i].faceId, imagePath: faces[i].imagePath },
    ];
    assigned.add(faces[i].faceId);

    for (let j = i + 1; j < faces.length; j++) {
      if (assigned.has(faces[j].faceId)) {
        continue;
      }

      const similarity = cosineSimilarity(faces[i].embedding, faces[j].embedding);
      if (similarity >= threshold) {
        cluster.push({ faceId: faces[j].faceId, imagePath: faces[j].imagePath });
        assigned.add(faces[j].faceId);
      }
    }

    clusters.set(clusterId, cluster);
  }

  return clusters;
};

const getHuman = async (): Promise<HumanInstance> => {
  humanPromise ??= loadHuman();
  return humanPromise;
};

const loadHuman = async (): Promise<HumanInstance> => {
  installFileFetch();

  const humanModule = (await import(humanWasmModuleUrl)) as HumanModule;
  const HumanConstructor = humanModule.Human ?? humanModule.default;

  if (!HumanConstructor) {
    throw new Error("Unable to load local Human face detection runtime");
  }

  const human = new HumanConstructor(humanConfig);
  await human.tf.ready();
  await human.load();
  return human;
};

const installFileFetch = (): void => {
  if (fileFetchInstalled) {
    return;
  }

  fileFetchInstalled = true;

  const nativeFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    const url = getFetchUrl(input);

    if (url.startsWith("file://")) {
      const data = await readFile(fileURLToPath(url));
      return new Response(data as unknown as BodyInit, {
        status: 200,
        headers: { "Content-Type": "application/octet-stream" },
      });
    }

    return nativeFetch(input, init);
  };
};

const getFetchUrl = (input: Parameters<typeof fetch>[0]): string => {
  if (typeof input === "string") {
    return input;
  }

  if (input instanceof URL) {
    return input.href;
  }

  return input.url;
};

const toFaceDetectionResult = (
  face: FaceResult,
  imageWidth: number,
  imageHeight: number,
): FaceDetectionResult => ({
  boundingBox: toBoundingBox(face.box, imageWidth, imageHeight),
  keypoints: toKeypoints(face),
  score: face.score,
  embedding: face.embedding,
});

const toBoundingBox = (
  [x, y, width, height]: [number, number, number, number],
  imageWidth: number,
  imageHeight: number,
): FaceDetectionResult["boundingBox"] => {
  const originX = clamp(Math.round(x), 0, imageWidth);
  const originY = clamp(Math.round(y), 0, imageHeight);
  const maxWidth = imageWidth - originX;
  const maxHeight = imageHeight - originY;

  return {
    originX,
    originY,
    width: clamp(Math.round(width), 0, maxWidth),
    height: clamp(Math.round(height), 0, maxHeight),
  };
};

const toKeypoints = (face: FaceResult): FaceDetectionResult["keypoints"] => {
  const labels = ["leftEye", "rightEye", "nose", "mouth"] as const;

  return labels.flatMap((label) => {
    const point = face.annotations[label]?.[0];

    if (!point) {
      return [];
    }

    return [{ x: point[0], y: point[1], label }];
  });
};

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

const cosineSimilarity = (a: number[], b: number[]): number => {
  if (a.length !== b.length) {
    return 0;
  }

  const { dotProduct, normA, normB } = a.reduce(
    (acc, value, index) => ({
      dotProduct: acc.dotProduct + value * b[index],
      normA: acc.normA + value * value,
      normB: acc.normB + b[index] * b[index],
    }),
    { dotProduct: 0, normA: 0, normB: 0 },
  );

  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  if (magnitude === 0) {
    return 0;
  }

  return dotProduct / magnitude;
};
