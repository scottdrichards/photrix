import type { AsyncSqlite } from "../../common/asyncSqlite.ts";
import type { FaceClusterEngine } from "./faceClusterEngine.ts";
import { FaceClusterLayout } from "./faceClusterLayout.ts";
import { PeopleQueries } from "./peopleQueries.ts";
import { FaceClusterEdits } from "./faceClusterEdits.ts";
import { FaceClusterReviewStore } from "./faceClusterReviewStore.ts";
import { FaceClusterCaps } from "./faceClusterCaps.ts";

/**
 * People as clusters of faces, as `database.faceClusters`. A facade: each
 * method forwards to the store that owns it, so callers and mocks see one
 * object. The parts share one FaceClusterLayout, whose caches every write
 * invalidates.
 *
 * - FaceClusterLayout: the 3D layout and merge suggestions (faceClusterLayout.ts)
 * - PeopleQueries: the People list and a person's page (peopleQueries.ts)
 * - FaceClusterEdits: clustering the backlog, rename, merge, separate, tags
 * - FaceClusterReviewStore: review, verdicts, the cut line, the optimiser
 * - FaceClusterCaps: refit, shrink, grow, start a cluster, assign a face
 */
export class FaceClusterStore {
  private readonly layout: FaceClusterLayout;
  private readonly queries: PeopleQueries;
  private readonly edits: FaceClusterEdits;
  private readonly review: FaceClusterReviewStore;
  private readonly caps: FaceClusterCaps;

  constructor(
    db: AsyncSqlite,
    faceClusters: FaceClusterEngine,
    // Kept for the constructor's signature; nothing here calls it.
    private readonly invalidateStatusCountsCache: () => void,
  ) {
    this.layout = new FaceClusterLayout(db);
    this.queries = new PeopleQueries(db, this.layout);
    this.edits = new FaceClusterEdits(db, faceClusters, this.layout);
    this.review = new FaceClusterReviewStore(db, faceClusters, this.layout);
    this.caps = new FaceClusterCaps(db, faceClusters, this.layout, this.review, this.edits);
  }

