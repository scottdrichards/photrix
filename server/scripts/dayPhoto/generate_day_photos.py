#!/usr/bin/env python3
"""
Generates the "photo of the day" JPEG(s) used as faint calendar-day
backgrounds on the HA Calendar dashboard.

For each day in the given range: picks a representative photo using the
criteria in day_photo_pick.py (rating -> named-family-count -> smiling-count
-> photoQualityScore -> deterministic path sort), converts/resizes it to a
JPEG, and writes it to OUTPUT_DIR/YYYY-MM-DD.jpg.

MAX_DIMENSION is deliberately small: these are painted as day-cell backgrounds
under a 0.7-alpha white veil, so only 30%% of their contrast ever reaches the
screen, and a month view loads ~35 of them at once. 800px still covers a day
cell 1:1 on a 4K wall display (~548x600) with no upscaling, at ~167KB vs the
~452KB the old 1400px cost â ~5.8MB per month view instead of ~15.8MB, which
matters over the T-Mobile uplink when the dashboard is reached via
home.scottdrichards.com. Called on-demand by
dayPhotoRequestHandler.ts (server/src/requestHandlers/dayPhotoRequestHandler.ts).

Never prunes: photrix is the *origin* for these, so a generated JPEG is kept
forever. Regenerating one costs ~9s (sqlite pick + convert), and the HA
Calendar dashboard fetches on-demand for any date the user scrolls to, so an
expiring origin cache made every older month permanently slow enough that the
browser gave up before the image arrived. HA keeps its own ~60-day cache of
these (shell_command.prune_day_photos) — that is the layer that expires.

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
MAX_DIMENSION = 800


def convert(source_path, dest_path):
    subprocess.run(
        [PYTHON, PROCESS_IMAGE, source_path, dest_path, "--max_dimension", str(MAX_DIMENSION)],
        check=True,
        capture_output=True,
        text=True,
    )


def main():
    if len(sys.argv) < 2:
        print("usage: generate_day_photos.py START_DATE [END_DATE]", file=sys.stderr)
        sys.exit(1)
    start = sys.argv[1]
    end = sys.argv[2] if len(sys.argv) > 2 else start

    os.makedirs(OUTPUT_DIR, exist_ok=True)

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
