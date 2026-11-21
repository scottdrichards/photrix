# stories

Finds the trips and big days in the library and tells each one as a short
cinematic recap (the client's Stories tab, `client/src/components/stories/`).
Everything is derived from data already indexed: capture dates, GPS, faces and
names, CLIP image embeddings, moment (burst) stacks and the photo-quality score.
Nothing is stored; detection is recomputed and cached in memory.

| File                | What it does                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| `detectStories.ts`  | Finds home per year, classifies each day home / away / no GPS, and cuts trips and events          |
| `storyTitle.ts`     | Titles a story from its places (city, then state or country), folder name, people or date         |
| `pickHighlights.ts` | Picks a story's frames: score (stars, quality, named faces) with MMR against CLIP near-duplicates |
| `storyRoute.ts`     | The route between geotagged stops, and the distance covered                                       |
| `storiesService.ts` | Reads the index (`database.stories`), caches detection, builds summaries and details              |
| `storyTypes.ts`     | Types shared with the client (mirrored in `client/src/api/stories.ts`)                            |

## How a story is found

- **Home** is the 0.5° grid cell with the most distinct days of geotagged
  photos, per year, so a move does not turn the new town into one long trip. A
  year with fewer than five such days uses the all-time home.
- **A day is away** when the median distance of its geotagged photos from home
  is over 80 km. A day with no GPS is unknown.
- **A trip** starts on an away day and runs through away and unknown days until
  a home day or a gap of more than two empty days. Unknown days only count when
  another away day follows. Runs over 45 days (a move, a season abroad) and runs
  with too few photos are dropped.
- **An event** is a home or unknown day with far more photos than usual
  (four times the typical day, and at least 8 to 40 by library size). Adjacent
  event days merge.
- Places are named with `places/notablePlaceTextFor`, not the stored
  `placeText`: the nearest city to the Pantheon is Vatican City, the city a
  person would name is Rome.
- Ids are `trip-<start>-<end>` / `event-<start>-<end>` in local calendar days,
  so a story keeps its id as long as its first and last day don't change.

## Cache

`/api/stories` reads every dated row (no BLOBs), so the result is kept until
`MAX(exifProcessedAt)` changes (at most every 30 s while a library is being
indexed) and for no more than 10 minutes, which picks up newly named faces.

## Privacy and shares

The route is `shareLink: "forbidden"`: stories span the whole library. The
owner's default exclusion filter applies to the timeline, as it does in the grid.
