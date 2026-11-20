#!/usr/bin/env python3
"""Generate the last four camera-derived fixtures in server/exampleFolder.

Most of exampleFolder is already synthetic (see the People/, Trip/, Burst/ and
Albums/ sets). These four were the remaining files that came straight off real
cameras, which made them large, unreproducible, and carriers of whatever
metadata the originating device happened to write. This script replaces them
with procedurally drawn pixels plus hand-authored EXIF — invented device
strings and public-landmark GPS — so the whole fixture folder is synthetic,
reproducible, and small.

Each replacement preserves the structural properties the test suite asserts on:

  subFolder/grandchildFolder/1V7A4755.JPG
      uppercase extension; EXIF declares a 3:2 6960x4640 sensor with
      orientation 8; carries a 160x120 (4:3) embedded thumbnail, so the
      thumbnail extractor's aspect-crop + orientation branch stays covered
  subFolder/20120803_160939.jpg
      4:3 with EXIF GPS but deliberately *no* embedded thumbnail, covering the
      extractor's "fall back to a full decode" path
  sewing-threads.heic
      landscape 4000x3000 HEIC with EXIF + GPS; also the live-photo pairing
      fixture (a sibling .MOV is created by the test, matched on file stem)
  subFolder/soundboard.heic
      portrait 3000x4000 HEIC with EXIF + GPS

It also draws the story fixtures (STORY_FIXTURES below): procedural postcard
scenes with invented EXIF and public-landmark GPS that give the trip detector
in server/src/stories a home base and two trips to find.

Keep new fixtures synthetic: this folder ships in a public repository, so
fixture EXIF should never come from a real device.

Requires: pip install piexif pillow pillow-heif

    python3 server/scripts/make-example-fixtures.py <path-to-repo-root>
"""
import io
import math
import os
import sys

import piexif
from PIL import Image, ImageDraw, ImageFilter
import pillow_heif

pillow_heif.register_heif_opener()


# --------------------------------------------------------------------------
# procedural image content
# --------------------------------------------------------------------------
def gradient(w, h, c0, c1, diagonal=True):
    """Smooth two-colour gradient. Compresses tiny, decodes to real pixels."""
    base = Image.new("RGB", (w, h))
    px = base.load()
    small_w, small_h = 64, 64
    small = Image.new("RGB", (small_w, small_h))
    sp = small.load()
    for y in range(small_h):
        for x in range(small_w):
            t = ((x / (small_w - 1)) + (y / (small_h - 1))) / 2 if diagonal else y / (small_h - 1)
            sp[x, y] = tuple(int(c0[i] + (c1[i] - c0[i]) * t) for i in range(3))
    return small.resize((w, h), Image.BICUBIC)


def add_shapes(im, seed=0, n=14):
    """Deterministic geometric shapes so the image isn't a flat ramp - gives
    thumbnailers, CLIP embeddings and face detectors something non-degenerate."""
    d = ImageDraw.Draw(im, "RGBA")
    w, h = im.size
    for i in range(n):
        a = (i * 2.399 + seed) % (2 * math.pi)
        cx = int(w * (0.5 + 0.36 * math.cos(a)))
        cy = int(h * (0.5 + 0.36 * math.sin(a * 1.7)))
        r = int(min(w, h) * (0.05 + 0.055 * ((i * 7 + seed) % 5) / 4))
        col = (
            (i * 53 + 40) % 256,
            (i * 97 + 90) % 256,
            (i * 151 + 140) % 256,
            120,
        )
        if i % 3 == 0:
            d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=col)
        elif i % 3 == 1:
            d.rectangle([cx - r, cy - r, cx + r, cy + r], fill=col)
        else:
            d.polygon([(cx, cy - r), (cx + r, cy + r), (cx - r, cy + r)], fill=col)
    return im


def synth(w, h, c0, c1, seed):
    im = gradient(w, h, c0, c1)
    im = add_shapes(im, seed=seed)
    return im.filter(ImageFilter.GaussianBlur(0.6))


# --------------------------------------------------------------------------
# EXIF helpers
# --------------------------------------------------------------------------
def deg_to_dms_rational(dec):
    dec = abs(dec)
    d = int(dec)
    m = int((dec - d) * 60)
    s = (dec - d - m / 60) * 3600
    return ((d, 1), (m, 1), (int(round(s * 10000)), 10000))


