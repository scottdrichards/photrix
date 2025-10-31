# AI Tagging

This module provides AI-powered image tagging using TensorFlow.js and the MobileNet model.

## Features

- Automatic object detection and tagging for images
- Low-resource requirements (works with ~4GB RAM, no GPU required)
- Graceful degradation if model loading fails
- Tags are combined with EXIF metadata tags

## How It Works

The AI tagger uses MobileNet v1 (alpha=0.25), a lightweight convolutional neural network designed for mobile and embedded vision applications. When an image is indexed:

1. The image is resized to 224x224 pixels
2. MobileNet classifies the image content
3. Top predictions above a confidence threshold are extracted as tags
4. Tags are normalized (lowercase, simplified names)
5. AI tags are combined with any existing EXIF tags

## Configuration

The tagger can be configured via function parameters:

```typescript
generateAITags(imagePath, (topK = 5), (minConfidence = 0.1));
```

- `topK`: Maximum number of tags to generate (default: 5)
- `minConfidence`: Minimum confidence threshold (default: 0.1, range: 0-1)

## Dependencies

- `@tensorflow/tfjs`: TensorFlow.js core library
- `@tensorflow-models/mobilenet`: Pre-trained MobileNet model
- `sharp`: Image processing (already in use)

## Network Requirements

The MobileNet model is downloaded from the internet on first use. If internet access is unavailable or restricted:

- The module will log a warning
- AI tagging will be disabled for the session
- Regular EXIF tagging will continue to work
- No errors will be thrown

## Memory Usage

With the smallest MobileNet configuration (v1, alpha=0.25):

- Model size: ~4MB
- Runtime memory: ~50-100MB
- Per-image processing: ~10-20MB (released after processing)

## Examples

Common tags the model can detect:

- Objects: beach, car, computer, phone, book
- Animals: cat, dog, bird, fish
- Nature: tree, flower, mountain, ocean
- Food: pizza, banana, coffee
- Scenery: sunset, building, street
