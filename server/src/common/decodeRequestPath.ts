/**
 * Decodes the percent-encoded file path out of a request URL.
 *
 * Clients encode each path segment with `encodeURIComponent`, so characters that
 * are structural in a URL (`#` starts a fragment, `?` starts the query, `%`
 * starts an escape) survive the round trip. Decoding is the mirror of that.
 *
 * `decodeURIComponent` *throws* a URIError on a malformed escape — a bare `%` in
 * a hand-typed, pasted or legacy link, e.g. `/api/files/50% off.jpg`. Left
 * unguarded that throw becomes an opaque 500 (or an unhandled rejection) from
 * whichever handler happened to touch the URL. An undecodable path is far more
 * likely to be a literal `%` in a filename than an attack, so fall back to the
 * raw text and let the usual resolution rules decide: it either names a real
 * file, or it 404s. The traversal guard runs on the decoded result either way,
 * so this can't widen access.
 */
export const decodeRequestPath = (rawPath: string): string => {
  try {
    return decodeURIComponent(rawPath);
  } catch {
    return rawPath;
  }
};
