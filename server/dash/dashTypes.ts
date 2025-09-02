
type BaseStreamCharacteristics = {
    streamType: 'video' | 'audio';
    bitrate: number;
}

export type VideoStreamCharacteristics = {
    streamType: 'video';
    height: number;
    width: number;
} & BaseStreamCharacteristics;

export type AudioStreamCharacteristics = {
    streamType: 'audio';
    channels: number;
    sampleRate: number;
} & BaseStreamCharacteristics;

export type StreamCharacteristics = VideoStreamCharacteristics | AudioStreamCharacteristics;