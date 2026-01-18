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

### GET `/files/{path}` - File Representations

Access files with different representations (thumbnails, previews, HLS streaming).

**Query Parameters:**
- `representation` (optional): `webSafe`, `preview`, or `hls`
- `height` (optional): Target height for resizing (`160`, `320`, `640`, `1080`, `2160`, or `original`)
- `segment` (optional, for HLS only): Name of the HLS segment file to retrieve

**Representations:**

*webSafe* - Converted to a web-compatible format (JPEG for images, thumbnail for videos):
```bash
curl "http://localhost:3000/api/files/photo.heic?representation=webSafe&height=1080"
curl "http://localhost:3000/api/files/video.mov?representation=webSafe&height=320"
```

*preview* - Video preview thumbnail:
```bash
curl "http://localhost:3000/api/files/video.mov?representation=preview"
```

*hls* - HTTP Live Streaming for videos (uses NVIDIA NVENC hardware acceleration):
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

*FilterCondition* - Match specific field values:
```json
{
  "mimeType": "image/jpeg",
  "sizeInBytes": { "min": 1000, "max": 50000 }
}
```

*LogicalFilter* - Combine multiple conditions:
```json
{
  "operation": "and",
  "conditions": [
    { "mimeType": "image/jpeg" },
    { "sizeInBytes": { "min": 1000 } }
  ]
}
```

**Response:**
```json
{
  "items": [
    {
      "relativePath": "photo.jpg",
      // ... requested metadata fields
    }
  ],
  "total": 1234,        // Total matching items
  "page": 1,            // Current page
  "pageSize": 50        // Items per page
}
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
const response = await fetch("http://localhost:3000/files?metadata=relativePath,mimeType");
const data = await response.json();
console.log(`Found ${data.total} files:`, data.items);

// Path-based - files in a specific folder
const folderResponse = await fetch("http://localhost:3000/files/subFolder?metadata=relativePath,sizeInBytes");
const folderData = await folderResponse.json();
console.log(`Files in subFolder: ${folderData.total}`, folderData.items);

// With explicit filter
const filter = { mimeType: "image/jpeg" };
const metadata = ["sizeInBytes", "created", "modified"];
const params = new URLSearchParams({
  filter: JSON.stringify(filter),
  metadata: metadata.join(","),
  pageSize: "50",
  page: "1"
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

**AI Metadata:**
- `labels`
- `faces`
- `text`

**Face Metadata:**
- `faceCount`
- `faceNames`

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
