import path from 'node:path';
import fs from 'node:fs/promises';
import { exec } from 'node:child_process';
import sharp from 'sharp';
import { NOT_HANDLED, type MediaRequestHandler } from './types.ts';
import { rootDir, mediaCacheDir } from '../config.ts';
import { videoExtensions } from './imageCommon.ts';

export const videoThumbnailHandler: MediaRequestHandler = async (ctx) => {
    const { relativePath, width } = ctx;
    const ext = path.extname(relativePath).toLowerCase();
    if (!videoExtensions.includes(ext as any)) return NOT_HANDLED;

    // Only serve thumbnails; full video via DASH or static fallback
    const fullPath = path.join(rootDir, relativePath);
    const thumbWidth = width || 480;
    const cacheFileDir = path.join(mediaCacheDir, path.dirname(relativePath));
    const baseName = path.basename(relativePath);
    const cacheBase = `${baseName}.thumb-${thumbWidth}.webp`;
    const cachePath = path.join(cacheFileDir, cacheBase);

    try {
      const file = await fs.readFile(cachePath);
      ctx.res.writeHead(200, { 'Content-Type': 'image/webp' });
      ctx.res.end(file);
      return;
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
    }

    await fs.mkdir(cacheFileDir, { recursive: true });
    const tempPng = path.join(cacheFileDir, `${baseName}.thumb-${thumbWidth}.tmp.png`);
    const timeSeek = '5';
    const ffmpegArgs = [
      'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
      '-ss', timeSeek,
      '-i', fullPath,
      '-vframes', '1',
      '-vf', `scale=${thumbWidth}:-1:flags=fast_bilinear`,
      tempPng
    ];

    await new Promise<void>((resolve, reject) => {
      const cmd = ffmpegArgs.map(a => a.includes(' ') ? `"${a}"` : a).join(' ');
      exec(cmd, (error, _stdout, stderr) => {
        if (error) {
          console.error('[VideoThumb] ffmpeg error:', stderr);
          reject(error);
        } else resolve();
      });
    });

    try {
      const pngData = await fs.readFile(tempPng);
      const webp = await sharp(pngData).toFormat('webp').toBuffer();
      await fs.writeFile(cachePath, webp);
      fs.unlink(tempPng).catch(()=>{});
      ctx.res.writeHead(200, { 'Content-Type': 'image/webp' });
      ctx.res.end(webp);
      return;
    } catch (err) {
      console.error('[VideoThumb] Failed creating thumbnail', err);
      throw err;
    }
};
