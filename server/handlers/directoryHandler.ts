import type { MediaRequestHandler } from './types.ts';
import { NOT_HANDLED } from './types.ts';
import path from 'node:path';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { mediaDatabase, type MediaFileProperties, numberSearchableColumns, textSearchableColumns, type SearchFilters, type NumberSearchableColumns } from '../mediaDatabase.ts';

// Reproduce getFilter logic locally to avoid coupling to server/index.ts
const allFields = ["name", "mediaType", "excludeSubfolders", "keywords", ...textSearchableColumns, ...numberSearchableColumns] as const;
const buildFilter = (searchParams: URLSearchParams): SearchFilters => {
  const textFilter = allFields
    .map(column => [column, searchParams.get(column)] as const)
    .filter((tuple): tuple is [typeof tuple[0], string] => tuple[1] !== null)
    .map(([column, value]) => {
      try { return [column, JSON.parse(value) as any] as const; } catch { return [column, value] as const; }
    })
    .map(([column, value]) => {
      if (numberSearchableColumns.includes(column as NumberSearchableColumns)) {
        if (Array.isArray(value)) return [column, value.map(v => Number(v))] as const;
        if (typeof value === 'string') return [column, Number(value)] as const;
      }
      return [column, value] as const;
    })
    .reduce((acc, [column, value]) => value ? { ...acc, [column]: value } : acc, {} as SearchFilters);
  return { ...textFilter };
};

export const directoryHandler: MediaRequestHandler = async (ctx) => {
    // Only handle if path is a folder request: ends with path.sep or empty relative
    const isFolder = ctx.relativePath.endsWith(path.sep) || ctx.relativePath === '';
    if (!isFolder) return NOT_HANDLED;

    const sp = ctx.query;

    // Subfolder listing
    if (sp.get('type') === 'folders') {
      const folders = mediaDatabase.listSubfolders(ctx.relativePath);
      ctx.res.writeHead(200, { 'Content-Type': 'application/json' });
      ctx.res.end(JSON.stringify({ folders }));
      return;
    }

    // Column distinct values
    if (sp.get('type') === 'column-values') {
      const column = sp.get('column');
      const containsText = sp.get('containsText');
      if (!column) {
        ctx.res.writeHead(400, { 'Content-Type': 'text/plain' });
        ctx.res.end('Missing column parameter');
        return;
      }
      try {
        const distinctValues = mediaDatabase.getColumnDistinctValues(column as keyof MediaFileProperties, {
          filter: { parentPath: ctx.relativePath, ...buildFilter(sp), [column]: undefined },
          containsText: containsText || undefined
        });
        const filteredValues = distinctValues.filter(v => v.value !== null && v.value !== undefined);
        ctx.res.writeHead(200, { 'Content-Type': 'application/json' });
        ctx.res.end(JSON.stringify(filteredValues));
        return;
      } catch (e) {
        console.error('[directoryHandler] column-values error', e);
        ctx.res.writeHead(500, { 'Content-Type': 'text/plain' });
        ctx.res.end('Internal server error');
        return;
      }
    }

    // Database search listing
    const excludeSubfolders = sp.get('excludeSubfolders') !== 'false';
    const filter = buildFilter(sp);
    const dbResults = mediaDatabase.search({ parentPath: ctx.relativePath, excludeSubfolders, ...filter });
    const output = dbResults.map(row => ({
      path: `${row.parent_path}/${row.name}`,
      details: sp.get('details')?.split(',').map(v => v.trim()).reduce((acc, key) => {
        switch (key) {
          case 'aspectRatio':
            acc.aspectRatio = row.image_width && row.image_height ? row.image_width / row.image_height : undefined; break;
          case 'geolocation':
            acc.geolocation = row.gps_latitude && row.gps_longitude ? { latitude: row.gps_latitude, longitude: row.gps_longitude } : undefined; break;
          default:
            acc[key] = row[key as keyof typeof row]; break;
        }
        return acc; }, {} as Record<string, any>)
    }));

    // Decide whether to stream based on size estimate (rough).
    // Rough estimate: assume ~80 chars per item if details small; fallback to actual JSON length if below threshold.
    const roughSize = output.length * 80;
    const STREAM_THRESHOLD = 100_000; // ~100KB
    if (roughSize < STREAM_THRESHOLD) {
      const json = JSON.stringify(output);
      const gz = zlib.gzipSync(json);
      ctx.res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
      ctx.res.end(gz);
      return;
    }
    ctx.res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Transfer-Encoding': 'chunked' });
    const gzip = zlib.createGzip();
    gzip.pipe(ctx.res);
    // Stream JSON array manually to avoid holding entire string.
    gzip.write('[');
    for (let i = 0; i < output.length; i++) {
      const chunk = JSON.stringify(output[i]);
      if (i > 0) gzip.write(',');
      gzip.write(chunk);
    }
    gzip.write(']');
    gzip.end();
    return;
};
