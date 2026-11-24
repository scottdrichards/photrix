/**
 * Rewrites the playlists ffmpeg writes so every entry points back at the
 * files API rather than at a path inside the cache directory.
 *
 * The auth token, when the request carried one, rides along on each rewritten
 * URL so native HLS players (Safari) and any client that can't add an
 * Authorization header can still authenticate the sub-requests.
 */

const tokenSuffix = (token: string | null): string =>
  token ? `&token=${encodeURIComponent(token)}` : "";

/** Prefix that a variant height is appended to, for the master playlist. */
export const variantUrlBase = (subPath: string, token: string | null): string =>
  `/api/files/${encodeURIComponent(subPath)}?representation=hls${tokenSuffix(token)}&variant=`;

/** Prefix that a segment file name is appended to, for a variant playlist. */
export const segmentUrlBase = (subPath: string, variant: string, token: string | null): string =>
  `/api/files/${encodeURIComponent(subPath)}?representation=hls&variant=${variant}${tokenSuffix(token)}&segment=`;

/** Points each `<height>p/playlist.m3u8` line of a master playlist at the API. */
export const rewriteMasterPlaylist = (content: string, baseUrl: string): string =>
  content.replace(/^(\d+)p\/playlist\.m3u8$/gm, (_, variantHeight: string) => `${baseUrl}${variantHeight}`);

/** Points each `segment_NNN.ts` line of a variant playlist at the API. */
export const rewriteVariantPlaylist = (content: string, baseUrl: string): string =>
  content.replace(/^(segment_\d+\.ts)$/gm, (match) => `${baseUrl}${match}`);
