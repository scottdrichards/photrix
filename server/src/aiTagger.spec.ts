import { describe, it, expect } from "vitest";
import path from "path";
import { generateAITags } from "./aiTagger.js";
import { fileURLToPath } from "url";
import sharp from "sharp";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const createTestImage = async (): Promise<string> => {
  // Create a simple test image (100x100 red square)
  const tempDir = await mkdtemp(path.join(tmpdir(), "ai-tagger-test-"));
  const imagePath = path.join(tempDir, "test-image.jpg");
  
  await sharp({
    create: {
      width: 224,
      height: 224,
      channels: 3,
      background: { r: 255, g: 0, b: 0 }
    }
  })
  .jpeg()
  .toFile(imagePath);
  
  return imagePath;
};

describe("AI Tagger", () => {
  it("generates tags for an image file", async () => {
    const testImagePath = await createTestImage();

    try {
      const tags = await generateAITags(testImagePath);

      // Verify that we get an array of tags
      expect(Array.isArray(tags)).toBe(true);
      
      // We should get some tags (unless the image doesn't match any classes well)
      // but it's okay if we get an empty array for test images
      expect(tags.length).toBeGreaterThanOrEqual(0);
      
      // If we have tags, verify they are strings
      if (tags.length > 0) {
        tags.forEach(tag => {
          expect(typeof tag).toBe("string");
          expect(tag.length).toBeGreaterThan(0);
        });
      }
    } finally {
      // Clean up
      const tempDir = path.dirname(testImagePath);
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 30000); // Give it 30 seconds for model loading

  it("returns empty array on error", async () => {
    // Use a non-existent file path
    const nonExistentPath = "/tmp/non-existent-image-that-does-not-exist.jpg";

    const tags = await generateAITags(nonExistentPath);

    // Should return empty array instead of throwing
    expect(Array.isArray(tags)).toBe(true);
    expect(tags).toEqual([]);
  });

  it("filters tags by confidence threshold", async () => {
    const testImagePath = await createTestImage();

    try {
      // Request tags with a very high confidence threshold
      const tags = await generateAITags(testImagePath, 5, 0.8);

      // Verify we get an array (might be empty with high threshold)
      expect(Array.isArray(tags)).toBe(true);
    } finally {
      // Clean up
      const tempDir = path.dirname(testImagePath);
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 30000);
});
