import path from 'node:path';
import { mediaCacheDir } from '../config.ts';

type Dimensions = { width?: number; height?: number };

const dimensionsToPathString = (dimensions:Dimensions) => {
  if (dimensions.width) return `-${dimensions.width}w`;
  if (dimensions.height) return `-${dimensions.height}h`;
  return '-full';
};

export const webpCachePath = (relativePath:string, dimensions:Dimensions) => {
  return path.join(mediaCacheDir, relativePath) + dimensionsToPathString(dimensions) + '.webp';
};