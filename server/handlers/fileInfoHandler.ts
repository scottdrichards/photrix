import { NOT_HANDLED, type MediaRequestHandler } from './types.ts';
import { mediaDatabase } from '../mediaDatabase.ts';

// Serves metadata for a single file when ?info=true is present and the path is not a folder
export const fileInfoHandler: MediaRequestHandler = async (ctx) => {
  if (ctx.relativePath.endsWith('/') || ctx.relativePath === '') return NOT_HANDLED;
  if (ctx.query.get('info') !== 'true') return NOT_HANDLED;
  try {
    const fileInfo = mediaDatabase.getFileByPath(ctx.relativePath);
    if (!fileInfo) {
      ctx.res.writeHead(404, { 'Content-Type': 'text/plain' });
      ctx.res.end('File not found in database');
      return;
    }
    ctx.res.writeHead(200, { 'Content-Type': 'application/json' });
    ctx.res.end(JSON.stringify({
      name: fileInfo.name,
      parent_path: fileInfo.parent_path,
      date_taken: fileInfo.date_taken,
      date_modified: fileInfo.date_modified,
      rating: fileInfo.rating,
      camera_make: fileInfo.camera_make,
      camera_model: fileInfo.camera_model,
      lens_model: fileInfo.lens_model,
      focal_length: fileInfo.focal_length,
      aperture: fileInfo.aperture,
      shutter_speed: fileInfo.shutter_speed,
      iso: fileInfo.iso,
      hierarchical_subject: fileInfo.hierarchical_subject,
      image_width: fileInfo.image_width,
      image_height: fileInfo.image_height,
      orientation: fileInfo.orientation,
      date_indexed: fileInfo.date_indexed,
      keywords: fileInfo.keywords
    }));
    return;
  } catch (error) {
    console.error('[fileInfoHandler] Error retrieving metadata', error);
    if (!ctx.res.headersSent) {
      ctx.res.writeHead(500, { 'Content-Type': 'text/plain' });
      ctx.res.end('Internal server error');
    }
    return;
  }
};