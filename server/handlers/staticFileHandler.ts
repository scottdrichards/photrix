import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { NOT_HANDLED, type MediaRequestHandler } from './types.ts';

export const staticFileHandler: MediaRequestHandler = async (ctx) => {
    // Only handle if path points to an existing regular file
    try {
      const stats = await fs.stat(ctx.fullPath);
      if (!stats.isFile()) return NOT_HANDLED;
      ctx.res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(stats.size)
      });
      createReadStream(ctx.fullPath).pipe(ctx.res);
      return;
    } catch (e: any) {
      if (e && e.code === 'ENOENT') return NOT_HANDLED;
      throw e; // propagate unexpected errors
    }
};
