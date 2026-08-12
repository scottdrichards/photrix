#!/usr/bin/env python3
"""
Generates the "photo of the day" JPEG(s) used as faint calendar-day
backgrounds on the HA Calendar dashboard.

For each day in the given range: picks a representative photo using the
criteria in day_photo_pick.py (rating -> named-family-count -> smiling-count
-> photoQualityScore -> deterministic path sort), converts/resizes it to a
JPEG, and writes it to OUTPUT_DIR/YYYY-MM-DD.jpg. Called on-demand by
dayPhotoRequestHandler.ts (server/src/requestHandlers/dayPhotoRequestHandler.ts).

Also prunes cached JPEGs older than RETENTION_DAYS on every run — this is
just photrix's own on-disk cache; HA's copy in /config/www has its own
separate retention.

Usage: generate_day_photos.py START_DATE [END_DATE]
"""
import sys
import os
import subprocess
import json
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from day_photo_pick import connect, get_target_person_ids, pick_for_day  # noqa: E402
from datetime import datetime, timedelta

MEDIA_ROOT = "/mnt/pictures-and-videos"
OUTPUT_DIR = "/home/dev/photrix/server/.cache/day-photos"
PYTHON = "/home/dev/photrix/server/.venv/bin/python"
PROCESS_IMAGE = "/home/dev/photrix/server/src/imageProcessing/process_image.py"
MAX_DIMENSION = 1400
RETENTION_DAYS = 62


def convert(source_path, dest_path):
    subprocess.run(
        [PYTHON, PROCESS_IMAGE, source_path, dest_path, "--max_dimension", str(MAX_DIMENSION)],
        check=True,
        capture_output=True,
        text=True,
    )


def prune_old_cache_files():
    if not os.path.isdir(OUTPUT_DIR):
        return
    cutoff = datetime.now() - timedelta(days=RETENTION_DAYS)
    for name in os.listdir(OUTPUT_DIR):
        if not name.endswith(".jpg"):
            continue
        date_part = name[: -len(".jpg")]
        try:
            file_date = datetime.strptime(date_part, "%Y-%m-%d")
        except ValueError:
            continue
        if file_date < cutoff:
            os.remove(os.path.join(OUTPUT_DIR, name))


def main():
    if len(sys.argv) < 2:
        print("usage: generate_day_photos.py START_DATE [END_DATE]", file=sys.stderr)
        sys.exit(1)
    start = sys.argv[1]
    end = sys.argv[2] if len(sys.argv) > 2 else start

    os.makedirs(OUTPUT_DIR, exist_ok=True)
    prune_old_cache_files()

    conn = connect()
    target_person_ids = get_target_person_ids(conn)

    d = datetime.strptime(start, "%Y-%m-%d")
    end_d = datetime.strptime(end, "%Y-%m-%d")
    manifest = {}
    while d <= end_d:
        date_str = d.strftime("%Y-%m-%d")
        winner = pick_for_day(conn, date_str, target_person_ids)
        dest_path = os.path.join(OUTPUT_DIR, f"{date_str}.jpg")
        if winner:
            source_path = os.path.join(MEDIA_ROOT, winner["relativePath"].lstrip("/"))
            try:
                convert(source_path, dest_path)
                manifest[date_str] = {
                    "relativePath": winner["relativePath"],
                    "rating": winner["rating"],
                    "namedPeople": winner["namedPeople"],
                    "smilingCount": winner["smilingCount"],
                }
                print(f"{date_str}: OK <- {winner['relativePath']}")
            except subprocess.CalledProcessError as e:
                print(f"{date_str}: CONVERT FAILED for {source_path}: {e.stderr}", file=sys.stderr)
        else:
            # No photos that day; remove any stale generated file.
            if os.path.exists(dest_path):
                os.remove(dest_path)
            print(f"{date_str}: no photos")
        d += timedelta(days=1)

    manifest_path = os.path.join(OUTPUT_DIR, "manifest.json")
    existing = {}
    if os.path.exists(manifest_path):
        with open(manifest_path) as f:
            existing = json.load(f)
    existing.update(manifest)
    with open(manifest_path, "w") as f:
        json.dump(existing, f, indent=2, sort_keys=True)


if __name__ == "__main__":
    main()
