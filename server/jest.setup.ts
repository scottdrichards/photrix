import path from "node:path";
import os from "node:os";

// Ensure cache directories are set before any modules import cacheUtils
process.env.ThumbnailCacheDirectory ??= path.join(os.tmpdir(), "photrix-test-thumbs");
process.env.INDEX_DB_PATH ??= path.join(os.tmpdir(), "photrix-test-index.db");
