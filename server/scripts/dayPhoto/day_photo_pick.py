#!/usr/bin/env python3
"""
Pick a "representative photo of the day" for each day in a date range,
using photrix's local sqlite index directly (read-only).

Selection criteria (in order, each breaking ties from the previous):
  1. Highest star rating (files.rating; unrated treated as 0)
  2. Most of {Scott, Sarah, Alice, Amelia} present (distinct named people, by
     face-cluster identity)
  3. Most faces smiling (smileScore >= 0.5, photrix's own threshold)
  4. Highest photoQualityScore (worst-face-wins quality aggregate)
  5. Deterministic fallback: folder/fileName sort

Only considers images (mimeType LIKE 'image/%'), not videos.

Usage: day_photo_pick.py 2026-08-01 2026-08-03
       day_photo_pick.py 2026-08-01   (single day)
Prints one JSON line per day to stdout.
"""
import sqlite3
import sys
import json
from datetime import datetime, timedelta, timezone

DB_PATH = "/home/dev/photrix/server/.cache/index.db"
TARGET_NAMES = ["Scott", "Sarah", "Alice", "Amelia"]
SMILE_THRESHOLD = 0.5


def connect():
    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True, timeout=30)
    conn.row_factory = sqlite3.Row
    return conn


def get_target_person_ids(conn):
    """Canonical (COALESCE(personId, id)) faceClusters identity for each of our
    four named people, matched on first name (case-insensitive)."""
    q = """
        SELECT id, name, personId FROM faceClusters
        WHERE name IS NOT NULL
    """
    ids = {}
    for row in conn.execute(q):
        first_token = row["name"].strip().split()[0].lower() if row["name"].strip() else ""
        for target in TARGET_NAMES:
            if first_token == target.lower():
                ids[target] = row["personId"] if row["personId"] is not None else row["id"]
    return ids


def day_bounds_ms(date_str):
    d = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    start = int(d.timestamp() * 1000)
    end = int((d + timedelta(days=1)).timestamp() * 1000)
    return start, end


def pick_for_day(conn, date_str, target_person_ids):
    start_ms, end_ms = day_bounds_ms(date_str)

    files = conn.execute(
        """
        SELECT folder, fileName, rating, photoQualityScore
        FROM files
        WHERE dateTaken >= ? AND dateTaken < ?
          AND mimeType LIKE 'image/%'
        """,
        (start_ms, end_ms),
    ).fetchall()

    if not files:
        return None

    candidates = []
    for f in files:
        folder, fileName = f["folder"], f["fileName"]

        face_rows = conn.execute(
            """
            SELECT COALESCE(cluster.personId, faces.clusterId) AS personId,
                   faces.smileScore
            FROM faces
            LEFT JOIN faceClusters AS cluster ON cluster.id = faces.clusterId
            WHERE faces.folder = ? AND faces.fileName = ? AND faces.clusterId > 0
            """,
            (folder, fileName),
        ).fetchall()

        present_targets = set()
        for fr in face_rows:
            for name, pid in target_person_ids.items():
                if fr["personId"] == pid:
                    present_targets.add(name)

        smiling_count = sum(
            1 for fr in face_rows if fr["smileScore"] is not None and fr["smileScore"] >= SMILE_THRESHOLD
        )

        candidates.append(
            {
                "folder": folder,
                "fileName": fileName,
                "relativePath": (folder.rstrip("/") + "/" + fileName) if folder != "/" else "/" + fileName,
                "rating": f["rating"] or 0,
                "namedPeopleCount": len(present_targets),
                "namedPeople": sorted(present_targets),
                "smilingCount": smiling_count,
                "photoQualityScore": f["photoQualityScore"] if f["photoQualityScore"] is not None else -1,
            }
        )

    candidates.sort(
        key=lambda c: (
            c["rating"],
            c["namedPeopleCount"],
            c["smilingCount"],
            c["photoQualityScore"],
        ),
        reverse=True,
    )
    # deterministic final tiebreak
    top_score = tuple(candidates[0][k] for k in ("rating", "namedPeopleCount", "smilingCount", "photoQualityScore"))
    tied = [
        c
        for c in candidates
        if tuple(c[k] for k in ("rating", "namedPeopleCount", "smilingCount", "photoQualityScore")) == top_score
    ]
    tied.sort(key=lambda c: (c["folder"], c["fileName"]))
    winner = tied[0]
    winner["date"] = date_str
    winner["candidateCount"] = len(candidates)
    return winner


def main():
    if len(sys.argv) < 2:
        print("usage: day_photo_pick.py START_DATE [END_DATE]", file=sys.stderr)
        sys.exit(1)
    start = sys.argv[1]
    end = sys.argv[2] if len(sys.argv) > 2 else start

    conn = connect()
    target_person_ids = get_target_person_ids(conn)

    d = datetime.strptime(start, "%Y-%m-%d")
    end_d = datetime.strptime(end, "%Y-%m-%d")
    while d <= end_d:
        date_str = d.strftime("%Y-%m-%d")
        result = pick_for_day(conn, date_str, target_person_ids)
        if result:
            print(json.dumps(result))
        else:
            print(json.dumps({"date": date_str, "winner": None}))
        d += timedelta(days=1)


if __name__ == "__main__":
    main()
