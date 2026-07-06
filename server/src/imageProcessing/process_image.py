import sys
import argparse
import json
from PIL import Image, ImageOps
from pillow_heif import register_heif_opener
import os

# Register HEIF opener to support .heic files
register_heif_opener()

RAW_EXTENSIONS = {'.cr3', '.cr2', '.nef', '.arw', '.orf', '.raf', '.srw', '.rw2', '.dng', '.raw'}

def open_image(input_path):
    ext = os.path.splitext(input_path)[1].lower()
    if ext in RAW_EXTENSIONS:
        import rawpy
        import numpy as np
        with rawpy.imread(input_path) as raw:
            rgb = raw.postprocess(use_camera_wb=True, output_bps=8)
        return Image.fromarray(rgb)
    return Image.open(input_path)

def process_image(input_path, outputs):
    try:
        if not os.path.exists(input_path):
            print(f"Error: Input file not found: {input_path}", file=sys.stderr)
            sys.exit(1)

        img = open_image(input_path)
        with img:
            # Apply EXIF rotation
            img = ImageOps.exif_transpose(img)

            # Convert to RGB (remove alpha channel if present, needed for JPEG)
            if img.mode in ('RGBA', 'LA') or (img.mode == 'P' and 'transparency' in img.info):
                img = img.convert('RGB')

            original_width, original_height = img.size

            for output in outputs:
                output_path = output['path']
                max_dimension = output.get('height') # Using 'height' as max dimension for consistency with TS
                # Optional crop as normalized top-left fractions [x, y, w, h] of the
                # EXIF-oriented image. Applied before resize so the max_dimension
                # governs the cropped region, yielding a sharper, smaller output.
                crop = output.get('crop')

                current_img = img
                if crop:
                    cx, cy, cw, ch = crop
                    left = int(round(cx * original_width))
                    top = int(round(cy * original_height))
                    right = int(round((cx + cw) * original_width))
                    bottom = int(round((cy + ch) * original_height))
                    # Clamp to image bounds and guarantee at least a 1px box.
                    left = max(0, min(left, original_width - 1))
                    top = max(0, min(top, original_height - 1))
                    right = max(left + 1, min(right, original_width))
                    bottom = max(top + 1, min(bottom, original_height))
                    current_img = img.crop((left, top, right, bottom))

                crop_width, crop_height = current_img.size

                # Resize if max_dimension is provided and smaller than the (possibly
                # cropped) source. We only ever downscale, never upscale.
                if max_dimension:
                    if crop_width > max_dimension or crop_height > max_dimension:
                        ratio = min(max_dimension / crop_width, max_dimension / crop_height)
                        new_size = (int(crop_width * ratio), int(crop_height * ratio))
                        current_img = current_img.resize(new_size, Image.Resampling.LANCZOS)

                # Pick the encoder from the output extension. WebP is the
                # default (smaller than JPEG at matching quality); JPEG is kept
                # as a fallback for any caller still asking for a .jpg path.
                out_ext = os.path.splitext(output_path)[1].lower()
                if out_ext == ".webp":
                    current_img.save(output_path, "WEBP", quality=80, method=4)
                else:
                    current_img.save(output_path, "JPEG", quality=85)
                print(f"Successfully processed: {output_path}")

    except Exception as e:
        print(f"Error processing image: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Convert and resize images.")
    parser.add_argument("input_path", help="Path to the input image")
    parser.add_argument("--outputs", help="JSON string of outputs: [{'path': '...', 'height': 320}, ...]")
    # Keep backward compatibility for single file mode if needed, or just migrate everything
    parser.add_argument("output_path", nargs='?', help="Legacy: Path to save the output image")
    parser.add_argument("--max_dimension", type=int, help="Legacy: Maximum width or height")

    args = parser.parse_args()

    if args.outputs:
        outputs = json.loads(args.outputs)
        process_image(args.input_path, outputs)
    elif args.output_path:
        process_image(args.input_path, [{'path': args.output_path, 'height': args.max_dimension}])
    else:
        print("Error: Must provide either --outputs or output_path", file=sys.stderr)
        sys.exit(1)
