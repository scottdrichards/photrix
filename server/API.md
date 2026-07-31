# Photrix Server API

## Endpoints

### GET `/health`

Health check endpoint.

**Response:**

```json
{
  "status": "ok",
  "message": "Server is running"
}
```

### GET `/files/count`

Get the total count of indexed files.

**Response:**

```json
{
  "count": 1234
}
```

### GET `/folders` or `/folders/{path}`

Get a list of subfolders at the specified path.

**Path-based queries:**

- `/folders` - Get subfolders at root level
- `/folders/2024` - Get subfolders directly under `2024`
- `/folders/2024/vacation` - Get subfolders directly under `2024/vacation`

**Response:**

```json
{
  "folders": ["subfolder1", "subfolder2", "subfolder3"]
}
```

### GET `/suggestions`

Get distinct text suggestions for searchable metadata fields.

**Query Parameters:**

- `field` (required): one of `personInImage`, `tags`, `aiTags`, `cameraMake`, `cameraModel`, `lens`
- `q` (required): search text (substring match)
- `limit` (optional): max number of suggestions (default: 8, max: 100)
- `path` (optional): folder path scope
- `includeSubfolders` (optional): `true` to include descendants when `path` is provided
- `filter` (optional): JSON-encoded FilterElement for additional constraints

**Response:**

```json
{
  "suggestions": ["Scott", "Scott and Ruby"]
}
```

### GET `/files/{path}` - File Representations

Access files with different representations (thumbnails, previews, HLS streaming).

**Query Parameters:**

- `representation` (optional): `webSafe`, `preview`, or `hls`
- `height` (optional): Target height for resizing (`160`, `320`, `640`, `1080`, `2160`, or `original`)
- `segment` (optional, for HLS only): Name of the HLS segment file to retrieve

**Representations:**

_webSafe_ - Converted to a web-compatible format (JPEG for images, thumbnail for videos):

```bash
curl "http://localhost:3000/api/files/photo.heic?representation=webSafe&height=1080"
curl "http://localhost:3000/api/files/video.mov?representation=webSafe&height=320"
```

_preview_ - Video preview thumbnail:

```bash
curl "http://localhost:3000/api/files/video.mov?representation=preview"
```

_hls_ - HTTP Live Streaming for videos (uses NVIDIA NVENC hardware acceleration):

```bash
# Get HLS playlist (m3u8)
curl "http://localhost:3000/api/files/video.mov?representation=hls&height=1080"

# Get specific segment
curl "http://localhost:3000/api/files/video.mov?representation=hls&height=1080&segment=segment_001.ts"
```

**HLS Response:**

- Playlist request returns `application/vnd.apple.mpegurl` with segment URLs
- Segment request returns `video/mp2t` binary data

### GET `/files` or `/files/{path}/` (with trailing slash)

Query files with filtering, pagination, and metadata selection.

**Path-based filtering:**

- `/files` - Get all files
- `/files/subFolder` - Get files directly in `subFolder` (excludes subfolders)
- `/files/subFolder/nested` - Get files directly in `subFolder/nested` (excludes deeper nesting)

**Query Parameters:**

- `filter` (optional): JSON-encoded FilterElement (overrides path-based filter)
- `metadata` (optional): Comma-separated list or JSON array of metadata fields
- `pageSize` (optional): Items per page (default: 1000)
- `page` (optional): Page number, 1-indexed (default: 1)

**Filter Types:**

_FilterCondition_ - Match specific field values:

```json
{
  "mimeType": "image/jpeg",
  "sizeInBytes": { "min": 1000, "max": 50000 }
}
```

_LogicalFilter_ - Combine multiple conditions:

```json
{
  "operation": "and",
  "conditions": [{ "mimeType": "image/jpeg" }, { "sizeInBytes": { "min": 1000 } }]
}
```

**Response:**

```json
{
  "items": [
    {
      "relativePath": "photo.jpg"
      // ... requested metadata fields
    }
  ],
  "total": 1234, // Total matching items
  "page": 1, // Current page
  "pageSize": 50 // Items per page
}
```

### POST `/faces/identify` — recognize known people in an outside image

Runs the library's InsightFace detector over caller-supplied frames and scores
each detected face against the centroids of people who have been **named** in
the People tab. Nothing is written: the frames are scored and discarded, never
indexed, and the faces never join a cluster.

Intended for live cameras — "who is at the door" — not for library ingestion.

**Auth:** same as every other `/api` route (bearer token or `?token=`). Not
available to scoped share links.

**Request body** — any one of:

