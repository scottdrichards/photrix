import path from "node:path";
import os from "node:os";

// The one place tests set the process environment; a test changes config with
// src/config/config.fixture.ts. Keeps every spec off the developer's own database.
process.env.INDEX_DB_LOCATION ??= path.join(os.tmpdir(), "photrix-test-index-db");
