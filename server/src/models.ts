import type { AllMetadata } from "../apiSpecification.js";

export interface IndexedFileRecord {
  path: string; // relative path using POSIX separators
  directory: string; // parent directory relative to root (empty for root)
  name: string;
  size: number;
  mimeType: string | null;
  dateCreated?: string;
  dateModified?: string;
  metadata: Partial<AllMetadata>;
  lastIndexedAt: string;
}
