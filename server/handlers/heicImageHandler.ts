import path from 'node:path';
import fs from 'node:fs/promises';
import { exec } from 'node:child_process';
import { NOT_HANDLED, type MediaRequestHandler } from './types.ts';
import { rootDir } from '../config.ts';
import { webpCachePath } from './imageCommon.ts';

export const heicImageHandler: MediaRequestHandler = async (ctx) => {
    const { relativePath, width } = ctx;
    if (!/\.(heic|heif)$/i.test(relativePath)) return NOT_HANDLED;

    const originalPath = path.join(rootDir, relativePath);
    const cachePath = webpCachePath(relativePath, width ? { width } : {});
    const contentType = 'image/webp';
    try {
      const file = await fs.readFile(cachePath);
      ctx.res.writeHead(200, { 'Content-Type': contentType });
      ctx.res.end(file);
      return;
    } catch (e: any) {
      if (e && e.code === 'ENOENT') {
        console.log(`Creating ${width ? width + 'px' : 'full resolution'} WebP for HEIC file: ${relativePath}`);
        await fs.mkdir(path.dirname(cachePath), { recursive: true });
        const magickArgs = [
          'magick',
          `"${originalPath}"`,
          ...(width ? ['-resize', `${width}x`] : []),
          `"${cachePath}"`
        ];
        const command = magickArgs.join(' ');
        console.log('[HEIC] Running command:', command);
        await new Promise((resolve, reject) => {
          exec(command, (error, _stdout, stderr) => {
            if (error) reject({ code: error.code ?? 1, stderr }); else resolve(null);
          });
        });
        const file = await fs.readFile(cachePath);
        ctx.res.writeHead(200, { 'Content-Type': contentType });
        ctx.res.end(file);
        return;
      }
      throw e;
    }
};