  warmPCACache(...args: Parameters<FaceClusterLayout["warmPCACache"]>): ReturnType<FaceClusterLayout["warmPCACache"]> {
    return this.layout.warmPCACache(...args);
  }
  queryFaceClusters(...args: Parameters<PeopleQueries["queryFaceClusters"]>): ReturnType<PeopleQueries["queryFaceClusters"]> {
    return this.queries.queryFaceClusters(...args);
  }
  getFaceClusterDetail(...args: Parameters<PeopleQueries["getFaceClusterDetail"]>): ReturnType<PeopleQueries["getFaceClusterDetail"]> {
    return this.queries.getFaceClusterDetail(...args);
  }
  getFaceClustersPCA(...args: Parameters<FaceClusterLayout["getFaceClustersPCA"]>): ReturnType<FaceClusterLayout["getFaceClustersPCA"]> {
    return this.layout.getFaceClustersPCA(...args);
  }
  invalidateFaceClusterPCACache(...args: Parameters<FaceClusterLayout["invalidateFaceClusterPCACache"]>): ReturnType<FaceClusterLayout["invalidateFaceClusterPCACache"]> {
    return this.layout.invalidateFaceClusterPCACache(...args);
  }
  computePCACache(...args: Parameters<FaceClusterLayout["computePCACache"]>): ReturnType<FaceClusterLayout["computePCACache"]> {
    return this.layout.computePCACache(...args);
  }
  clusterPendingFaces(...args: Parameters<FaceClusterEdits["clusterPendingFaces"]>): ReturnType<FaceClusterEdits["clusterPendingFaces"]> {
    return this.edits.clusterPendingFaces(...args);
  }
  pruneEmptyFaceClusters(...args: Parameters<FaceClusterEdits["pruneEmptyFaceClusters"]>): ReturnType<FaceClusterEdits["pruneEmptyFaceClusters"]> {
    return this.edits.pruneEmptyFaceClusters(...args);
  }
  purgeLowConfidenceFaceClusters(...args: Parameters<FaceClusterEdits["purgeLowConfidenceFaceClusters"]>): ReturnType<FaceClusterEdits["purgeLowConfidenceFaceClusters"]> {
    return this.edits.purgeLowConfidenceFaceClusters(...args);
  }
  rescoreMergedClusterSimilarities(...args: Parameters<FaceClusterEdits["rescoreMergedClusterSimilarities"]>): ReturnType<FaceClusterEdits["rescoreMergedClusterSimilarities"]> {
    return this.edits.rescoreMergedClusterSimilarities(...args);
  }
  refreshStaleClusterSimilarities(...args: Parameters<FaceClusterEdits["refreshStaleClusterSimilarities"]>): ReturnType<FaceClusterEdits["refreshStaleClusterSimilarities"]> {
    return this.edits.refreshStaleClusterSimilarities(...args);
  }
  renameCluster(...args: Parameters<FaceClusterEdits["renameCluster"]>): ReturnType<FaceClusterEdits["renameCluster"]> {
    return this.edits.renameCluster(...args);
  }
  mergeClusters(...args: Parameters<FaceClusterEdits["mergeClusters"]>): ReturnType<FaceClusterEdits["mergeClusters"]> {
    return this.edits.mergeClusters(...args);
  }
  separateCluster(...args: Parameters<FaceClusterEdits["separateCluster"]>): ReturnType<FaceClusterEdits["separateCluster"]> {
    return this.edits.separateCluster(...args);
  }
  setClusterTags(...args: Parameters<FaceClusterEdits["setClusterTags"]>): ReturnType<FaceClusterEdits["setClusterTags"]> {
    return this.edits.setClusterTags(...args);
  }
  getAllPersonTags(...args: Parameters<PeopleQueries["getAllPersonTags"]>): ReturnType<PeopleQueries["getAllPersonTags"]> {
    return this.queries.getAllPersonTags(...args);
  }
  excludeFaceFromCluster(...args: Parameters<FaceClusterReviewStore["excludeFaceFromCluster"]>): ReturnType<FaceClusterReviewStore["excludeFaceFromCluster"]> {
    return this.review.excludeFaceFromCluster(...args);
  }
  getNamedFaceCentroids(...args: Parameters<PeopleQueries["getNamedFaceCentroids"]>): ReturnType<PeopleQueries["getNamedFaceCentroids"]> {
    return this.queries.getNamedFaceCentroids(...args);
  }
  getFaceClusteringProgress(...args: Parameters<PeopleQueries["getFaceClusteringProgress"]>): ReturnType<PeopleQueries["getFaceClusteringProgress"]> {
    return this.queries.getFaceClusteringProgress(...args);
  }
  getFaceClusterReview(...args: Parameters<FaceClusterReviewStore["getFaceClusterReview"]>): ReturnType<FaceClusterReviewStore["getFaceClusterReview"]> {
    return this.review.getFaceClusterReview(...args);
  }
  applyFaceClusterCutoff(...args: Parameters<FaceClusterReviewStore["applyFaceClusterCutoff"]>): ReturnType<FaceClusterReviewStore["applyFaceClusterCutoff"]> {
    return this.review.applyFaceClusterCutoff(...args);
  }
  clearFaceClusterRadius(...args: Parameters<FaceClusterReviewStore["clearFaceClusterRadius"]>): ReturnType<FaceClusterReviewStore["clearFaceClusterRadius"]> {
    return this.review.clearFaceClusterRadius(...args);
  }
  setFaceVerdicts(...args: Parameters<FaceClusterReviewStore["setFaceVerdicts"]>): ReturnType<FaceClusterReviewStore["setFaceVerdicts"]> {
    return this.review.setFaceVerdicts(...args);
  }
  resetFaceClusterAssignments(...args: Parameters<FaceClusterReviewStore["resetFaceClusterAssignments"]>): ReturnType<FaceClusterReviewStore["resetFaceClusterAssignments"]> {
    return this.review.resetFaceClusterAssignments(...args);
  }
  reapplyFaceVerdicts(...args: Parameters<FaceClusterReviewStore["reapplyFaceVerdicts"]>): ReturnType<FaceClusterReviewStore["reapplyFaceVerdicts"]> {
    return this.review.reapplyFaceVerdicts(...args);
  }
  planFaceClusterOptimization(...args: Parameters<FaceClusterReviewStore["planFaceClusterOptimization"]>): ReturnType<FaceClusterReviewStore["planFaceClusterOptimization"]> {
    return this.review.planFaceClusterOptimization(...args);
  }
  refitFaceCluster(...args: Parameters<FaceClusterCaps["refitFaceCluster"]>): ReturnType<FaceClusterCaps["refitFaceCluster"]> {
    return this.caps.refitFaceCluster(...args);
  }
  shrinkToExcludeFace(...args: Parameters<FaceClusterCaps["shrinkToExcludeFace"]>): ReturnType<FaceClusterCaps["shrinkToExcludeFace"]> {
    return this.caps.shrinkToExcludeFace(...args);
  }
  growToIncludeFace(...args: Parameters<FaceClusterCaps["growToIncludeFace"]>): ReturnType<FaceClusterCaps["growToIncludeFace"]> {
    return this.caps.growToIncludeFace(...args);
  }
  startClusterForFace(...args: Parameters<FaceClusterCaps["startClusterForFace"]>): ReturnType<FaceClusterCaps["startClusterForFace"]> {
    return this.caps.startClusterForFace(...args);
  }
  assignFaceToPerson(...args: Parameters<FaceClusterCaps["assignFaceToPerson"]>): ReturnType<FaceClusterCaps["assignFaceToPerson"]> {
    return this.caps.assignFaceToPerson(...args);
  }
}
