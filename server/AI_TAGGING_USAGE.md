# AI Tagging Usage Guide

## Quick Start

AI tagging is automatically enabled when you index photos. No configuration is required!

```bash
cd server
npm install
npm start
```

When the indexer processes images, it will:
1. Extract EXIF metadata (camera info, location, existing tags)
2. Run AI object detection to identify objects in the image
3. Combine both tag sources into the metadata

## What Gets Tagged?

The MobileNet model can detect 1000+ common objects including:

**Nature & Outdoors:**
- beach, ocean, mountain, tree, flower, grass, sky, sunset, cloud

**Animals:**
- cat, dog, bird, fish, horse, cow, elephant, lion

**Vehicles:**
- car, truck, bus, motorcycle, bicycle, airplane, boat

**Indoor Objects:**
- furniture, chair, table, bed, lamp, book, computer, phone

**Food:**
- pizza, banana, apple, coffee, bread, cake

**Clothing:**
- dress, shirt, pants, shoe, hat, sunglasses

**And many more...**

## Querying Tagged Images

You can search for images by AI-generated tags using the existing tag filtering:

```typescript
// Find all beach photos
const results = await indexer.queryFiles({
  tags: ["beach"],
});

// Find photos with multiple tags
const results = await indexer.queryFiles({
  tags: ["beach", "sunset"],
  tagsMatchAll: true, // Requires both tags
});
```

## Performance Considerations

- **First Run:** The model downloads (~4MB) on first use, which may take a few seconds
- **Processing:** Each image takes ~100-200ms to analyze on CPU
- **Memory:** Adds ~50-100MB RAM usage during indexing
- **No GPU Required:** Works on any system with 4GB+ RAM

## Network Requirements

The AI model needs to download from the internet on first use. If you're behind a firewall or offline:

- The system will log a warning but continue working
- EXIF tags will still be extracted normally
- AI tagging will be skipped for that session

## Customization

To adjust the confidence threshold or number of tags, modify `src/aiTagger.ts`:

```typescript
// Default: 5 tags with 10% confidence
const tags = await generateAITags(imagePath, 5, 0.1);

// More selective: 3 tags with 30% confidence
const tags = await generateAITags(imagePath, 3, 0.3);
```

To use a more accurate (but larger) model, modify the `alpha` parameter in `aiTagger.ts`:

```typescript
const model = await mobilenet.load({
  version: 1,
  alpha: 0.5, // Change from 0.25 to 0.5 (2x larger, more accurate)
});
```

## Troubleshooting

**Model fails to load:**
- Check internet connectivity
- Verify firewall allows access to storage.googleapis.com
- The system will continue without AI tagging

**Low-quality tags:**
- Try lowering minConfidence (e.g., from 0.1 to 0.05)
- Consider using a larger alpha value for better accuracy

**High memory usage:**
- The model is loaded once and reused
- Memory is released after processing each image
- Consider processing images in smaller batches

## Example Output

For a photo of a beach scene, the tagger might generate:

```json
{
  "tags": [
    "beach",
    "seashore",
    "coast",
    "ocean",
    "sand"
  ]
}
```

These tags are automatically combined with any EXIF tags already in the image metadata.
