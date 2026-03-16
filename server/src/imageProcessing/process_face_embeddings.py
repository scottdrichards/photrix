import argparse
import json
import os
import sys

import cv2
import numpy as np
from PIL import Image, ImageOps
from pillow_heif import register_heif_opener

try:
    import face_recognition

    HAS_FACE_RECOGNITION = True
except Exception:
    face_recognition = None
    HAS_FACE_RECOGNITION = False

register_heif_opener()


def clamp(value, min_value, max_value):
    return max(min_value, min(max_value, value))


def normalize_region(region):
    return {
        "x": float(clamp(region.get("x", 0.0), 0.0, 1.0)),
        "y": float(clamp(region.get("y", 0.0), 0.0, 1.0)),
        "width": float(clamp(region.get("width", 0.0), 0.0, 1.0)),
        "height": float(clamp(region.get("height", 0.0), 0.0, 1.0)),
    }


def detect_regions(rgb_image, gray_image):
    if HAS_FACE_RECOGNITION:
        locations = face_recognition.face_locations(rgb_image, model="hog")
        height, width = gray_image.shape[:2]
        regions = []
        for (top, right, bottom, left) in locations:
            x = float(clamp(left / width, 0.0, 1.0))
            y = float(clamp(top / height, 0.0, 1.0))
            w = float(clamp((right - left) / width, 0.0, 1.0))
            h = float(clamp((bottom - top) / height, 0.0, 1.0))
            if w > 0 and h > 0:
                regions.append({"x": x, "y": y, "width": w, "height": h})
        if len(regions) > 0:
            return regions

    detector = cv2.CascadeClassifier(
        cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
    )
    faces = detector.detectMultiScale(
        gray_image,
        scaleFactor=1.1,
        minNeighbors=5,
        minSize=(30, 30),
    )

    height, width = gray_image.shape[:2]
    regions = []
    for (x, y, w, h) in faces:
        regions.append(
            {
                "x": float(x / width),
                "y": float(y / height),
                "width": float(w / width),
                "height": float(h / height),
            }
        )
    return regions


def compress_vector(vector, output_size=128):
    if len(vector) == 0:
        return [0.0] * output_size

    buckets = np.array_split(vector, output_size)
    return [float(np.mean(bucket)) if len(bucket) > 0 else 0.0 for bucket in buckets]


def _hog_embedding_for_region(gray_image, region):
    height, width = gray_image.shape[:2]

    x = int(region["x"] * width)
    y = int(region["y"] * height)
    w = max(1, int(region["width"] * width))
    h = max(1, int(region["height"] * height))

    x = int(clamp(x, 0, max(0, width - 1)))
    y = int(clamp(y, 0, max(0, height - 1)))
    x2 = int(clamp(x + w, x + 1, width))
    y2 = int(clamp(y + h, y + 1, height))

    face = gray_image[y:y2, x:x2]
    if face.size == 0:
        return {
            "embedding": [0.0] * 128,
            "quality": {
                "overall": 0.0,
                "sharpness": 0.0,
                "effectiveResolution": 0.0,
            },
        }

    resized = cv2.resize(face, (64, 64), interpolation=cv2.INTER_AREA)

    hog = cv2.HOGDescriptor(
        _winSize=(64, 64),
        _blockSize=(16, 16),
        _blockStride=(8, 8),
        _cellSize=(8, 8),
        _nbins=9,
    )
    descriptor = hog.compute(resized)
    descriptor_vector = descriptor.flatten() if descriptor is not None else np.zeros(128)
    embedding = compress_vector(descriptor_vector, 128)

    sharpness = float(cv2.Laplacian(resized, cv2.CV_64F).var())
    effective_resolution = float(min(face.shape[0], face.shape[1]))
    overall = float(clamp((effective_resolution - 64.0) / 256.0, 0.0, 1.0))

    return {
        "embedding": embedding,
        "quality": {
            "overall": overall,
            "sharpness": float(clamp(np.sqrt(max(overall, 0.0)), 0.0, 1.0))
            if sharpness > 0
            else 0.0,
            "effectiveResolution": effective_resolution,
        },
    }


def embedding_for_region(rgb_image, gray_image, region):
    height, width = gray_image.shape[:2]

    x = int(region["x"] * width)
    y = int(region["y"] * height)
    w = max(1, int(region["width"] * width))
    h = max(1, int(region["height"] * height))

    x = int(clamp(x, 0, max(0, width - 1)))
    y = int(clamp(y, 0, max(0, height - 1)))
    x2 = int(clamp(x + w, x + 1, width))
    y2 = int(clamp(y + h, y + 1, height))

    face = gray_image[y:y2, x:x2]
    sharpness = (
        float(cv2.Laplacian(cv2.resize(face, (64, 64), interpolation=cv2.INTER_AREA), cv2.CV_64F).var())
        if face.size > 0
        else 0.0
    )
    effective_resolution = float(min(max(1, y2 - y), max(1, x2 - x)))

    if HAS_FACE_RECOGNITION:
        try:
            location = [(y, x2, y2, x)]
            encodings = face_recognition.face_encodings(
                rgb_image,
                known_face_locations=location,
                num_jitters=1,
                model="small",
            )
            if len(encodings) > 0:
                embedding = encodings[0].astype(np.float32).tolist()
                sharpness_score = float(clamp(sharpness / 120.0, 0.0, 1.0))
                resolution_score = float(clamp((effective_resolution - 48.0) / 192.0, 0.0, 1.0))
                overall = float(clamp(0.65 * resolution_score + 0.35 * sharpness_score, 0.0, 1.0))
                return {
                    "embedding": embedding,
                    "quality": {
                        "overall": overall,
                        "sharpness": sharpness_score,
                        "effectiveResolution": effective_resolution,
                    },
                }
        except Exception:
            pass

    return _hog_embedding_for_region(gray_image, region)


def main():
    parser = argparse.ArgumentParser(description="Extract face embeddings from an image")
    parser.add_argument("--input", required=True, help="Path to image")
    parser.add_argument(
        "--regions",
        required=False,
        help="JSON array of normalized regions [{x,y,width,height}]",
    )
    args = parser.parse_args()

    if not os.path.exists(args.input):
        print(json.dumps({"faces": []}))
        return

    with Image.open(args.input) as image:
        image = ImageOps.exif_transpose(image)
        rgb = np.array(image.convert("RGB"))

    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)

    if args.regions:
        try:
            parsed_regions = json.loads(args.regions)
            regions = [normalize_region(region) for region in parsed_regions]
        except Exception:
            regions = []
    else:
        regions = detect_regions(rgb, gray)

    faces = []
    for region in regions:
        computed = embedding_for_region(rgb, gray, region)
        faces.append(
            {
                "dimensions": region,
                "embedding": computed["embedding"],
                "quality": computed["quality"],
            }
        )

    print(json.dumps({"faces": faces}))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print(json.dumps({"faces": []}))
        sys.exit(0)