def gps_ifd(lat, lon, alt_m):
    return {
        piexif.GPSIFD.GPSVersionID: (2, 3, 0, 0),
        piexif.GPSIFD.GPSLatitudeRef: "N" if lat >= 0 else "S",
        piexif.GPSIFD.GPSLatitude: deg_to_dms_rational(lat),
        piexif.GPSIFD.GPSLongitudeRef: "E" if lon >= 0 else "W",
        piexif.GPSIFD.GPSLongitude: deg_to_dms_rational(lon),
        piexif.GPSIFD.GPSAltitudeRef: 0,
        piexif.GPSIFD.GPSAltitude: (int(round(alt_m * 10)), 10),
    }


def jpeg_bytes(im, quality=80, optimize=True):
    buf = io.BytesIO()
    im.save(buf, format="JPEG", quality=quality, optimize=optimize)
    return buf.getvalue()


# --------------------------------------------------------------------------
# fixture builders
# --------------------------------------------------------------------------
def build_canon_jpeg(path):
    """Canon-style DSLR JPEG.

    Test contract (server/src/imageProcessing/embeddedThumbnail.spec.ts):
      - carries a 160x120 embedded EXIF thumbnail (4:3)
      - EXIF Orientation 8, so the upright display is portrait
      - EXIF declares a 3:2 sensor (6960x4640) that the 4:3 thumbnail must be
        cropped to -> exercises the aspect-crop branch
    convertImage.spec.ts additionally re-encodes it at 320px.
    """
    w, h = 1400, 933  # 3:2, matching the sensor aspect declared in EXIF below
    im = synth(w, h, (28, 46, 74), (196, 168, 120), seed=1)

    thumb = jpeg_bytes(im.resize((160, 120), Image.LANCZOS), quality=72)

    zeroth = {
        piexif.ImageIFD.Make: b"Contoso",
        piexif.ImageIFD.Model: b"Contoso SLR-70",
        piexif.ImageIFD.Orientation: 8,
        piexif.ImageIFD.XResolution: (72, 1),
        piexif.ImageIFD.YResolution: (72, 1),
        piexif.ImageIFD.ResolutionUnit: 2,
        piexif.ImageIFD.Software: b"Contoso Firmware 1.4.0",
        piexif.ImageIFD.DateTime: b"2024:10:05 09:12:33",
        piexif.ImageIFD.ImageDescription: b"Synthetic fixture: autumn ridge at sunrise",
        piexif.ImageIFD.YCbCrPositioning: 2,
    }
    exif = {
        piexif.ExifIFD.ExposureTime: (1, 40),
        piexif.ExifIFD.FNumber: (5, 1),
        piexif.ExifIFD.ExposureProgram: 1,
        piexif.ExifIFD.ISOSpeedRatings: 2000,
        piexif.ExifIFD.ExifVersion: b"0231",
        piexif.ExifIFD.DateTimeOriginal: b"2024:10:05 09:12:33",
        piexif.ExifIFD.DateTimeDigitized: b"2024:10:05 09:12:33",
        piexif.ExifIFD.OffsetTime: b"-04:00",
        piexif.ExifIFD.OffsetTimeOriginal: b"-04:00",
        piexif.ExifIFD.ShutterSpeedValue: (5375, 1000),
        piexif.ExifIFD.ApertureValue: (4625, 1000),
        piexif.ExifIFD.ExposureBiasValue: (0, 1),
        piexif.ExifIFD.MeteringMode: 5,
        piexif.ExifIFD.Flash: 0,
        piexif.ExifIFD.FocalLength: (29, 1),
        piexif.ExifIFD.ColorSpace: 1,
        # Declared sensor size stays 3:2 and full-resolution: the thumbnail
        # aspect-crop assertion keys off these, not off the stored pixels.
        piexif.ExifIFD.PixelXDimension: 6960,
        piexif.ExifIFD.PixelYDimension: 4640,
        piexif.ExifIFD.FocalPlaneXResolution: (7936, 1),
        piexif.ExifIFD.FocalPlaneYResolution: (7932, 1),
        piexif.ExifIFD.FocalPlaneResolutionUnit: 2,
        piexif.ExifIFD.ExposureMode: 1,
        piexif.ExifIFD.WhiteBalance: 0,
        piexif.ExifIFD.SceneCaptureType: 0,
        piexif.ExifIFD.LensSpecification: ((18, 1), (35, 1), (0, 1), (0, 1)),
        piexif.ExifIFD.LensModel: b"Contoso 18-35mm F1.8 Art",
        # Intentionally omitted: Artist, CameraOwnerName, BodySerialNumber,
        # LensSerialNumber, Copyright, MakerNote and UserComment. Nothing here
        # should identify a person or a specific physical device.
    }
    gps = gps_ifd(36.5786, -118.2923, 2810.0)  # Sierra Nevada, public landmark
    exif_bytes = piexif.dump(
        {"0th": zeroth, "Exif": exif, "GPS": gps, "1st": {}, "thumbnail": thumb}
    )
    im.save(path, format="JPEG", quality=82, optimize=True, exif=exif_bytes)


