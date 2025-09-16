import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { rootDir } from '../config.ts';

export const NOT_HANDLED = Symbol('NOT_HANDLED');

export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  pathname: string; // decoded pathname
  relativePath: string; // relative to media root (may be 'folder/file.ext' or '')
  fullPath: string; // absolute file system path
  query: URLSearchParams;
  width?: number;
  wantsThumbnail?: boolean;
}

/**
 * Attempt to handle the request. Return NOT_HANDLED if this handler does not apply.
 * Return any other truthy value (or void) to indicate handled. Write directly to ctx.res.
 * Throw for error conditions.
 */
export type MediaRequestHandler = (ctx: RequestContext) => Promise<typeof NOT_HANDLED | void | true>;