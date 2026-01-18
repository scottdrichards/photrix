/**
 * Normalizes path separators to forward slashes.
 * Windows paths use backslashes, but we want consistent forward slashes in the database.
 */
const normalizePathSeparators = (value: string): string => value.replace(/\\/g, "/");

export const normalizeFolderPath = (value: string): string => {
  const normalized = normalizePathSeparators(value.trim());
  const withLeading = normalized.startsWith("/") ? normalized : `/${normalized}`;
  if (withLeading === "/") {
    return "/";
  }
  return withLeading.endsWith("/") ? withLeading : `${withLeading}/`;
};

/**
 * Splits a relativePath into folder and fileName.
 * Ensures folder always has leading and trailing '/'.
 * Normalizes backslashes to forward slashes for cross-platform compatibility.
 * e.g., "/photos/2024/image.jpg" -> { folder: "/photos/2024/", fileName: "image.jpg" }
 * e.g., "photos\\2024\\image.jpg" -> { folder: "/photos/2024/", fileName: "image.jpg" }
 */
export const splitPath = (relativePath: string): { folder: string; fileName: string } => {
  const normalized = normalizePathSeparators(relativePath.trim());
  const withLeading = normalized.startsWith("/") ? normalized : `/${normalized}`;
  const lastSlash = withLeading.lastIndexOf("/");
  if (lastSlash <= 0) {
    return { folder: "/", fileName: withLeading.slice(lastSlash + 1) || withLeading.slice(1) };
  }
  const folderRaw = withLeading.slice(0, lastSlash + 1);
  const fileName = withLeading.slice(lastSlash + 1);
  return {
    folder: normalizeFolderPath(folderRaw),
    fileName,
  };
};

/**
 * Joins folder and fileName into a relativePath.
 */
export const joinPath = (folder: string, fileName: string): string => {
  return `${normalizeFolderPath(folder)}${fileName}`;
};