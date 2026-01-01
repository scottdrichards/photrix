export const normalizeFolderPath = (value: string): string => {
  const trimmed = value.trim();
  const withLeading = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (withLeading === "/") {
    return "/";
  }
  return withLeading.endsWith("/") ? withLeading : `${withLeading}/`;
};

/**
 * Splits a relativePath into folder and fileName.
 * Ensures folder always has leading and trailing '/'.
 * e.g., "/photos/2024/image.jpg" -> { folder: "/photos/2024/", fileName: "image.jpg" }
 */
export const splitPath = (relativePath: string): { folder: string; fileName: string } => {
  const trimmed = relativePath.trim();
  const withLeading = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
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