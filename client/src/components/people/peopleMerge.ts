import type { PersonCluster, PersonClusterWithFaces, PeopleClustersResult } from "../../api";

const sortPeopleClusters = (clusters: PersonCluster[]) =>
  [...clusters].sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));

export const chooseCanonicalMergeTarget = (target: PersonCluster, source: PersonCluster) =>
  target.name == null && source.name != null ? source : target;

export const applyOptimisticClusterMerge = (
  result: PeopleClustersResult | null,
  mergedAwayClusters: PersonCluster[],
  targetCluster: PersonCluster,
): PeopleClustersResult | null => {
  if (!result || mergedAwayClusters.length === 0) return result;

  const sourceIds = new Set(mergedAwayClusters.map((cluster) => cluster.id));
  const addedCount = mergedAwayClusters.reduce((sum, cluster) => sum + cluster.count, 0);
  const nextClusters = result.clusters.flatMap((cluster) => {
    if (sourceIds.has(cluster.id)) return [];
    if (cluster.id !== targetCluster.id) return [cluster];
    return [{ ...cluster, ...targetCluster, count: cluster.count + addedCount }];
  });
  const removedVisibleClusters = result.clusters.length - nextClusters.length;
  const hasVisibleTarget = nextClusters.some((cluster) => cluster.id === targetCluster.id);
  if (!hasVisibleTarget && removedVisibleClusters > 0) {
    nextClusters.push({ ...targetCluster, count: targetCluster.count + addedCount });
  }

  return {
    ...result,
    clusters: sortPeopleClusters(nextClusters),
    totalClusters: Math.max(0, result.totalClusters - mergedAwayClusters.length),
  };
};

export const applyOptimisticDetailMerge = (
  detail: PersonClusterWithFaces,
  sourceCluster: PersonCluster,
): PersonClusterWithFaces => {
  const currentCluster: PersonCluster = {
    id: detail.id,
    count: detail.count,
    representative: detail.representative,
    name: detail.name,
    tags: detail.tags,
  };
  const canonicalTarget = chooseCanonicalMergeTarget(currentCluster, sourceCluster);
  const movedCluster = canonicalTarget.id === currentCluster.id ? sourceCluster : currentCluster;
  const nextCentroids = detail.centroids.some((centroid) => centroid.id === movedCluster.id)
    ? detail.centroids
    : [...detail.centroids, {
        id: movedCluster.id,
        count: movedCluster.count,
        representative: movedCluster.representative,
      }].sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));

  return {
    ...detail,
    id: canonicalTarget.id,
    count: detail.count + sourceCluster.count,
    name: canonicalTarget.name,
    representative: canonicalTarget.representative,
    centroids: nextCentroids,
    mergeSuggestions: detail.mergeSuggestions.filter((cluster) => cluster.id !== sourceCluster.id),
  };
};
