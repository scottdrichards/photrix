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


def _read_box_header(f):
    """Read one ISOBMFF box header at the file's current position. Returns
    (start, size, type, header_len) with size including the header, or None
    at EOF."""
    start = f.tell()
    header = f.read(8)
    if len(header) < 8:
        return None
    size, box_type = struct.unpack('>I4s', header)
    box_type = box_type.decode('latin1', 'replace')
    header_len = 8
    if size == 1:
        largesize = struct.unpack('>Q', f.read(8))[0]
        header_len += 8
        size = largesize
    if box_type == 'uuid':
        f.read(16)
        header_len += 16
    return start, size, box_type, header_len


def _iter_boxes(f, container_start, container_size):
    """Yield (start, size, type, header_len) for each direct child box of a
    container spanning [container_start, container_start + container_size)."""
    end = container_start + container_size
    while f.tell() < end:
        hdr = _read_box_header(f)
        if hdr is None:
            break
        start, size, box_type, header_len = hdr
        if size == 0:  # box extends to EOF (only valid for the last top-level box)
            f.seek(0, os.SEEK_END)
            size = f.tell() - start
        if size <= 0 or start + size > end:
            break
        yield start, size, box_type, header_len
        f.seek(start + size)


def _get_heic_container_transform(input_path):
    """Read the HEIF 'meta' box structure directly to find the primary
    item's native (pre-rotation) pixel dimensions (its 'ispe' property) and
    rotation ('irot'/'imir' properties) — the authoritative source for a
    tiled/grid HEIC's orientation, straight from the same box structure
    libheif itself reads.

    EXIF orientation is not a reliable stand-in for this: Apple's tiled HEIC
    encoder routinely leaves EXIF orientation at 1 (identity) and expresses
    the real rotation via 'irot' instead, which the old EXIF-orientation-only
    logic had no way to see — verified case: a portrait iPhone SE photo
    encoded as a 4032x3024 (landscape) tile grid with 'irot' angle 3
    (270° CCW) and EXIF orientation 1. Using EXIF there silently produced a
    correctly-tiled but 90°-off, scrambled-looking canvas (wrong grid
    dimensions too, since native_w/h were derived from the wrong signal).

    Returns (native_w, native_h, rotation_ccw_degrees, mirror_axis) or None
    if the box structure can't be parsed this way (caller should fall back
    to the EXIF-orientation heuristic). mirror_axis is None (no mirror),
    'horizontal', or 'vertical'.
    """
    try:
        with open(input_path, 'rb') as f:
            f.seek(0, os.SEEK_END)
            file_size = f.tell()
            f.seek(0)

            meta = None
            for start, size, box_type, header_len in _iter_boxes(f, 0, file_size):
                if box_type == 'meta':
                    meta = (start, size, header_len)
                    break
            if meta is None:
                return None
            meta_start, meta_size, meta_header_len = meta
            f.seek(meta_start + meta_header_len + 4)  # skip meta FullBox version+flags

            pitm_id = None
            iprp = None
            for start, size, box_type, header_len in _iter_boxes(f, meta_start, meta_size):
                if box_type == 'pitm':
                    f.seek(start + header_len)
                    version = f.read(1)[0]
                    f.read(3)  # flags
                    pitm_id = (struct.unpack('>H', f.read(2))[0] if version == 0
                               else struct.unpack('>I', f.read(4))[0])
                elif box_type == 'iprp':
                    iprp = (start, size, header_len)
            if pitm_id is None or iprp is None:
                return None
            iprp_start, iprp_size, iprp_header_len = iprp
            f.seek(iprp_start + iprp_header_len)  # rewind: the meta-children loop above left the file position past iprp

            props = []  # ordered (type, body) — 1-indexed by ipma property_index
            assoc = {}  # item_id -> [property_index, ...]
            for start, size, box_type, header_len in _iter_boxes(f, iprp_start, iprp_size):
                if box_type == 'ipco':
                    for pstart, psize, ptype, pheader_len in _iter_boxes(f, start, size):
                        f.seek(pstart + pheader_len)
                        props.append((ptype, f.read(psize - pheader_len)))
                elif box_type == 'ipma':
                    f.seek(start + header_len)
                    version = f.read(1)[0]
                    flags = int.from_bytes(f.read(3), 'big')
                    entry_count = struct.unpack('>I', f.read(4))[0]
                    for _ in range(entry_count):
                        item_id = (struct.unpack('>H', f.read(2))[0] if version < 1
                                   else struct.unpack('>I', f.read(4))[0])
                        assoc_count = f.read(1)[0]
                        indices = []
                        for _ in range(assoc_count):
                            if flags & 1:
                                indices.append(struct.unpack('>H', f.read(2))[0] & 0x7FFF)
                            else:
                                indices.append(f.read(1)[0] & 0x7F)
                        assoc[item_id] = indices

            native_w = native_h = None
            rotation_ccw = 0
            mirror_axis = None
            for idx in assoc.get(pitm_id, []):
                if not (1 <= idx <= len(props)):
                    continue
                ptype, body = props[idx - 1]
                if ptype == 'ispe' and len(body) >= 12:
                    native_w = struct.unpack('>I', body[4:8])[0]
                    native_h = struct.unpack('>I', body[8:12])[0]
                elif ptype == 'irot' and body:
                    rotation_ccw = (body[0] & 0x3) * 90
                elif ptype == 'imir' and body:
                    mirror_axis = 'vertical' if (body[0] & 0x1) == 0 else 'horizontal'
            if native_w and native_h:
                return native_w, native_h, rotation_ccw, mirror_axis
            return None
    except Exception:
        return None


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
    try:
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

        # Prefer the authoritative container-level transform (see
        # _get_heic_container_transform's docstring for why EXIF orientation
        # alone isn't trustworthy here). Only fall back to the EXIF heuristic
        # if the box structure couldn't be parsed.
        rotation_ccw = 0
        mirror_axis = None
        exif_orientation = None  # set only on the fallback path
        container_transform = _get_heic_container_transform(input_path)
        if container_transform is not None:
            native_w, native_h, rotation_ccw, mirror_axis = container_transform
        else:
            # Get image dimensions and EXIF orientation from pillow_heif
            # metadata (no pixel decode happens here — pillow_heif is lazy).
            pillow_heif.options.THUMBNAILS = False
            hf = pillow_heif.open_heif(input_path)
            heif_img = hf[0]
            displayed_w, displayed_h = heif_img.size
            exif_orientation = _get_exif_orientation(heif_img.info.get('exif', b''))

            # Derive native HEVC canvas size (before EXIF rotation is applied).
            # Orientations 5–8 transpose width and height.
            if exif_orientation in (5, 6, 7, 8):
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

        if exif_orientation is not None:
            # Fallback path: apply EXIF orientation the same way PIL's own
            # exif_transpose does.
            _TRANSPOSE = {
                2: Image.FLIP_LEFT_RIGHT,
                3: Image.ROTATE_180,
                4: Image.FLIP_TOP_BOTTOM,
                5: Image.TRANSPOSE,
                6: Image.ROTATE_270,
                7: Image.TRANSVERSE,
                8: Image.ROTATE_90,
            }
            if exif_orientation in _TRANSPOSE:
                img = img.transpose(_TRANSPOSE[exif_orientation])
        else:
            # Container-transform path: apply rotation (HEIF 'irot' angle is
            # CCW, matching PIL's ROTATE_*), then mirror.
            _ROTATE = {90: Image.ROTATE_90, 180: Image.ROTATE_180, 270: Image.ROTATE_270}
            if rotation_ccw in _ROTATE:
                img = img.transpose(_ROTATE[rotation_ccw])
            if mirror_axis == 'horizontal':
                img = img.transpose(Image.FLIP_LEFT_RIGHT)
            elif mirror_axis == 'vertical':
                img = img.transpose(Image.FLIP_TOP_BOTTOM)

        return img
    finally:
        container.close()


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