def build_phone_jpeg(path):
    """2010s-phone-style JPEG with GPS and *no extractable* embedded thumbnail.

    embeddedThumbnail.spec.ts asserts convertEmbeddedThumbnail(...) === null
    for this file, so it must not carry an IFD1 thumbnail.
    """
    w, h = 1400, 1050  # 4:3
    im = synth(w, h, (54, 78, 42), (222, 214, 176), seed=2)

    zeroth = {
        piexif.ImageIFD.Make: b"Fabrikam",
        piexif.ImageIFD.Model: b"Fabrikam Pulse X2",
        piexif.ImageIFD.Orientation: 1,
        piexif.ImageIFD.XResolution: (72, 1),
        piexif.ImageIFD.YResolution: (72, 1),
        piexif.ImageIFD.ResolutionUnit: 2,
        piexif.ImageIFD.DateTime: b"2012:08:03 16:09:38",
        piexif.ImageIFD.ImageDescription: b"Synthetic fixture: alpine lake overlook",
    }
    exif = {
        piexif.ExifIFD.ExposureTime: (1, 1000),
        piexif.ExifIFD.FNumber: (26, 10),
        piexif.ExifIFD.ExposureProgram: 3,
        piexif.ExifIFD.ExifVersion: b"0221",
        piexif.ExifIFD.DateTimeOriginal: b"2012:08:03 16:09:38",
        piexif.ExifIFD.DateTimeDigitized: b"2012:08:03 16:09:38",
        piexif.ExifIFD.MeteringMode: 2,
        piexif.ExifIFD.Flash: 16,
        piexif.ExifIFD.FocalLength: (403, 100),
        piexif.ExifIFD.ColorSpace: 1,
        piexif.ExifIFD.PixelXDimension: 3264,
        piexif.ExifIFD.PixelYDimension: 2448,
        piexif.ExifIFD.WhiteBalance: 0,
    }
    # Public landmark (Grand Teton NP overlook).
    gps = gps_ifd(43.7904, -110.6818, 2064.0)
    # No "1st"/"thumbnail" entries -> no IFD1 thumbnail to extract.
    exif_bytes = piexif.dump({"0th": zeroth, "Exif": exif, "GPS": gps})
    im.save(path, format="JPEG", quality=80, optimize=True, exif=exif_bytes)


def build_heic(path, size, dt, gps_ll, alt, desc, seed, iso):
    """HEIC fixture with EXIF + GPS, matching the previous files' shape."""
    w, h = size
    im = synth(w, h, (40, 40, 58), (208, 150, 138), seed=seed)

    zeroth = {
        piexif.ImageIFD.Make: b"Fabrikam",
        piexif.ImageIFD.Model: b"Fabrikam Pulse A3",
        piexif.ImageIFD.Orientation: 1,
        piexif.ImageIFD.XResolution: (72, 1),
        piexif.ImageIFD.YResolution: (72, 1),
        piexif.ImageIFD.ResolutionUnit: 2,
        piexif.ImageIFD.Software: b"Fabrikam Firmware 3.1",
        piexif.ImageIFD.DateTime: dt.encode(),
        piexif.ImageIFD.ImageDescription: desc,
        piexif.ImageIFD.YCbCrPositioning: 1,
    }
    exif = {
        piexif.ExifIFD.ExposureTime: (1, 25),
        piexif.ExifIFD.FNumber: (18, 10),
        piexif.ExifIFD.ExposureProgram: 2,
        piexif.ExifIFD.ISOSpeedRatings: iso,
        piexif.ExifIFD.ExifVersion: b"0220",
        piexif.ExifIFD.DateTimeOriginal: dt.encode(),
        piexif.ExifIFD.DateTimeDigitized: dt.encode(),
        piexif.ExifIFD.OffsetTime: b"+01:00",
        piexif.ExifIFD.OffsetTimeOriginal: b"+01:00",
        piexif.ExifIFD.MeteringMode: 2,
        piexif.ExifIFD.Flash: 0,
        piexif.ExifIFD.FocalLength: (46, 10),
        piexif.ExifIFD.ColorSpace: 1,
        piexif.ExifIFD.PixelXDimension: w,
        piexif.ExifIFD.PixelYDimension: h,
        piexif.ExifIFD.ExposureMode: 0,
        piexif.ExifIFD.WhiteBalance: 0,
        piexif.ExifIFD.DigitalZoomRatio: (1, 1),
        piexif.ExifIFD.FocalLengthIn35mmFilm: 25,
        piexif.ExifIFD.SceneCaptureType: 0,
    }
    gps = gps_ifd(gps_ll[0], gps_ll[1], alt)
    exif_bytes = piexif.dump({"0th": zeroth, "Exif": exif, "GPS": gps})
    im.save(path, format="HEIF", quality=55, exif=exif_bytes)


