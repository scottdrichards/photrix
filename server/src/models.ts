// Re-export everything from indexDatabase for backward compatibility
export type {
  IndexFileRecord,
  DiscoveredFileRecord,
  FileInfoRecord,
  FullFileRecord,
} from "./indexDatabase.js";

export {
  isDiscoveredRecord,
  isFileInfoRecord,
  isFullFileRecord,
} from "./indexDatabase.js";

// Backward compatibility alias
export type { IndexFileRecord as IndexedFileRecord } from "./indexDatabase.js";
