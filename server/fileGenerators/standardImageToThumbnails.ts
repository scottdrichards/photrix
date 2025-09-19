import { rootDir } from "config";
import { webpCachePath } from "fileGenerators/webpCachePath";
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { FileGeneratorType } from "./FileGeneratorType";

export const standardImageToThumbnails = (async ({inputPathRelative, widths}) => {

  // No widths specified, just create a full image WebP
  if (!widths || widths.length === 0) {
    const thumbPath = webpCachePath(inputPathRelative, {});
    try {
      await fs.access( thumbPath );
      return;
    } catch {}
    const outDir = thumbPath;
    await fs.mkdir(path.dirname(outDir), { recursive: true });
    const fullInputPath = path.join(rootDir, inputPathRelative);
    const file = await fs.readFile(fullInputPath);
    const thumbnail = await sharp(file).rotate().toFormat('webp').toBuffer();
    await fs.writeFile(thumbPath, thumbnail, { flag: 'wx' }).catch(e=>{
      if (e.code !== 'EEXIST'){
        throw e
      };
    });
    return thumbnail;
  }

  // Check to see which thumbnails already exist
  const existingThumbnails = await Promise.all(widths.map(async width => {
    const thumbPath = webpCachePath(inputPathRelative, { width });
    const exists = await fs.access( thumbPath )
      .then(() => true)
      .catch(() => false);
    return {
      width,
      thumbPath,
      exists
    }
  }));

  if (existingThumbnails.every(t => t.exists)) {
    return;
  }

  const outDir = existingThumbnails[0].thumbPath;
  const mkDestDirPromise = fs.mkdir(path.dirname(outDir), { recursive: true });
  const fullInputPath = path.join(rootDir, inputPathRelative);
  const file = await fs.readFile(fullInputPath);

  const thumbnailPromises = existingThumbnails.filter(({ exists }) => !exists).map(({ width, thumbPath }) => ({
    width,
    thumbPath,
    promise: sharp(file).rotate().resize({ width }).toFormat('webp').toBuffer()
  }));

  await mkDestDirPromise;

  const savePromises = thumbnailPromises.map(async ({ promise, thumbPath }) => {
    const thumbnail = await promise;
    await fs.writeFile(thumbPath, thumbnail, { flag: 'wx' }).catch(e=>{
      if (e.code !== 'EEXIST'){
        throw e
      };
    });
    return thumbnail;
  });

  const result = await Promise.all(savePromises);
  return result[0];
}) satisfies FileGeneratorType;