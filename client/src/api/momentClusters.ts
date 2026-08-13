import { fetchWithDiagnostics, fetchJsonOrThrow } from "./http";
import { createPhotoItem } from "./photoItem";
import type { ApiPhotoItem, MomentClusterDetail } from "./types";

type ApiMomentClusterMember = {
  path: string;
  fileName: string;
  mimeType: string | null;
  dimensionWidth: number | null;
  dimensionHeight: number | null;
  isRepresentative: boolean;
  sharpnessScore: number | null;
  photoQualityScore: number | null;
};

const toApiPhotoItem = (member: ApiMomentClusterMember): ApiPhotoItem => ({
  folder: member.path.slice(0, member.path.length - member.fileName.length),
  fileName: member.fileName,
  mimeType: member.mimeType,
  dimensionWidth: member.dimensionWidth ?? undefined,
  dimensionHeight: member.dimensionHeight ?? undefined,
});

/**
 * Fetches every member of a moment (burst/near-duplicate) cluster — powers
 * the gallery's "expand this stack" interaction. Mirrors
 * people.ts/fetchClusterDetail's shape for face clusters.
 */
export const fetchMomentClusterDetail = async (
  clusterId: string,
): Promise<MomentClusterDetail | null> => {
  const params = new URLSearchParams();
  params.set("aggregate", "momentClusterDetail");
  params.set("clusterId", clusterId);
  const payload = await fetchJsonOrThrow<{ cluster: { id: string; members: ApiMomentClusterMember[] } | null }>(
    `/api/files/?${params.toString()}`,
    "fetch moment cluster detail",
  );
  if (!payload.cluster) return null;
  return {
    id: payload.cluster.id,
    members: payload.cluster.members.map((member) => ({
      photo: createPhotoItem(toApiPhotoItem(member)),
      isRepresentative: member.isRepresentative,
      sharpnessScore: member.sharpnessScore,
      photoQualityScore: member.photoQualityScore,
    })),
  };
};

/**
 * Persistent representative override: makes `path` the cluster's chosen
 * representative from now on (pinned — the background re-scoring pass never
 * overwrites it again).
 */
export const setMomentClusterRepresentative = async (
  clusterId: string,
  path: string,
): Promise<void> => {
  const response = await fetchWithDiagnostics(
    "/api/moment-clusters/representative",
    "set moment cluster representative",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clusterId, path }),
    },
  );
  if (!response.ok) {
    throw new Error(`Failed to set representative (status ${response.status})`);
  }
};

/**
 * Permanently dissolves a moment cluster: every member goes back to showing
 * individually in the gallery. Distinct from a *temporary* unstack, which is
 * purely client-side and never calls this.
 */
export const dissolveMomentCluster = async (clusterId: string): Promise<void> => {
  const response = await fetchWithDiagnostics(
    "/api/moment-clusters/dissolve",
    "dissolve moment cluster",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clusterId }),
    },
  );
  if (!response.ok) {
    throw new Error(`Failed to dissolve cluster (status ${response.status})`);
  }
};
