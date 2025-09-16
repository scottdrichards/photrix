import path from 'node:path';
import { NOT_HANDLED, type MediaRequestHandler } from './types.ts';
import { getMpdForSource, awaitDashFileBySlug, ensureEncodingStartedForFile } from '../dash/dashSessionManager';

const dashTypes: Record<string,string> = {
  '.mpd':'application/dash+xml',
  '.m4s':'video/iso.segment'
};

export const dashHandler: MediaRequestHandler = async (ctx) => {
    const { relativePath } = ctx;
    const ext = path.extname(relativePath).toLowerCase();
    if (ext !== '.mpd' && ext !== '.m4s') return NOT_HANDLED;

    const contentType = dashTypes[ext];

    if (ext === '.mpd') {
      if (!relativePath.toLowerCase().endsWith('.mpd')) {
        const err: any = new Error('Invalid MPD path');
        err.code = 'ENOENT';
        throw err;
      }
      const sourceBase = relativePath.substring(0, relativePath.length - 4);
      const mpd = await getMpdForSource(sourceBase);
      ensureEncodingStartedForFile(sourceBase).catch(e => console.warn('[DASH] Failed eager start', e));
      ctx.res.writeHead(200, { 'Content-Type': contentType });
      ctx.res.end(mpd);
      return;
    }

    if (ext === '.m4s') {
      const file = path.basename(relativePath);
      const match = /^([A-Za-z0-9_-]+)-(init|chunk)-/.exec(file);
      if (!match) {
        const err: any = new Error('Invalid segment naming');
        err.code = 'ENOENT';
        throw err;
      }
      const slug = match[1];
      const data = await awaitDashFileBySlug(slug, file);
      if (!data) {
        const err: any = new Error('Segment not ready');
        err.code = 'ESEGMENT_NOT_READY';
        throw err;
      }
      ctx.res.writeHead(200, { 'Content-Type': contentType });
      ctx.res.end(data);
      return;
    }

    return NOT_HANDLED;
};
