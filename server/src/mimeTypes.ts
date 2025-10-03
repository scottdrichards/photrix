import path from "node:path";

const MIME_TYPE_BY_EXTENSION = new Map<string, string>([
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["jpe", "image/jpeg"],
  ["png", "image/png"],
  ["gif", "image/gif"],
  ["bmp", "image/bmp"],
  ["webp", "image/webp"],
  ["avif", "image/avif"],
  ["heic", "image/heic"],
  ["heif", "image/heif"],
  ["tif", "image/tiff"],
  ["tiff", "image/tiff"],
  ["svg", "image/svg+xml"],
  ["ico", "image/x-icon"],
  ["raw", "image/x-raw"],
  ["dng", "image/x-adobe-dng"],
  ["cr2", "image/x-canon-cr2"],
  ["cr3", "image/x-canon-cr3"],
  ["nef", "image/x-nikon-nef"],
  ["arw", "image/x-sony-arw"],
  ["orf", "image/x-olympus-orf"],
  ["raf", "image/x-fujifilm-raf"],
  ["srw", "image/x-samsung-srw"],
  ["rw2", "image/x-panasonic-rw2"],
  ["mov", "video/quicktime"],
  ["qt", "video/quicktime"],
  ["mp4", "video/mp4"],
  ["m4v", "video/x-m4v"],
  ["mkv", "video/x-matroska"],
  ["webm", "video/webm"],
  ["avi", "video/x-msvideo"],
  ["wmv", "video/x-ms-wmv"],
  ["flv", "video/x-flv"],
  ["mpg", "video/mpeg"],
  ["mpeg", "video/mpeg"],
  ["3gp", "video/3gpp"],
  ["3g2", "video/3gpp2"],
  ["ts", "video/mp2t"],
  ["m2ts", "video/mp2t"],
  ["mts", "video/mp2t"],
  ["mp3", "audio/mpeg"],
  ["aac", "audio/aac"],
  ["flac", "audio/flac"],
  ["wav", "audio/wav"],
  ["oga", "audio/ogg"],
  ["ogg", "audio/ogg"],
  ["midi", "audio/midi"],
  ["mid", "audio/midi"],
  ["pdf", "application/pdf"],
  ["json", "application/json"],
  ["txt", "text/plain"],
  ["csv", "text/csv"],
  ["xml", "application/xml"],
  ["zip", "application/zip"],
  ["gz", "application/gzip"],
  ["tar", "application/x-tar"],
  ["rar", "application/vnd.rar"],
  ["7z", "application/x-7z-compressed"],
  ["xz", "application/x-xz"],
  ["html", "text/html"],
  ["htm", "text/html"],
]);

const MULTI_EXTENSION_BY_EXTENSION = new Map<string, string>([
  ["tar.gz", "application/gzip"],
  ["tar.xz", "application/x-xz"],
  ["tar.bz2", "application/x-bzip2"],
]);

export const mimeTypeForFilename = (filename: string): string | null => {
  const baseName = path.basename(filename);
  const lower = baseName.toLowerCase();
  const multiExt = getMultiExtension(lower);
  if (multiExt) {
    const multiType = MULTI_EXTENSION_BY_EXTENSION.get(multiExt);
    if (multiType) {
      return multiType;
    }
  }

  const ext = path.extname(lower).replace(/^\./, "");
  if (!ext) {
    return null;
  }
  return MIME_TYPE_BY_EXTENSION.get(ext) ?? null;
};

const getMultiExtension = (filename: string): string | null => {
  const parts = filename.split(".");
  if (parts.length < 3) {
    return null;
  }
  const lastTwo = parts.slice(-2).join(".");
  if (MULTI_EXTENSION_BY_EXTENSION.has(lastTwo)) {
    return lastTwo;
  }
  return null;
};
