import path from 'node:path';
import { mediaCacheDir } from '../config.ts';

export type Dimensions = { width?: number; height?: number };

const dimensionsToPathString = (dimensions:Dimensions) => {
  if (dimensions.width) return `-${dimensions.width}w`;
  if (dimensions.height) return `-${dimensions.height}h`;
  return '-full';
};

export const webpCachePath = (relativePath:string, dimensions:Dimensions) => {
  return path.join(mediaCacheDir, relativePath) + dimensionsToPathString(dimensions) + '.webp';
};

export const videoExtensions = ['.mp4', '.mov', '.mkv', '.avi', '.wmv', '.flv', '.webm'] as const;
