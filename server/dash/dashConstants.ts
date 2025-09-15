// Lightweight shape for video quality options to keep config self-contained
type VideoStreamCharacteristics = { width:number; height:number; bitrate:number };

export const dashConfig ={
    // Ordered from lowest to highest; first entry always kept.
    videoQualityOptions : [
        { width: 160, height: 90, bitrate: 250_000 },
        // { width: 320, height: 180, bitrate: 500_000 },
        { width: 640, height: 360, bitrate: 750_000 },
        // { width: 1280, height: 720, bitrate: 1_500_000 },
        { width: 1920, height: 1080, bitrate: 3_000_000 },
        // { width: 2560, height: 1440, bitrate: 6_000_000 },
        // { width: 3840, height: 2160, bitrate: 12_000_000 }
    ] as const satisfies Omit<VideoStreamCharacteristics, 'streamType'>[],
    segmentDurationSeconds: 5,
} as const;

export const dashSegmentIdentifier = "segment_"

export const SEGMENT_DURATION_SEC = dashConfig.segmentDurationSeconds;
export const DEFAULT_SAMPLE_RATE = 48_000;
export const DEFAULT_CHANNELS = 2;
export const AUDIO_BITRATE = 128_000; // single audio rendition for now
export const VIDEO_CODEC = 'avc1.4d002a'; // manifest codec string (baseline/main profile approx)
export const AUDIO_CODEC = 'mp4a.40.2';