def _save_atomic(img, output_path):
    """Encode to a sibling temp file then rename into place, so a kill
    mid-write (request abort, worker eviction) can never leave a truncated
    file at the final path — a partial file there would be served as a valid
    cache hit forever after."""
    tmp_path = output_path + '.tmp'
    # Pick the encoder from the output extension. WebP is the default (smaller
    # than JPEG at matching quality); JPEG is kept as a fallback for any caller
    # still asking for a .jpg path.
    out_ext = os.path.splitext(output_path)[1].lower()
    fmt = ('WEBP', {'quality': 80, 'method': 4}) if out_ext == '.webp' else ('JPEG', {'quality': 85})
    try:
        img.save(tmp_path, fmt[0], **fmt[1])
        os.replace(tmp_path, output_path)
    except BaseException:
        try:
            os.remove(tmp_path)
        except OSError:
            pass
        raise


def process_image(input_path, outputs, quiet=False):
    """Convert one source image into every requested output. Raises on error;
    the CLI and worker entry points translate that into their own protocols."""
    if not os.path.exists(input_path):
        raise RuntimeError(f"Input file not found: {input_path}")

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

            _save_atomic(current_img, output_path)
            if not quiet:
                print(f"Successfully processed: {output_path}")


def run_worker():
    """Persistent worker mode: newline-delimited JSON requests on stdin,
    responses on stdout. Keeping the process (and its PIL/pillow_heif imports)
    alive across requests removes the ~0.5-1s interpreter startup that a
    spawn-per-image design pays for every single preview."""
    print(json.dumps({'type': 'ready'}), flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as e:
            print(json.dumps({'id': None, 'error': f'invalid request JSON: {e}'}), flush=True)
            continue
        req_id = request.get('id')
        try:
            process_image(request['inputPath'], request['outputs'], quiet=True)
            print(json.dumps({'id': req_id, 'ok': True}), flush=True)
        except Exception as e:
            print(json.dumps({'id': req_id, 'error': str(e)}), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Convert and resize images.")
    parser.add_argument("input_path", nargs='?', help="Path to the input image")
    parser.add_argument("--outputs", help="JSON string of outputs: [{'path': '...', 'height': 320}, ...]")
    parser.add_argument("--worker", action="store_true",
                        help="Persistent mode: serve JSON-line requests from stdin until EOF")
    # Keep backward compatibility for single file mode if needed, or just migrate everything
    parser.add_argument("output_path", nargs='?', help="Legacy: Path to save the output image")
    parser.add_argument("--max_dimension", type=int, help="Legacy: Maximum width or height")

    args = parser.parse_args()

    if args.worker:
        run_worker()
        sys.exit(0)

    if not args.input_path:
        print("Error: Must provide an input path (or --worker)", file=sys.stderr)
        sys.exit(1)

    try:
        if args.outputs:
            process_image(args.input_path, json.loads(args.outputs))
        elif args.output_path:
            process_image(args.input_path, [{'path': args.output_path, 'height': args.max_dimension}])
        else:
            print("Error: Must provide either --outputs or output_path", file=sys.stderr)
            sys.exit(1)
    except Exception as e:
        print(f"Error processing image: {e}", file=sys.stderr)
        sys.exit(1)
