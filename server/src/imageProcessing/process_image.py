import sys
import argparse
import json
import math
import struct
from PIL import Image, ImageOps
from pillow_heif import register_heif_opener
import os

# Register HEIF opener to support .heic files
register_heif_opener()

RAW_EXTENSIONS = {'.cr3', '.cr2', '.nef', '.arw', '.orf', '.raf', '.srw', '.rw2', '.dng', '.raw'}
HEIC_EXTENSIONS = {'.heic', '.heif'}


def _get_exif_orientation(exif_bytes):
    """Parse raw EXIF bytes to extract the orientation tag (0x0112)."""
    if not exif_bytes or len(exif_bytes) < 8:
        return 1
    if exif_bytes[:4] == b'Exif':
        exif_bytes = exif_bytes[6:]
    if len(exif_bytes) < 8:
        return 1
    endian = '<' if exif_bytes[:2] == b'II' else '>' if exif_bytes[:2] == b'MM' else None
    if endian is None:
        return 1
    try:
        ifd_offset = struct.unpack_from(endian + 'I', exif_bytes, 4)[0]
        n_entries = struct.unpack_from(endian + 'H', exif_bytes, ifd_offset)[0]
        for i in range(n_entries):
            entry_offset = ifd_offset + 2 + i * 12
            tag = struct.unpack_from(endian + 'H', exif_bytes, entry_offset)[0]
            if tag == 0x0112:
                return struct.unpack_from(endian + 'H', exif_bytes, entry_offset + 8)[0]
    except Exception:
        pass
    return 1


def _open_heic_via_pyav(input_path):
    """Decode tiled Apple HEIC using pyav (FFmpeg), bypassing the libde265
    green-tile artifact that affects some iPhone photos.

    Returns a PIL Image in the correct display orientation, or None if the
    file is not a tiled HEIC or pyav is unavailable.
    """
    try:
        import av
    except ImportError:
        return None

    import pillow_heif

    container = av.open(input_path)

    # Identify tile streams: multiple HEVC streams of identical dimensions.
    stream_sizes: dict[tuple[int, int], int] = {}
    for s in container.streams.video:
        key = (s.width, s.height)
        stream_sizes[key] = stream_sizes.get(key, 0) + 1

    candidates = [(sz, cnt) for sz, cnt in stream_sizes.items() if cnt >= 4]
    if not candidates:
        return None  # Not a tiled HEIC

    tile_w, tile_h = max(candidates, key=lambda x: x[1])[0]
    tile_streams = [s for s in container.streams.video if (s.width, s.height) == (tile_w, tile_h)]
    n_tiles = len(tile_streams)

    # Get image dimensions and EXIF orientation from pillow_heif metadata
    # (no pixel decode happens here — pillow_heif is lazy).
    pillow_heif.options.THUMBNAILS = False
    hf = pillow_heif.open_heif(input_path)
    heif_img = hf[0]
    displayed_w, displayed_h = heif_img.size
    orientation = _get_exif_orientation(heif_img.info.get('exif', b''))

    # Derive native HEVC canvas size (before EXIF rotation is applied).
    # Orientations 5–8 transpose width and height.
    if orientation in (5, 6, 7, 8):
        native_w, native_h = displayed_h, displayed_w
    else:
        native_w, native_h = displayed_w, displayed_h

    grid_cols = math.ceil(native_w / tile_w)
    grid_rows = math.ceil(native_h / tile_h)

    if grid_cols * grid_rows != n_tiles:
        return None  # Tile count doesn't match expected grid layout

    canvas = __import__('numpy').zeros((native_h, native_w, 3), dtype='uint8')

    for i, stream in enumerate(tile_streams):
        col = i % grid_cols
        row = i // grid_cols
        x, y = col * tile_w, row * tile_h
        try:
            for packet in container.demux(stream):
                frames = list(packet.decode())
                if frames:
                    arr = frames[0].to_ndarray(format='rgb24')
                    h = min(tile_h, native_h - y)
                    w = min(tile_w, native_w - x)
                    canvas[y:y+h, x:x+w] = arr[:h, :w]
                    break
        except Exception:
            pass  # Leave failed tiles black (far better than solid green)

    img = Image.fromarray(canvas)

    # Apply EXIF orientation using the same mapping as PIL's exif_transpose.
    _TRANSPOSE = {
        2: Image.FLIP_LEFT_RIGHT,
        3: Image.ROTATE_180,
        4: Image.FLIP_TOP_BOTTOM,
        5: Image.TRANSPOSE,
        6: Image.ROTATE_270,
        7: Image.TRANSVERSE,
        8: Image.ROTATE_90,
    }
    if orientation in _TRANSPOSE:
        img = img.transpose(_TRANSPOSE[orientation])

    return img


def open_image(input_path):
    ext = os.path.splitext(input_path)[1].lower()
    if ext in RAW_EXTENSIONS:
        import rawpy
        import numpy as np
        with rawpy.imread(input_path) as raw:
            rgb = raw.postprocess(use_camera_wb=True, output_bps=8)
        return Image.fromarray(rgb)
    if ext in HEIC_EXTENSIONS:
        img = _open_heic_via_pyav(input_path)
        if img is not None:
            return img
    return Image.open(input_path)

def _draft_target(outputs):
    """Smallest full-image size (long edge, px) that still satisfies every
    output at full quality, or None if any output needs original resolution.

    A plain resize output needs the source at least as large as `height`.
    A cropped output only samples a `cw`x`ch` fraction, so the source must be
    `height / max(cw, ch)` for that crop's long edge to still reach `height`
    pixels — tiny faces therefore keep near-full resolution, close-ups relax
    to a fraction of it. Passing this to Image.draft() lets the JPEG decoder
    skip the discarded detail (~4x faster decode) with no visible quality loss;
    draft never returns an image smaller than the requested size.
    """
    need = 0.0
    for output in outputs:
        max_dimension = output.get('height')
        if not max_dimension:  # None/"original" → must decode at full resolution
            return None
        crop = output.get('crop')
        if crop:
            _, _, cw, ch = crop
            longest_fraction = max(cw, ch, 1e-6)
            need = max(need, max_dimension / longest_fraction)
        else:
            need = max(need, float(max_dimension))
    return int(math.ceil(need)) if need else None


def process_image(input_path, outputs):
    try:
        if not os.path.exists(input_path):
            print(f"Error: Input file not found: {input_path}", file=sys.stderr)
            sys.exit(1)

        img = open_image(input_path)
        # Hint the (JPEG) decoder to emit only as many pixels as the outputs
        # need, before any pixels are loaded. No-op for formats/decoders that
        # don't support draft mode (RAW/HEIC are already fully decoded here).
        draft_target = _draft_target(outputs)
        if draft_target is not None:
            img.draft('RGB', (draft_target, draft_target))
        with img:
            # Apply EXIF rotation (no-op for HEIC files decoded via pyav,
            # which already have orientation applied).
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
