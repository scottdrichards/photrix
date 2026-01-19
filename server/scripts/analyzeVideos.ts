import Database from 'better-sqlite3';

const dbPath = process.env.INDEX_DB_LOCATION || '//PROXMOX-WINDOWS/cache/data-index.json';
console.log('Opening database:', dbPath);
const db = new Database(dbPath);

// Get video stats
const videos = db.prepare(`
  SELECT 
    COUNT(*) as count,
    SUM(sizeInBytes) as totalBytes,
    SUM(duration) as totalDuration,
    AVG(duration) as avgDuration,
    AVG(sizeInBytes) as avgSize
  FROM files 
  WHERE mimeType LIKE 'video/%'
`).get() as any;

console.log('');
console.log('=== Video Library Stats ===');
console.log('Total videos:', videos.count);
console.log('Total size:', (videos.totalBytes / 1024 / 1024 / 1024).toFixed(2), 'GB');
console.log('Total duration:', (videos.totalDuration / 3600).toFixed(2), 'hours');
console.log('Avg duration:', (videos.avgDuration / 60).toFixed(2), 'minutes');
console.log('Avg file size:', (videos.avgSize / 1024 / 1024).toFixed(2), 'MB');

// Estimate HLS output size
// With cq=28 and fast preset, output is typically 60-80% of original h264
const hlsMultiplier = 0.7;
const estimatedHLSSize = videos.totalBytes * hlsMultiplier;
console.log('');
console.log('=== HLS Estimates (single original-res stream, cq=28) ===');
console.log('Estimated HLS cache size:', (estimatedHLSSize / 1024 / 1024 / 1024).toFixed(2), 'GB');

// Multi-bitrate estimate
const multiBitrateMultiplier = 1.2;
const estimatedMultiBitrate = videos.totalBytes * multiBitrateMultiplier;
console.log('');
console.log('=== Multi-bitrate HLS Estimates (360p + 720p + 1080p) ===');
console.log('Estimated cache size:', (estimatedMultiBitrate / 1024 / 1024 / 1024).toFixed(2), 'GB');

// Get some sample videos to see typical sizes
console.log('');
console.log('=== Top 10 Largest Videos ===');
const samples = db.prepare(`
  SELECT fileName, sizeInBytes, duration, dimensionWidth, dimensionHeight
  FROM files 
  WHERE mimeType LIKE 'video/%' AND duration IS NOT NULL
  ORDER BY sizeInBytes DESC
  LIMIT 10
`).all() as any[];

for (const v of samples) {
  const sizeMB = (v.sizeInBytes / 1024 / 1024).toFixed(1);
  const durMin = (v.duration / 60).toFixed(1);
  const bitrate = ((v.sizeInBytes * 8) / v.duration / 1000000).toFixed(1);
  console.log(`  ${v.fileName}: ${sizeMB}MB, ${durMin}min, ${v.dimensionWidth}x${v.dimensionHeight}, ${bitrate}Mbps`);
}

// Get resolution breakdown
console.log('');
console.log('=== Resolution Breakdown ===');
const resolutions = db.prepare(`
  SELECT 
    CASE 
      WHEN dimensionHeight >= 2160 THEN '4K (2160p+)'
      WHEN dimensionHeight >= 1080 THEN '1080p'
      WHEN dimensionHeight >= 720 THEN '720p'
      WHEN dimensionHeight >= 480 THEN '480p'
      ELSE 'Other'
    END as resolution,
    COUNT(*) as count,
    SUM(sizeInBytes) as totalBytes,
    SUM(duration) as totalDuration
  FROM files 
  WHERE mimeType LIKE 'video/%'
  GROUP BY resolution
  ORDER BY 
    CASE resolution
      WHEN '4K (2160p+)' THEN 1
      WHEN '1080p' THEN 2
      WHEN '720p' THEN 3
      WHEN '480p' THEN 4
      ELSE 5
    END
`).all() as any[];

for (const r of resolutions) {
  const sizeGB = (r.totalBytes / 1024 / 1024 / 1024).toFixed(2);
  const hours = (r.totalDuration / 3600).toFixed(1);
  console.log(`  ${r.resolution}: ${r.count} videos, ${sizeGB}GB, ${hours}h`);
}

db.close();