| Shape | Use |
|---|---|
| Raw bytes with `Content-Type: image/*` | One image you already have in hand |
| `{"imageUrl": "http://..."}` | One frame the server should fetch |
| `{"imageUrls": [...]}` | Up to 6 frames (see *Why several frames* below) |
| `{"imageBase64": "..."}` | One inline image |

Fetched URLs must resolve to a private/LAN address — this is a camera-frame
fetcher, not an open proxy.

Each `imageUrls` entry is either a URL string or an object:

```json
{
  "url": "http://192.168.1.225:5000/api/doorbell/recordings/1785160322/snapshot.jpg",
  "box": [0.53, 0.48, 0.12, 0.45],
  "pad": 0.4
}
```

`box` is a normalized `[x, y, width, height]` region to crop to before
detection, and `pad` (default `0.3`) widens it by that fraction of its own size.

**Query parameters** (all optional; every default is documented with the
measurement behind it in `src/faceDetection/identifyFaces.ts`):

- `strongThreshold` (default `0.3`) — similarity that stands alone, no margin needed.
- `threshold` (default `0.2`) — similarity floor for the moderate tier.
- `minMargin` (default `0.05`) — margin required in the moderate tier.
- `minFaceConfidence` (default `0.6`) — detector `det_score` floor.
- `minFacePixels` (default `32`) — smallest face worth scoring.

A name is reported when `similarity >= strongThreshold`, **or**
`similarity >= threshold AND margin >= minMargin`.

**Response:**

```json
{
  "faceCount": 1,
  "people": ["Scott Douglas Richards"],
  "topPerson": "Scott Douglas Richards",
  "matches": [
    { "name": "Scott Douglas Richards", "similarity": 0.364, "margin": 0.086, "frame": 2 }
  ],
  "faces": [
    {
      "box": { "x": 0.31, "y": 0.12, "width": 0.15, "height": 0.24 },
      "confidence": 0.82,
      "name": "Scott Douglas Richards",
      "similarity": 0.364,
      "margin": 0.086,
      "rejectedFor": null,
      "facePixels": { "width": 180, "height": 290 },
      "candidates": [{ "name": "...", "similarity": 0.278, "clusterId": 713 }]
    }
  ],
  "framesSubmitted": 4,
  "framesAnalyzed": 3,
  "frames": [{ "frame": 0, "faces": 0 }, { "frame": 1, "faces": 1 }],
  "knownPeople": 28,
  "elapsedMs": 2140
}
```

A frame with nobody recognizable answers `200` with `faceCount: 0` and an empty
`people` — that is the expected case for an outdoor camera, not an error, so
callers can treat it as ordinary flow control. `rejectedFor` says which gate
turned a face away (`threshold`, `margin`, `tooSmall`) so a near miss can be
logged and the thresholds tuned against real footage.

Face boxes are normalized against the image as analyzed — i.e. against the
*crop* when a `box` was supplied. The crop rect is reported per frame in
`frames[].crop` so original-frame coordinates can be recovered.

#### Why several frames, and why crop

Both of these come from measuring real doorbell footage rather than from theory:

- **Most single frames of a real visit contain no usable face.** Person
  detection fires on backs, turned heads and umbrellas. Sampling a handful of
  moments across one event and keeping the best answer is what makes this
  reliable. Frames are walked in order and the walk stops at the first
  confident match, so the easy case still costs one detector pass.
- **Resolution alone does not help; cropping does.** The detector runs at
  640x640, so a 2560x1920 frame is downscaled and a distant face vanishes. The
  same frame cropped to the person keeps the pixels: measured on this camera,
  the uncropped full-resolution frame produced **0** detections while the
  cropped one produced a **180x290px** face.
- **Two gates, because neither works alone.** Cross-domain pairs (outdoor
  camera vs. phone photos) score far below the 0.62 the clustering path uses.
  Measured: a correct close-up match scored 0.381 similarity but only 0.034
  margin (its runner-up was a relative) — a margin-only rule rejects the right
  answer. A stranger scored 0.192 with a healthy 0.075 margin — a margin-only
  rule accepts them. A 6x9-pixel junk detection scored 0.252 with 0.006 margin —
  a similarity-only rule accepts it. Hence the strong-or-(moderate-and-clear)
  rule above, which classifies every measured sample correctly.

#### Why this endpoint takes a foreground worker lease

`analyzeImage` is called with `foreground: true`, which matters more than it
looks. The orchestrator SIGSTOPs any worker without a lease while a user request
is in flight, and `reclaimGpuForUser()` SIGKILLs any unleased worker when a video
transcode starts; both skip leased workers. Since this endpoint is itself
bracketed as user activity, without the lease it suspends the very worker it is
waiting on — measured at **304s** per call, versus **3s** with the lease.

### GET `/faces/people`

