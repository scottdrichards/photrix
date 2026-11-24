/**
 * Deletes the face rows matching `where` and every row keyed by their ids.
 * The side tables go first, since they find their rows through the faces
 * about to be removed. The one place a face is deleted, so a new per-face
 * table can't be orphaned by a delete path that forgot it.
 */
export const deleteFacesStatements = (
  where: string,
  params: unknown[],
): Array<{ sql: string; params: unknown[] }> => [
  ...["faceAppearances", "faceEmbeddings"].map((table) => ({
    sql: `DELETE FROM ${table} WHERE faceId IN (SELECT id FROM faces WHERE ${where})`,
    params,
  })),
  { sql: `DELETE FROM faces WHERE ${where}`, params },
];
