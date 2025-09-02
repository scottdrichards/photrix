import { describe, expect, it } from "bun:test";
import type { AudioStreamCharacteristics, VideoStreamCharacteristics } from "./dashTypes";
import { characteristicsToString, initFileName, processDashFileName } from "./dashPathUtils";

describe("characteristicsToString", () => {
    it("video stream", () => {
        const videoStream: VideoStreamCharacteristics = {
            streamType: 'video',
            height: 720,
            width: 1280,
            bitrate: 1500000
        };
        expect(characteristicsToString(videoStream)).toBe("video-720x1280-1500000");
    });
    
    it("audio stream", () => {
        const audioStream: AudioStreamCharacteristics = {
            streamType: 'audio',
            bitrate: 128000,
            channels: 2,
            sampleRate: 48000
        };
        expect(characteristicsToString(audioStream)).toBe("audio-128000");
    });
});

describe("initFileName", () => {
    it("generates init file name for video stream", () => {
        const videoStream: VideoStreamCharacteristics = {
            streamType: 'video',
            height: 720,
            width: 1280,
            bitrate: 1500000
        };
        const baseName = "test.mp4";
        expect(initFileName(baseName, videoStream)).toBe("test.mp4-video-720x1280-1500000.init");
    });
    
    it("generates init file name for audio stream", () => {
        const audioStream: AudioStreamCharacteristics = {
            streamType: 'audio',
            bitrate: 128000,
            channels: 2,
            sampleRate: 48000
        };
        const baseName = "test.mp4";
        expect(initFileName(baseName, audioStream)).toBe("test.mp4-audio-128000.init");
    });
});

describe("processDashFileName", () => {
    const baseFile = "test.mp4";
    
    it('returns correct value for mpd file', () => {
        const result = processDashFileName(`${baseFile}.mpd`);
        expect(result).toEqual({
            baseFile,
            fileType: "mpd"
        });
    });
    
    it('returns correct value for init video file', () => {
        const result = processDashFileName(`${baseFile}-video-720x1280-1500000.init`);
        expect(result).toEqual({
            baseFile,
            characteristics: {
                streamType: 'video',
                height: 720,
                width: 1280,
                bitrate: 1500000
            },
            fileType: "init"
        });
    });
    
    it('returns correct value for init audio file', () => {
        const result = processDashFileName(`${baseFile}-audio-128000.init`);
        expect(result).toEqual({
            baseFile,
            characteristics: {
                streamType: 'audio',
                bitrate: 128000,
                channels: 2,
                sampleRate: 48000
            },
            fileType: "init"
        });
    });
    
    it('returns correct value for m4s file', () => {
        const result = processDashFileName(`${baseFile}-video-720x1280-1500000-s0001.m4s`);
        expect(result).toEqual({
            baseFile,
            characteristics: {
                streamType: 'video',
                height: 720,
                width: 1280,
                bitrate: 1500000
            },
            fileType: "m4s",
            segmentNumber: 1
        });
    });
});