// One-off verification against a copy of the production DB: runs the full
// clustering backfill and times the People queries at full scale.
process.env.INDEX_DB_LOCATION = "/home/dev/photrix/server/.cache/cluster-test";

const { IndexDatabase } = await import("./src/indexDatabase/indexDatabase.ts");

const db = new IndexDatabase("/tmp");
await db.init();

const start = Date.now();
let assigned = 0;
let lastLog = 0;
while (true) {
  const n = await db.clusterPendingFaces(64);
  if (!n) break;
  assigned += n;
  if (assigned - lastLog >= 20000) {
    lastLog = assigned;
    const rate = assigned / ((Date.now() - start) / 1000);
    console.log(
      `assigned=${assigned} rate=${rate.toFixed(0)}/s elapsed=${((Date.now() - start) / 60000).toFixed(1)}min`,
    );
  }
}
console.log(
  `BACKFILL COMPLETE: ${assigned} faces in ${((Date.now() - start) / 60000).toFixed(1)} min`,
);

await db.pruneEmptyFaceClusters();

let t = Date.now();
const result = await db.queryFaceClusters({ filter: {} });
console.log(
  `queryFaceClusters (full): ${Date.now() - t} ms — clusters=${result.totalClusters} faces=${result.totalFaces} pending=${result.pendingFaces}`,
);
console.log(
  "top clusters:",
  result.clusters.slice(0, 8).map((c) => `${c.id}:${c.count}`).join(" "),
);

t = Date.now();
const again = await db.queryFaceClusters({ filter: {} });
console.log(`queryFaceClusters (warm repeat): ${Date.now() - t} ms — clusters=${again.totalClusters}`);

t = Date.now();
const detail = await db.getFaceClusterDetail({
  filter: {},
  clusterId: result.clusters[0]!.id,
});
console.log(
  `getFaceClusterDetail (largest): ${Date.now() - t} ms — faces=${detail.cluster?.faces.length}`,
);
process.exit(0);