# --------------------------------------------------------------------------
# story fixtures: a home base plus two trips, for server/src/stories
# --------------------------------------------------------------------------
# Palettes per scene kind: sky top, sky horizon, sun, then three silhouette
# layers from far to near.
SCENE_PALETTES = {
    "dusk": ((38, 44, 92), (246, 160, 112), (255, 226, 170),
             (120, 86, 120), (78, 56, 96), (36, 28, 52)),
    "day": ((86, 148, 214), (198, 226, 240), (255, 250, 228),
            (128, 158, 140), (84, 120, 92), (46, 76, 54)),
    "gold": ((112, 120, 168), (250, 204, 128), (255, 240, 196),
             (176, 128, 98), (128, 88, 70), (72, 48, 44)),
    "night": ((10, 14, 36), (52, 62, 110), (236, 236, 214),
              (40, 46, 78), (26, 30, 56), (12, 14, 30)),
}


def ridge(w, h, base, amp, seed, layer):
    """A deterministic silhouette line: a few summed sines, no RNG."""
    pts = []
    for x in range(0, w + 8, 8):
        t = x / w
        y = base
        for k in range(1, 4):
            y += amp / k * math.sin(t * math.pi * (k * 2.3 + layer) + seed * 1.7 + k * layer)
        pts.append((x, int(y)))
    return pts + [(w, h), (0, h)]


