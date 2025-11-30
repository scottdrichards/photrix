import sys
import argparse
import json
from PIL import Image, ImageOps
from pillow_heif import register_heif_opener
import os

# Register HEIF opener to support .heic files
register_heif_opener()

def process_image(input_path, outputs):
    try:
        if not os.path.exists(input_path):
            print(f"Error: Input file not found: {input_path}", file=sys.stderr)
            sys.exit(1)

        with Image.open(input_path) as img:
            # Apply EXIF rotation
            img = ImageOps.exif_transpose(img)

            # Convert to RGB (remove alpha channel if present, needed for JPEG)
            if img.mode in ('RGBA', 'LA') or (img.mode == 'P' and 'transparency' in img.info):
                img = img.convert('RGB')
            
            original_width, original_height = img.size

            for output in outputs:
                output_path = output['path']
                max_dimension = output.get('height') # Using 'height' as max dimension for consistency with TS

                # Resize if max_dimension is provided and smaller than original
                # (Or if we want to force resize, but usually we downscale)
                current_img = img
                if max_dimension:
                    if original_width > max_dimension or original_height > max_dimension:
                        ratio = min(max_dimension / original_width, max_dimension / original_height)
                        new_size = (int(original_width * ratio), int(original_height * ratio))
                        current_img = img.resize(new_size, Image.Resampling.LANCZOS)
                
                # Save as JPEG
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
