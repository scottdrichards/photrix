import { rootDir } from "config";
import { webpCachePath } from "fileGenerators/webpCachePath";
import path from 'node:path';
import fs from 'node:fs/promises';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import type { FileGeneratorType } from './FileGeneratorType';

// Single-shot ffmpeg frame extraction (at 5s) then derive all requested widths via sharp.
// If only one width requested and generated freshly, return its Buffer to match FileGeneratorType contract.
export const videoToThumbnails = (async ({ inputPathRelative, widths }) => {
  if (!widths?.length) return; // nothing requested

  // Track which outputs already exist
  const existing = await Promise.all(widths.map(async (width: number) => {
    const outPath = webpCachePath(inputPathRelative, { width });
    const exists = await fs.access(outPath).then(()=>true).catch(()=>false);
    return { width, outPath, exists };
  }));

  if (existing.every(e => e.exists)) return; // all done

  const fullInputPath = path.join(rootDir, inputPathRelative);
  await fs.mkdir(path.dirname(existing[0].outPath), { recursive: true });

  const timeSeekSeconds = 5; // TODO: make configurable
  // To avoid extracting a huge frame, scale to the maximum requested width once, then downscale in sharp for smaller widths.
  const maxWidth = Math.max(...widths);
  const ffmpegArgs = [
    '-hide_banner', '-loglevel', 'error',
    '-ss', String(timeSeekSeconds),
    '-i', fullInputPath,
    '-vframes', '1',
    '-vf', `scale=${maxWidth}:-1:flags=fast_bilinear`,
    '-f', 'image2pipe',
    '-vcodec', 'png',
    'pipe:1'
  ];

  const command = ['ffmpeg', ...ffmpegArgs].map(arg => arg.includes(' ') ? `"${arg}"` : arg).join(' ');
  const { stdout } = await promisify(exec)(command, { encoding: 'buffer', maxBuffer: 50 * 1024 * 1024 });
  const pngBuffer = stdout as Buffer;

  const base = sharp(pngBuffer); // already scaled to maxWidth

  const newlyGenerated = await Promise.all(
    existing
      .filter(({ exists }) => !exists)
      .map(async ({ width, outPath }) => {
        const pipeline = width === maxWidth ? base.clone() : base.clone().resize({ width });
        const webp = await pipeline.toFormat('webp').toBuffer();
        await fs.writeFile(outPath, webp).catch(e => { if (e.code !== 'EEXIST') throw e; });
        return { width, buffer: webp };
      })
  );

  if (widths.length === 1) {
    // If the sole requested width already existed we returned earlier; here we can safely return buffer of the new file
    return newlyGenerated[0]?.buffer;
  }
}) satisfies FileGeneratorType;

