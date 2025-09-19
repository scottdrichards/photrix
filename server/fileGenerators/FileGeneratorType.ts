/**
 * Returns an image buffer if just one width is supplied and image is in javascript memory.
 */
export type FileGeneratorType = (params: { inputPathRelative: string, widths:number[]|undefined }) => Promise<void | Buffer<ArrayBufferLike>>;