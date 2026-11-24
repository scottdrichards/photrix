/** A person's public id is their face cluster's numeric id as "person-<n>". */
export const faceClusterIdToString = (clusterId: number): string => `person-${clusterId}`;

/** The numeric face cluster id inside "person-<n>", or null for anything else. */
export const faceClusterIdFromString = (clusterId: string): number | null => {
  const match = /^person-(\d+)$/.exec(clusterId);
  if (!match) return null;
  return Number(match[1]);
};
