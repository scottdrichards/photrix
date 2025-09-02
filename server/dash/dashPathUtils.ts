import { DEFAULT_CHANNELS, DEFAULT_SAMPLE_RATE } from "./dashConstants";
import type { StreamCharacteristics } from "./dashTypes";

export const segmentPadding = 5;

// Generating Strings

export const characteristicsToString = (r: StreamCharacteristics) => `${r.streamType === 'audio' ? `audio-${r.bitrate}` : `video-${r.height}x${r.width}-${r.bitrate}`}`;

export const initFileName = (base: string, r: StreamCharacteristics) => `${base}-${characteristicsToString(r)}.init`;

export const segmentFileName = (base: string, r: StreamCharacteristics, seg: number) => `${base}-${characteristicsToString(r)}-s${seg.toString().padStart(segmentPadding, '0')}.m4s`;

type ProcessDashFileNameReturnValue = {
    baseFile:string,
}&({
    fileType: 'mpd'
}|({
    characteristics:StreamCharacteristics
} & ({
    fileType: 'init',
} | {
    fileType: 'm4s',
    segmentNumber: number
})))

export const processDashFileName = (fileName: string): ProcessDashFileNameReturnValue => {
    const [, baseFile, characteristicsAndSegmentNumber, fileType] = /^(.*\.\w+)-?([\w-]*)\.(\w+)$/.exec(fileName) || [];
    if (fileType === 'mpd') {
        return { baseFile, fileType };
    }

    const [, streamType, height, width, bitrate, segmentNumber] = /^(audio|video)(?:-(\d+)x(\d+))?-(\w+)(?:-s(\d+))?$/.exec(characteristicsAndSegmentNumber) || [];

    if (fileType !== 'init' && fileType !== 'm4s'){
        throw new Error(`unknown fileType ${fileType}`)
    }

    if (streamType !== 'audio' && streamType !== 'video') {
        throw new Error(`unknown streamType ${streamType}`);
    }

    return {
        baseFile: baseFile as any,
        fileType,
        characteristics:  {
            streamType: streamType as any,
            bitrate: Number(bitrate),
            ...(streamType === 'video' ? { height: Number(height), width: Number(width) } : { channels: DEFAULT_CHANNELS, sampleRate: DEFAULT_SAMPLE_RATE })
        },
        ...(fileType === 'm4s' ? { segmentNumber: Number(segmentNumber) } : {})
    } as any;
};



