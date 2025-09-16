import path from 'node:path';
import fs from 'node:fs/promises';
import sharp from 'sharp';
import { NOT_HANDLED, type MediaRequestHandler } from './types.ts';
import { rootDir } from '../config.ts';
import { webpCachePath } from './imageCommon.ts';

const rasterExt = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff'];

export const rasterImageHandler: MediaRequestHandler = async (ctx) => {
    const { relativePath, width } = ctx;
    const ext = path.extname(relativePath).toLowerCase();
    if (!rasterExt.includes(ext)) return NOT_HANDLED;

    const fullPath = path.join(rootDir, relativePath);

    if (!width) {
      const file = await fs.readFile(fullPath);
      const contentType = (ext === '.jpg' || ext === '.jpeg') ? 'image/jpeg' : `image/${ext.substring(1)}`;
      ctx.res.writeHead(200, { 'Content-Type': contentType });
      ctx.res.end(file);
      return;
    }

    const thumbnailPath = webpCachePath(relativePath, { width });
    try {
      const file = await fs.readFile(thumbnailPath);
      ctx.res.writeHead(200, { 'Content-Type': 'image/webp' });
      ctx.res.end(file);
      return;
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
      console.log(`[Image] Creating ${width}px thumbnail for ${ext} file: ${relativePath}`);
      const file = await fs.readFile(fullPath);
      const thumbnail = await sharp(file).rotate().resize({ width }).toFormat('webp').toBuffer();
      fs.mkdir(path.dirname(thumbnailPath), { recursive: true }).then(async () => {
        await fs.writeFile(thumbnailPath, thumbnail);
      });
      ctx.res.writeHead(200, { 'Content-Type': 'image/webp' });
      ctx.res.end(thumbnail);
      return;
    }
};
