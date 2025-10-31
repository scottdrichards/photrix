import * as tf from "@tensorflow/tfjs";
import * as mobilenet from "@tensorflow-models/mobilenet";
import sharp from "sharp";

type MobileNetModel = Awaited<ReturnType<typeof mobilenet.load>>;

let modelInstance: MobileNetModel | null = null;
let modelLoadPromise: Promise<MobileNetModel> | null = null;
let modelLoadFailed = false;

const ensureBackend = async (): Promise<void> => {
  // Ensure TensorFlow.js is using the CPU backend
  await tf.ready();
  const backend = tf.getBackend();
  if (backend !== "cpu") {
    await tf.setBackend("cpu");
  }
};

const loadModel = async (): Promise<MobileNetModel> => {
  if (modelInstance) {
    return modelInstance;
  }

  if (modelLoadFailed) {
    throw new Error("Model loading previously failed");
  }

  if (modelLoadPromise) {
    return modelLoadPromise;
  }

  modelLoadPromise = (async () => {
    try {
      console.log("[ai-tagger] Loading MobileNet model...");
      await ensureBackend();
      const model = await mobilenet.load({
        version: 1, // Use version 1 (smaller, faster)
        alpha: 0.25, // Smallest alpha for lowest memory/computation
      });
      modelInstance = model;
      console.log("[ai-tagger] MobileNet model loaded successfully");
      return model;
    } catch (error) {
      modelLoadPromise = null;
      modelLoadFailed = true;
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.warn(
        `[ai-tagger] Failed to load model, AI tagging will be disabled: ${errorMessage}`,
      );
      throw error;
    }
  })();

  return modelLoadPromise;
};

const preprocessImage = async (imagePath: string): Promise<tf.Tensor3D> => {
  // Read and resize image using Sharp
  const imageBuffer = await sharp(imagePath)
    .resize(224, 224, { fit: "cover" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Convert to tensor and normalize to [0, 1] range
  const tensor = tf.tensor3d(new Uint8Array(imageBuffer.data), [
    imageBuffer.info.height,
    imageBuffer.info.width,
    imageBuffer.info.channels,
  ]);

  // MobileNet expects pixel values in [0, 1] range
  const normalized = tensor.div(255.0);
  tensor.dispose(); // Clean up the unnormalized tensor

  return normalized as tf.Tensor3D;
};

export const generateAITags = async (
  imagePath: string,
  topK = 5,
  minConfidence = 0.1,
): Promise<string[]> => {
  // If model loading previously failed, skip AI tagging silently
  if (modelLoadFailed) {
    return [];
  }

  try {
    const model = await loadModel();
    const imageTensor = await preprocessImage(imagePath);

    // Get predictions
    const predictions = await model.classify(imageTensor);

    // Clean up tensor to free memory
    imageTensor.dispose();

    // Filter and extract tags
    const tags = predictions
      .filter((prediction) => prediction.probability >= minConfidence)
      .slice(0, topK)
      .map((prediction) => {
        // Clean up the class name to make it more user-friendly
        // MobileNet returns labels like "Egyptian cat" or "tiger, Panthera tigris"
        const className = prediction.className;
        // Take the first part before comma if it exists
        const firstPart = className.split(",")[0].trim();
        // Convert to lowercase for consistency
        return firstPart.toLowerCase();
      });

    return tags;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    // Only log if it's not a model load failure (already logged)
    if (!modelLoadFailed) {
      console.warn(
        `[ai-tagger] Failed to generate AI tags for ${imagePath}: ${errorMessage}`,
      );
    }
    return [];
  }
};

export const unloadModel = (): void => {
  if (modelInstance) {
    modelInstance = null;
    modelLoadPromise = null;
    console.log("[ai-tagger] Model unloaded");
  }
};
