#!/usr/bin/env python3
"""
Pick a weighted-random set of "top photos" from roughly the last year for the
wall-calendar screensaver, reading photrix's local sqlite index directly
(read-only). Models day_photo_pick.py's schema use.

Each candidate image (mimeType LIKE 'image/%', dateTaken within the window) gets
a weight that is the PRODUCT of three tunable factors, so all three matter:

  recency = 1 + REC_STRENGTH * (1 - age_days/window)      # newer heavier
  stars   = 1 + STAR_STRENGTH * rating                     # files.rating 0..5 (unrated=0)
  family  = 1 + FAM_STRENGTH  * namedPeopleCount           # of {Scott,Sarah,Alice,Amelia}

N photos are then drawn WITHOUT replacement by weighted sampling
(Efraimidis-Spirakis: key = random ** (1/weight), take the largest keys), so a
heavier photo is likelier but the mix changes every call. At most one photo per
calendar day is kept (the heaviest), to avoid bursts from a single event.

Strengths are overridable via env (PHOTRIX_SS_REC/STAR/FAM) or query by the
handler re-exporting them, so weights can be tuned without editing code.

Usage: screensaver_pick.py [COUNT] [WINDOW_DAYS]
Prints a single JSON object to stdout.
"""
import sqlite3
import sys
import os
import json
import random
from datetime import datetime, timezone

DB_PATH = os.environ.get("PHOTRIX_INDEX_DB", "/home/dev/photrix/server/.cache/index.db")
TARGET_NAMES = ["Scott", "Sarah", "Alice", "Amelia"]

REC_STRENGTH = float(os.environ.get("PHOTRIX_SS_REC", "2.0"))
STAR_STRENGTH = float(os.environ.get("PHOTRIX_SS_STAR", "1.0"))
FAM_STRENGTH = float(os.environ.get("PHOTRIX_SS_FAM", "1.0"))


def connect():
    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True, timeout=30)
    conn.row_factory = sqlite3.Row
    return conn


def get_target_person_ids(conn):
    ids = {}
    for row in conn.execute("SELECT id, name, personId FROM faceClusters WHERE name IS NOT NULL"):
        name = (row["name"] or "").strip()
        if not name:
            continue
        first = name.split()[0].lower()
        for target in TARGET_NAMES:
            if first == target.lower():
                ids[target] = row["personId"] if row["personId"] is not None else row["id"]
    return ids


def main():
    count = int(sys.argv[1]) if len(sys.argv) > 1 else 60
    window_days = int(sys.argv[2]) if len(sys.argv) > 2 else 365
    count = max(1, min(count, 400))
    window_days = max(1, min(window_days, 3650))

    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    start_ms = now_ms - window_days * 86400_000

    conn = connect()
    target_ids = get_target_person_ids(conn)

    files = conn.execute(
        """
        SELECT folder, fileName, rating, dateTaken
        FROM files
        WHERE dateTaken >= ? AND dateTaken < ?
          AND mimeType LIKE 'image/%'
        """,
        (start_ms, now_ms),
    ).fetchall()

    best_by_day = {}
    for f in files:
        folder, fileName = f["folder"], f["fileName"]
        face_rows = conn.execute(
            """
            SELECT COALESCE(cluster.personId, faces.clusterId) AS personId
            FROM faces
            LEFT JOIN faceClusters AS cluster ON cluster.id = faces.clusterId
            WHERE faces.folder = ? AND faces.fileName = ? AND faces.clusterId > 0
            """,
            (folder, fileName),
        ).fetchall()
        present = set()
        for fr in face_rows:
            for name, pid in target_ids.items():
                if fr["personId"] == pid:
                    present.add(name)

        age_days = (now_ms - f["dateTaken"]) / 86400_000
        age_frac = min(max(age_days / window_days, 0.0), 1.0)
        rating = f["rating"] or 0
        fam = len(present)

        recency = 1.0 + REC_STRENGTH * (1.0 - age_frac)
        stars = 1.0 + STAR_STRENGTH * rating
        family = 1.0 + FAM_STRENGTH * fam
        weight = recency * stars * family

        rel = (folder.rstrip("/") + "/" + fileName) if folder != "/" else "/" + fileName
        day = datetime.fromtimestamp(f["dateTaken"] / 1000, timezone.utc).strftime("%Y-%m-%d")
        cand = {
            "path": rel,
            "date": day,
            "rating": rating,
            "people": sorted(present),
            "weight": round(weight, 3),
        }
        # keep only the heaviest photo per calendar day
        prev = best_by_day.get(day)
        if prev is None or weight > prev["_w"]:
            cand["_w"] = weight
            best_by_day[day] = cand

    candidates = list(best_by_day.values())
    # Efraimidis-Spirakis weighted sampling without replacement
    for c in candidates:
        c["_key"] = random.random() ** (1.0 / c["_w"]) if c["_w"] > 0 else 0.0
    candidates.sort(key=lambda c: c["_key"], reverse=True)
    picked = candidates[:count]
    for c in picked:
        c.pop("_w", None)
        c.pop("_key", None)

    print(json.dumps({
        "count": len(picked),
        "window_days": window_days,
        "weights": {"recency": REC_STRENGTH, "stars": STAR_STRENGTH, "family": FAM_STRENGTH},
        "pool": len(candidates),
        "photos": picked,
    }))


if __name__ == "__main__":
    main()