Names that `/faces/identify` can return, and how many centroids back them.

```json
{ "people": ["Alice Diane Richards", "..."], "centroids": 248 }
```

## Examples

### Get all files with basic metadata

```bash
curl "http://localhost:3000/files?metadata=relativePath,mimeType,sizeInBytes"
```

### Get folders at root level

```bash
curl "http://localhost:3000/folders"
```

### Get subfolders within a specific path

```bash
# Get folders directly under "2024"
curl "http://localhost:3000/folders/2024"

# Get folders under "vacation/photos"
curl "http://localhost:3000/folders/vacation/photos"
```

### Get files in a specific folder (path-based, excludes subfolders)

```bash
# Files directly in subFolder (no subfolders)
curl "http://localhost:3000/files/subFolder?metadata=relativePath,mimeType"

# Files directly in subFolder/nested (no deeper nesting)
curl "http://localhost:3000/files/subFolder/nested?metadata=relativePath,sizeInBytes"
```

### Get files with explicit filter (overrides path)

```bash
# Get all JPEG images
filter='{"mimeType":"image/jpeg"}'
curl "http://localhost:3000/files?filter=$(echo $filter | jq -sRr @uri)&metadata=sizeInBytes,created,modified&pageSize=50&page=1"
```

### Complex query with AND/OR logic

```bash
filter='{"operation":"or","conditions":[{"mimeType":"image/jpeg"},{"mimeType":"image/png"}]}'
curl "http://localhost:3000/files?filter=$(echo $filter | jq -sRr @uri)&metadata=mimeType,sizeInBytes,created&pageSize=25&page=2"
```

### Partial search by person name

```bash
filter='{"personInImage":{"includes":"Scott"}}'
metadata='fileName,personInImage,regions'
curl "http://localhost:3000/files?filter=$(echo $filter | jq -sRr @uri)&metadata=$metadata&pageSize=25&page=1"
```

### Get people suggestions for typeahead

```bash
curl "http://localhost:3000/api/suggestions?field=personInImage&q=sco&limit=8"
```

### Get files with EXIF metadata

```bash
filter='{"mimeType":"image/jpeg"}'
metadata='cameraMake,cameraModel,fNumber,iso,dateTaken'
curl "http://localhost:3000/files?filter=$(echo $filter | jq -sRr @uri)&metadata=$metadata&pageSize=10&page=1"
```

### Pagination example

```bash
# First page
curl "http://localhost:3000/files/subFolder?metadata=relativePath&pageSize=10&page=1"

# Second page
curl "http://localhost:3000/files/subFolder?metadata=relativePath&pageSize=10&page=2"
```

### JavaScript/TypeScript Example

```javascript
// Simple - get all files
const response = await fetch(
  "http://localhost:3000/files?metadata=relativePath,mimeType",
);
const data = await response.json();
console.log(`Found ${data.total} files:`, data.items);

// Path-based - files in a specific folder
const folderResponse = await fetch(
  "http://localhost:3000/files/subFolder?metadata=relativePath,sizeInBytes",
);
const folderData = await folderResponse.json();
console.log(`Files in subFolder: ${folderData.total}`, folderData.items);

// With explicit filter
const filter = { mimeType: "image/jpeg" };
const metadata = ["sizeInBytes", "created", "modified"];
const params = new URLSearchParams({
  filter: JSON.stringify(filter),
  metadata: metadata.join(","),
  pageSize: "50",
  page: "1",
});
const filteredResponse = await fetch(`http://localhost:3000/files?${params}`);
const filteredData = await filteredResponse.json();
console.log(filteredData);
```

## Available Metadata Fields

**Basic File Info:**

- `relativePath` (always included)
- `mimeType`
- `sizeInBytes`
- `created`
- `modified`

**EXIF Metadata:**

- `cameraMake`
- `cameraModel`
- `lensMake`
- `lensModel`
- `fNumber`
- `focalLength`
- `iso`
- `exposureTime`
- `dateTaken`
- `latitude`
- `longitude`
- `personInImage`
- `regions`

**AI Metadata:**

- `labels`
- `text`

## Environment

- `HLS_ENCODE_VERBOSE` (optional): set to `1` to enable verbose HLS encoding logs (`[hls-encode]` and `[HLS-ABR]` per-file/per-variant details). By default, routine per-item logs are suppressed and only key progress/errors are logged.

## Error Responses

**400 Bad Request:**

```json
{
  "error": "Missing required field: filter"
}
```

**404 Not Found:**

```json
{
  "error": "Not found"
}
```

**500 Internal Server Error:**

```json
{
  "error": "Internal server error",
  "message": "Detailed error message"
}
```