def scenic(w, h, kind, seed, city=False, water=False):
    """A postcard-like landscape: sky, sun, three ridges, optional skyline or
    sea. Deterministic and smooth, so it compresses small, but it has a real
    horizon and structure for thumbnails, CLIP and the Ken Burns pan."""
    sky0, sky1, sun, *layers = SCENE_PALETTES[kind]
    small = Image.new("RGB", (8, 64))
    sp = small.load()
    for y in range(64):
        t = (y / 63) ** 1.4
        for x in range(8):
            sp[x, y] = tuple(int(sky0[i] + (sky1[i] - sky0[i]) * t) for i in range(3))
    im = small.resize((w, h), Image.BICUBIC)

    glow = Image.new("L", (w, h), 0)
    sx = int(w * (0.2 + 0.6 * ((seed * 37) % 100) / 100))
    sy = int(h * (0.28 + 0.12 * ((seed * 17) % 10) / 10))
    r = int(min(w, h) * 0.07)
    ImageDraw.Draw(glow).ellipse([sx - 3 * r, sy - 3 * r, sx + 3 * r, sy + 3 * r], fill=90)
    glow = glow.filter(ImageFilter.GaussianBlur(r))
    im = Image.composite(Image.new("RGB", (w, h), sun), im, glow)
    d = ImageDraw.Draw(im)
    d.ellipse([sx - r, sy - r, sx + r, sy + r], fill=sun)

    horizon = h * (0.62 if water else 0.56)
    for i, colour in enumerate(layers):
        base = horizon + i * h * 0.09
        d.polygon(ridge(w, h, base, h * (0.07 - i * 0.015), seed, i), fill=colour)
        if city and i == 1:
            x = int(w * 0.08)
            k = 0
            while x < w * 0.92:
                bw = int(w * (0.03 + 0.02 * ((seed + k * 7) % 5) / 4))
                bh = int(h * (0.08 + 0.16 * ((seed * 3 + k * 11) % 9) / 8))
                top = int(base) - bh
                d.rectangle([x, top, x + bw, int(base) + 4], fill=colour)
                if (seed + k) % 4 == 0:  # a dome or a spire
                    d.ellipse([x, top - bw // 2, x + bw, top + bw // 2], fill=colour)
                x += bw + int(w * 0.006)
                k += 1
    if water:
        top = int(h * 0.74)
        d.rectangle([0, top, w, h], fill=tuple(int(c * 0.8) for c in sky1))
        for j in range(14):
            y = top + 6 + j * (h - top) // 14
            x0 = int(w * ((seed * 13 + j * 29) % 100) / 100 * 0.6)
            d.line([(x0, y), (x0 + int(w * 0.25), y)], fill=tuple(min(255, c + 30) for c in sky1), width=2)
    return im.filter(ImageFilter.GaussianBlur(0.8))


def build_story_jpeg(path, dt, lat, lon, desc, kind, seed, portrait=False, city=False, water=False):
    w, h = (800, 1200) if portrait else (1200, 800)
    im = scenic(w, h, kind, seed, city=city, water=water)
    zeroth = {
        piexif.ImageIFD.Make: b"Fabrikam",
        piexif.ImageIFD.Model: b"Fabrikam Pulse X4",
        piexif.ImageIFD.Orientation: 1,
        piexif.ImageIFD.XResolution: (72, 1),
        piexif.ImageIFD.YResolution: (72, 1),
        piexif.ImageIFD.ResolutionUnit: 2,
        piexif.ImageIFD.DateTime: dt.encode(),
        piexif.ImageIFD.ImageDescription: desc.encode(),
    }
    exif = {
        piexif.ExifIFD.ExposureTime: (1, 250),
        piexif.ExifIFD.FNumber: (18, 10),
        piexif.ExifIFD.ISOSpeedRatings: 64,
        piexif.ExifIFD.ExifVersion: b"0232",
        piexif.ExifIFD.DateTimeOriginal: dt.encode(),
        piexif.ExifIFD.DateTimeDigitized: dt.encode(),
        piexif.ExifIFD.FocalLength: (52, 10),
        piexif.ExifIFD.ColorSpace: 1,
        piexif.ExifIFD.PixelXDimension: w,
        piexif.ExifIFD.PixelYDimension: h,
    }
    exif_bytes = piexif.dump({"0th": zeroth, "Exif": exif, "GPS": gps_ifd(lat, lon, 20.0)})
    im.save(path, format="JPEG", quality=72, optimize=True, exif=exif_bytes)


# (relative path, DateTimeOriginal, lat, lon, description, scene kind, options)
# Public landmarks only. Home is a Seattle base on six separate days, enough
# for the detector to call it home; the Italy set is a four-day trip with a
# day in Florence; the three Trip/ stills join the existing Grand Canyon and
# Malibu files into a June 2024 road trip.
STORY_FIXTURES = [
    ("Home/2023-03-11_kerry_park.jpg", "2023:03:11 17:42:10", 47.6295, -122.3599, "Kerry Park view", "dusk", {"city": True}),
    ("Home/2023-04-16_pike_place.jpg", "2023:04:16 11:05:33", 47.6097, -122.3422, "Pike Place morning", "day", {"city": True, "water": True}),
    ("Home/2023-06-18_space_needle.jpg", "2023:06:18 20:31:02", 47.6205, -122.3493, "Space Needle at sunset", "gold", {"city": True, "portrait": True}),
    ("Home/2023-07-04_gas_works.jpg", "2023:07:04 21:48:45", 47.6456, -122.3344, "Fireworks over the lake", "night", {"water": True}),
    ("Trip/Italy/IMG_5101.jpg", "2023:05:03 14:10:12", 41.8902, 12.4922, "Colosseum", "day", {"city": True}),
    ("Trip/Italy/IMG_5108.jpg", "2023:05:03 15:31:40", 41.8925, 12.4853, "Roman Forum", "gold", {}),
    ("Trip/Italy/IMG_5116.jpg", "2023:05:03 19:45:03", 41.9009, 12.4833, "Trevi Fountain at dusk", "dusk", {"city": True, "portrait": True}),
    ("Trip/Italy/IMG_5140.jpg", "2023:05:04 09:20:55", 41.9022, 12.4539, "St. Peter's Square", "day", {"city": True}),
    ("Trip/Italy/IMG_5152.jpg", "2023:05:04 12:05:18", 41.9031, 12.4663, "Castel Sant'Angelo from the river", "day", {"city": True, "water": True}),
    ("Trip/Italy/IMG_5170.jpg", "2023:05:04 17:10:44", 41.8986, 12.4769, "Pantheon", "gold", {"city": True, "portrait": True}),
    ("Trip/Italy/IMG_5181.jpg", "2023:05:04 20:15:09", 41.8992, 12.4731, "Piazza Navona at night", "night", {"city": True}),
    ("Trip/Italy/IMG_5203.jpg", "2023:05:05 11:30:27", 43.7731, 11.2560, "Florence Duomo", "day", {"city": True}),
    ("Trip/Italy/IMG_5219.jpg", "2023:05:05 14:40:51", 43.7680, 11.2531, "Ponte Vecchio", "gold", {"city": True, "water": True}),
    ("Trip/Italy/IMG_5236.jpg", "2023:05:05 19:05:36", 43.7629, 11.2650, "Piazzale Michelangelo sunset", "dusk", {}),
    ("Trip/Italy/IMG_5250.jpg", "2023:05:06 10:15:02", 41.9060, 12.4828, "Spanish Steps", "day", {"city": True, "portrait": True}),
    ("Trip/Italy/IMG_5262.jpg", "2023:05:06 13:30:19", 41.8897, 12.4695, "Lunch in Trastevere", "gold", {"city": True}),
    ("Trip/HooverDam_2024-06-13.jpg", "2024:06:13 10:20:00", 36.0161, -114.7377, "Hoover Dam", "day", {"water": True}),
    ("Trip/JoshuaTree_2024-06-13.jpg", "2024:06:13 18:40:00", 33.8734, -115.9010, "Joshua Tree at golden hour", "gold", {}),
    ("Trip/SantaMonica_2024-06-14.jpg", "2024:06:14 09:30:00", 34.0094, -118.4973, "Santa Monica Pier", "day", {"water": True}),
    ("Home/2023-08-19_alki_beach.jpg", "2023:08:19 19:55:41", 47.5763, -122.4096, "Alki Beach sunset", "dusk", {"water": True}),
    ("Home/2023-10-07_discovery_park.jpg", "2023:10:07 15:12:08", 47.6573, -122.4055, "Discovery Park bluff", "day", {"water": True}),
]


def story_targets(ex):
    targets = []
    for seed, (rel, dt, lat, lon, desc, kind, opts) in enumerate(STORY_FIXTURES, start=11):
        def build(p, dt=dt, lat=lat, lon=lon, desc=desc, kind=kind, seed=seed, opts=opts):
            os.makedirs(os.path.dirname(p), exist_ok=True)
            build_story_jpeg(p, dt, lat, lon, f"Synthetic fixture: {desc}", kind, seed, **opts)
        targets.append((os.path.join(ex, rel), build))
    return targets


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else "."
    ex = os.path.join(root, "server", "exampleFolder")
    if not os.path.isdir(ex):
        sys.exit(f"not a photrix checkout: {ex} missing")

    targets = [
        (os.path.join(ex, "subFolder/grandchildFolder/1V7A4755.JPG"),
         lambda p: build_canon_jpeg(p)),
        (os.path.join(ex, "subFolder/20120803_160939.jpg"),
         lambda p: build_phone_jpeg(p)),
        (os.path.join(ex, "sewing-threads.heic"),
         lambda p: build_heic(p, (4000, 3000), "2023:12:12 18:39:16",
                              (47.6205, -122.3493), 158.0,
                              b"Synthetic fixture: spools of thread on a workbench",
                              seed=3, iso=500)),
        (os.path.join(ex, "subFolder/soundboard.heic"),
         lambda p: build_heic(p, (3000, 4000), "2024:01:21 18:27:07",
                              (48.8584, 2.2945), 33.0,
                              b"Synthetic fixture: audio mixing desk faders",
                              seed=4, iso=400)),
    ]
    targets += story_targets(ex)

    for path, build in targets:
        before = os.path.getsize(path) if os.path.exists(path) else 0
        if os.path.exists(path):
            os.remove(path)
        build(path)
        after = os.path.getsize(path)
        print(f"{os.path.relpath(path, root)}: {before:,} -> {after:,} bytes")


if __name__ == "__main__":
    main()
