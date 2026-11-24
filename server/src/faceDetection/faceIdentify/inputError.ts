/**
 * The caller's request can't be served as given: a bad body, a URL outside the
 * LAN, a frame that couldn't be fetched or cropped. Answered with a 400 when it
 * sinks the whole request; one bad frame among several is only reported.
 */
export class FaceIdentifyInputError extends Error {}
