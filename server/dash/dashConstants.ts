type DashLadderEntry = { name: string; width: number; height: number; bitrate: number };

export const dashConfig ={
    ladder : [
        { name: '160p', width: 160, height: 90, bitrate: 250_000 },
        { name: '320p', width: 320, height: 180, bitrate: 500_000 },
        { name: '640p', width: 640, height: 360, bitrate: 750_000 },
        { name: '720p', width: 1280, height: 720, bitrate: 1_500_000 },
        { name: '1080p', width: 1920, height: 1080, bitrate: 3_000_000 },
        { name: '1440p', width: 2560, height: 1440, bitrate: 6_000_000 },
        { name: '2160p', width: 3840, height: 2160, bitrate: 12_000_000 }
    ] as const satisfies DashLadderEntry[],
    segmentDurationSeconds: 5,
} as const;

export const dashSegmentIdentifier = "segment_"