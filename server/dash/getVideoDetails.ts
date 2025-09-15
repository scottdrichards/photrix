import { exec } from 'node:child_process';
import { promisify } from 'node:util';

type VideoDetails = {
    duration: number;
    fps: number;
    width: number;
    height: number;
}

export const getVideoDetails = async (fullPath:string):Promise<VideoDetails> =>{

    const videoProbeCmd = `ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate,duration,width,height -of default=noprint_wrappers=1:nokey=0 "${fullPath}"`;

    const {stdout: videoStdOut} = await promisify(exec)(videoProbeCmd);

    const fields = ['duration', 'fps', 'width', 'height'] as const;

    const videoDetails = videoStdOut.split(/\r?\n/)
        .map(line => line.trim().split('='))
        .reduce((vals, [key, value])=>{
            switch (key) {
                case 'r_frame_rate':
                    const fr = value;
                    if (fr?.includes('/')) {
                        const [a, b] = fr.split('/').map(Number);
                        if (b) {
                            vals.fps = a / b;
                        }
                    }
                    break;
                case 'duration':
                    vals.duration = parseFloat(value);
                    break;
                case 'width':
                    vals.width = parseInt(value);
                    break;
                case 'height':
                    vals.height = parseInt(value);
                    break;
            }
            return vals;
        }, Object.fromEntries(fields.map(key => [key, undefined])) as {[key in typeof fields[number]]: number | undefined});

    const unknownFields = fields.filter(key => videoDetails[key] === undefined);
    if (unknownFields.length) {
        throw new Error(`Failed to probe video for ${unknownFields.join(', ')}`);
    }

    return videoDetails as VideoDetails;
}

type AudioDetails = {
    hasAudio: boolean;
    sampleRate: number;
    channels: number;
}

// Probe source (duration, fps, audio presence / parameters)
export const getAudioDetails = async (fullPath: string): Promise<AudioDetails> => {
    const audioProbeCmd = `ffprobe -v error -select_streams a:0 -show_entries stream=index,sample_rate,channels -of default=noprint_wrappers=1:nokey=1 "${fullPath}"`;
    try {
        const { stdout } = await promisify(exec)(audioProbeCmd);
        const lines = stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        // ffprobe with these options prints values in order; safer to parse key/value variant again:
        // We'll run a second command with nokey=0 if needed
        if (!lines.length) {
            // No audio stream
            return { hasAudio: false, sampleRate: 0, channels: 0 };
        }
    } catch {
        return { hasAudio: false, sampleRate: 0, channels: 0 };
    }

    // Re-run with key names for clarity
    const audioProbeKeyed = `ffprobe -v error -select_streams a:0 -show_entries stream=index,sample_rate,channels -of default=noprint_wrappers=1:nokey=0 "${fullPath}"`;
    const { stdout: keyedOut } = await promisify(exec)(audioProbeKeyed);
    const parsed = keyedOut.split(/\r?\n/)
        .map(line => line.trim().split('='))
        .reduce((vals, [key, value]) => {
            switch (key) {
                case 'index': vals.hasAudio = true; break;
                case 'sample_rate': vals.sampleRate = parseInt(value); break;
                case 'channels': vals.channels = parseInt(value); break;
            }
            return vals;
        }, { hasAudio: false, sampleRate: 0, channels: 0 } as AudioDetails);
    return parsed;
};
