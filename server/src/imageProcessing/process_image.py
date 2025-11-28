import sys
import argparse
from PIL import Image
from pillow_heif import register_heif_opener
import os

# Register HEIF opener to support .heic files
register_heif_opener()

def process_image(input_path, output_path, max_dimension=None):
    try:
        if not os.path.exists(input_path):
            print(f"Error: Input file not found: {input_path}", file=sys.stderr)
            sys.exit(1)

        with Image.open(input_path) as img:
            # Convert to RGB (remove alpha channel if present, needed for JPEG)
            if img.mode in ('RGBA', 'LA') or (img.mode == 'P' and 'transparency' in img.info):
                img = img.convert('RGB')
            
            # Resize if max_dimension is provided
            if max_dimension:
                width, height = img.size
                if width > max_dimension or height > max_dimension:
                    ratio = min(max_dimension / width, max_dimension / height)
                    new_size = (int(width * ratio), int(height * ratio))
                    img = img.resize(new_size, Image.Resampling.LANCZOS)
            
            # Save as JPEG
            img.save(output_path, "JPEG", quality=85)
            print(f"Successfully processed: {output_path}")

    except Exception as e:
        print(f"Error processing image: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Convert and resize images.")
    parser.add_argument("input_path", help="Path to the input image")
    parser.add_argument("output_path", help="Path to save the output image")
    parser.add_argument("--max_dimension", type=int, help="Maximum width or height for the output image")

    args = parser.parse_args()
    
    process_image(args.input_path, args.output_path, args.max_dimension)
