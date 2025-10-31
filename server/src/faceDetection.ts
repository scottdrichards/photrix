import { createHash } from "crypto";
import sharp from "sharp";

/**
 * Face detection result representing a detected face in an image.
 * 
 * IMPORTANT: This is a PLACEHOLDER implementation using image hashing for consistent
 * face "detection" for testing and demonstration purposes. 
 * 
 * For PRODUCTION use, integrate with a real local face detection library such as:
 * - OpenCV with Haar Cascades (opencv4nodejs) - traditional computer vision
 * - TensorFlow.js with BlazeFace/FaceMesh - modern ML models
 * - mediapipe - Google's ML solution with face detection
 * - dlib face recognition - C++ library with Node.js bindings
 * 
 * All of these can run LOCALLY without external API calls.
 */
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
  embedding?: number[]; // Simple geometric embedding for clustering
};

/**
 * Placeholder face detection using image content hashing.
 * 
 * This implementation analyzes the image content and uses hashing to generate
 * consistent "face" detections for testing purposes. It does NOT perform actual
 * face detection.
 * 
 * To use real face detection:
 * 1. Install a face detection library (see options in type comments above)
 * 2. Replace this function with actual face detection logic
 * 3. The rest of the codebase will work without changes
 */
export const detectFaces = async (
  imagePath: string
): Promise<FaceDetectionResult[]> => {
  try {
    // Load image to get dimensions and content
    const image = sharp(imagePath);
    const metadata = await image.metadata();

    if (!metadata.width || !metadata.height) {
      return [];
    }

    // Get image statistics for content-based hashing
    const stats = await image.stats();
    
    // Create a hash based on image content (not just path)
    const buffer = await image.toBuffer();
    const contentHash = createHash("md5").update(buffer).digest("hex");
    const seed = parseInt(contentHash.substring(0, 8), 16);
    
    // Pseudo-random number generator with seed (deterministic for same image)
    const seededRandom = (index: number): number => {
      const x = Math.sin(seed + index) * 10000;
      return x - Math.floor(x);
    };

    // Use image statistics to influence detection
    const avgBrightness = (stats.channels[0].mean + stats.channels[1].mean + stats.channels[2].mean) / 3;
    const normalizedBrightness = avgBrightness / 255;
    
    // Generate 0-3 face detections based on image content
    // Brighter images tend to have more faces detected (simulates better lighting)
    const baseFaceCount = Math.floor(seededRandom(0) * 4);
    const faceCount = normalizedBrightness > 0.4 ? baseFaceCount : Math.max(0, baseFaceCount - 1);
    
    const faces: FaceDetectionResult[] = [];

    for (let i = 0; i < faceCount; i++) {
      const x = seededRandom(i * 4 + 1);
      const y = seededRandom(i * 4 + 2);
      const size = 0.1 + seededRandom(i * 4 + 3) * 0.2; // 10-30% of image

      const bbox = {
        originX: Math.floor(x * metadata.width * 0.7),
        originY: Math.floor(y * metadata.height * 0.7),
        width: Math.floor(size * metadata.width),
        height: Math.floor(size * metadata.height),
      };

      // Generate embedding based on position and image statistics
      const embedding = generateEmbedding(bbox, metadata.width, metadata.height, stats, i);

      faces.push({
        boundingBox: bbox,
        score: 0.85 + seededRandom(i * 4 + 4) * 0.1,
        embedding,
      });
    }

    return faces;
  } catch (error) {
    console.error(`[faceDetection] Failed to detect faces in ${imagePath}:`, error);
    return [];
  }
};

/**
 * Generate a simple embedding for face clustering based on position and image features.
 */
const generateEmbedding = (
  bbox: { originX: number; originY: number; width: number; height: number },
  imgWidth: number,
  imgHeight: number,
  stats: sharp.Stats,
  faceIndex: number
): number[] => {
  const features: number[] = [];

  // Normalized position features
  features.push(bbox.originX / imgWidth);
  features.push(bbox.originY / imgHeight);
  features.push(bbox.width / imgWidth);
  features.push(bbox.height / imgHeight);
  features.push(bbox.width / bbox.height); // Aspect ratio

  // Image color features (averaged across channels)
  for (const channel of stats.channels) {
    features.push(channel.mean / 255);
    features.push(channel.stdev / 255);
  }

  // Face index as a feature (helps distinguish multiple faces in same image)
  features.push(faceIndex / 10);

  // Pad to fixed length
  while (features.length < 16) {
    features.push(0);
  }

  return features.slice(0, 16);
};

/**
 * Computes face embedding/descriptor for face clustering and recognition.
 * Uses the actual face embeddings from the Human library if available,
 * otherwise falls back to geometric features.
 */
export const computeFaceEmbedding = (
  face: FaceDetectionResult,
  imageDimensions: { width: number; height: number }
): number[] => {
  // If we have a real embedding from the face recognition model, use it
  if (face.embedding && face.embedding.length > 0) {
    return face.embedding;
  }

  // Fallback: use geometric features if no embedding available
  const features: number[] = [];

  // Normalize bounding box by image dimensions
  features.push(face.boundingBox.originX / imageDimensions.width);
  features.push(face.boundingBox.originY / imageDimensions.height);
  features.push(face.boundingBox.width / imageDimensions.width);
  features.push(face.boundingBox.height / imageDimensions.height);

  // Add aspect ratio (guard against division by zero)
  if (face.boundingBox.height > 0) {
    features.push(face.boundingBox.width / face.boundingBox.height);
  } else {
    features.push(0);
  }

  // Add detection score
  features.push(face.score);

  // Pad to fixed length
  while (features.length < 16) {
    features.push(0);
  }

  return features.slice(0, 16);
};

/**
 * Clusters faces using cosine similarity on face embeddings.
 * Uses a similarity threshold to group faces of the same person.
 */
export const clusterFaces = (
  faces: Array<{ embedding: number[]; faceId: string; imagePath: string }>,
  threshold = 0.6 // Cosine similarity threshold (higher = more similar)
): Map<string, Array<{ faceId: string; imagePath: string }>> => {
  const clusters = new Map<string, Array<{ faceId: string; imagePath: string }>>();
  const assigned = new Set<string>();

  for (let i = 0; i < faces.length; i++) {
    if (assigned.has(faces[i].faceId)) {
      continue;
    }

    const clusterId = `person_${clusters.size}`;
    const cluster: Array<{ faceId: string; imagePath: string }> = [
      { faceId: faces[i].faceId, imagePath: faces[i].imagePath }
    ];
    assigned.add(faces[i].faceId);

    // Find similar faces
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

// Calculate cosine similarity between two vectors (better for face embeddings than Euclidean distance)
const cosineSimilarity = (a: number[], b: number[]): number => {
  if (a.length !== b.length) {
    // If lengths don't match, fall back to Euclidean distance normalized
    return 1 - euclideanDistance(a, b) / Math.sqrt(a.length);
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  if (magnitude === 0) {
    return 0;
  }

  return dotProduct / magnitude;
};

const euclideanDistance = (a: number[], b: number[]): number => {
  let sum = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
};
