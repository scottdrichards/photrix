import { ChildProcess, exec } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { mediaCacheDir, rootDir } from '../config';
import { AUDIO_BITRATE, AUDIO_CODEC, dashConfig, DEFAULT_CHANNELS, DEFAULT_SAMPLE_RATE, SEGMENT_DURATION_SEC, VIDEO_CODEC } from './dashConstants';
import { characteristicsToString, initFileName, processDashFileName, segmentFileName, segmentPadding } from './dashPathUtils';
import type { StreamCharacteristics, VideoStreamCharacteristics } from './dashTypes';

const gpuProcess: {
    stream: string,
    process: ChildProcess
} | null = null;

// Cached probe results so repeated requests are cheap.
type ProbeInfo = {
    duration: number;
    fps: number;
    hasAudio: boolean;
    sampleRate?: number;
    channels?: number;
};

// Probe source (duration, fps, audio presence / parameters)
const probe = async (source: string): Promise<ProbeInfo> => {
    const run = (cmd: string) => new Promise<string>((resolve, reject) =>
        exec(cmd, (e, o) => (e ? reject(e) : resolve(o)))
    );

    const videoProbeCmd = `ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate,duration -of default=noprint_wrappers=1:nokey=0 "${source}"`;
    const audioProbeCmd = `ffprobe -v error -select_streams a:0 -show_entries stream=index,sample_rate,channels -of default=nw=1:nk=1 "${source}"`;

    let duration = 0;
    let fps = 30;
    let hasAudio = false;
    let sampleRate: number | undefined;
    let channels: number | undefined;

    try {
        const vOut = await run(videoProbeCmd);
        for (const line of vOut.split(/\r?\n/)) {
            if (line.startsWith('duration=')) duration = parseFloat(line.split('=')[1]) || 0;
            if (line.startsWith('r_frame_rate=')) {
                const fr = line.split('=')[1];
                if (fr?.includes('/')) {
                    const [a, b] = fr.split('/').map(Number);
                    if (b) fps = a / b;
                }
            }
        }

        const aOut = await run(audioProbeCmd).catch(() => '');
        const lines = aOut.trim().split(/\r?\n/).filter(Boolean);
        if (lines.length) {
            hasAudio = true;
            const nums = lines.map(l => parseInt(l, 10)).filter(n => !Number.isNaN(n));
            if (nums.length === 1) sampleRate = nums[0];
            if (nums.length >= 2) { sampleRate = nums[1]; channels = nums[2] || DEFAULT_CHANNELS; }
        }
    } catch {
        // swallow; use defaults
    }

    if (!duration) duration = 1;
    return { duration, fps, hasAudio, sampleRate, channels };
};

// Select ladder entries that fit inside the source dimensions (always keep smallest)
const filterLadder = (sourceWidth: number, sourceHeight: number) =>
    dashConfig.videoQualityOptions.filter((streamCharacteristic, index) => {
        if (index === 0) return true;
        return streamCharacteristic.width <= sourceWidth && streamCharacteristic.height <= sourceHeight;
    });

const probeDimensions = async (fullPath: string): Promise<{ width: number; height: number }> => {
    const cmd = `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0:s=x "${fullPath}"`;
    const {stderr, stdout} = await promisify(exec)(cmd);
    if (stderr){
        throw new Error(`ffprobe error: ${stderr}`);
    }
    const [width, height] = stdout?.trim().split('x').map(Number);
    if (isNaN(width) || isNaN(height)) {
        throw new Error(`Invalid ffprobe output: ${stdout}`);
    }
    return { width, height };
};

const getManifest = async (sourceFilePath: string, destDir: string, overwriteExisting:boolean = false) => {
    await fs.mkdir(destDir, { recursive: true });
    const baseName = path.basename(sourceFilePath);
    const manifestPath = path.join(destDir, `${baseName}.mpd`);
    try {
        if (!overwriteExisting) {
            return await fs.readFile(manifestPath, 'utf-8');
        }
    } catch { /* create below */ }

    const { width: sourceWidth, height: sourceHeight } = await probeDimensions(sourceFilePath);
    const { duration, fps, hasAudio, sampleRate = DEFAULT_SAMPLE_RATE, channels = DEFAULT_CHANNELS } = await probe(sourceFilePath);
    const videoStreams = filterLadder(sourceWidth, sourceHeight).map<VideoStreamCharacteristics>(s => ({ ...s, streamType: 'video' }));
    const audioStreams = [{ streamType: 'audio', bitrate: AUDIO_BITRATE, channels, sampleRate }];
    const timescale = Math.round((fps * 1000) / 1001) || fps || 30; // approx for common NTSC rates
    const segmentDurationTicks = SEGMENT_DURATION_SEC * timescale;
    const maxW = Math.max(...videoStreams.map(r => r.width));
    const maxH = Math.max(...videoStreams.map(r => r.height));

    const mpd = `<?xml version="1.0" encoding="utf-8"?>
        <MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-live:2011" type="static" mediaPresentationDuration="PT${duration.toFixed(1)}S" minBufferTime="PT${Math.min(12, SEGMENT_DURATION_SEC * 2)}S">
            <Period start="PT0S">
                <AdaptationSet id="0" contentType="video" segmentAlignment="true" bitstreamSwitching="true" maxWidth="${maxW}" maxHeight="${maxH}">
                    ${videoStreams.map(r => `
                    <Representation id="${r.height}" mimeType="video/mp4" codecs="${VIDEO_CODEC}" bandwidth="${r.bitrate}" width="${r.width}" height="${r.height}" sar="1:1">
                        <SegmentTemplate timescale="${timescale}" initialization="${initFileName(baseName, r)}" media="${baseName}-${characteristicsToString(r)}-s$Number%0${segmentPadding}d$.m4s" startNumber="1" duration="${segmentDurationTicks}"/>
                    </Representation>`).join('')}
                </AdaptationSet>${hasAudio ? `
                <AdaptationSet id="1" contentType="audio" segmentAlignment="true">
                    ${audioStreams.map((r, i) => `
                    <Representation id="audio_${i}" mimeType="audio/mp4" codecs="${AUDIO_CODEC}" bandwidth="${r.bitrate}" audioSamplingRate="${r.sampleRate}">
                        <AudioChannelConfiguration schemeIdUri="urn:mpeg:dash:23003:3:audio_channel_configuration:2011" value="${r.channels}"/>
                        <SegmentTemplate timescale="${r.sampleRate}" initialization="${baseName}-audio-${AUDIO_BITRATE}.init" media="${baseName}-audio-${AUDIO_BITRATE}-s$Number%0${segmentPadding}d$.m4s" startNumber="1" duration="${SEGMENT_DURATION_SEC * r.sampleRate}"/>
                    </Representation>`).join('')}
                </AdaptationSet>` : ''}
            </Period>
        </MPD>`;

    await fs.writeFile(manifestPath, mpd, 'utf-8');
    return mpd;
};

export const getDashFile = async (fileRelativePath: string): Promise<{file:Buffer, contentType: string}> => {
    const relativeDir = path.dirname(fileRelativePath);
    const dashFileName = path.basename(fileRelativePath);
    const cachePath = path.join(mediaCacheDir,fileRelativePath);
    const cachePathDir = path.dirname(cachePath);
    
    const {baseFile, ...dashProperties} = processDashFileName(dashFileName);
    const sourceFilePath = path.join(rootDir, relativeDir, baseFile);

    const contentType = dashProperties.fileType === 'm4s' ? 'video/mp4' : 'application/dash+xml';

    try {
        // return {
        //     file: await fs.readFile(cachePath),
        //     contentType
        // };
    } catch {
        // Need to build it
    }
    await fs.mkdir(path.dirname(cachePath), { recursive: true });

    if (dashProperties.fileType === 'mpd') {
        return {file: Buffer.from(await getManifest(sourceFilePath,cachePathDir,true)), contentType};
    }

    const {characteristics} = dashProperties;
    if (dashProperties.fileType === 'init') {
        // Initialize audio characteristics if not present
        if (characteristics.streamType === 'audio') {
            const { sampleRate = DEFAULT_SAMPLE_RATE, channels = DEFAULT_CHANNELS } = await probe(sourceFilePath);
            characteristics.sampleRate = sampleRate; characteristics.channels = channels;
        }

        await generateSegment(sourceFilePath, cachePathDir, characteristics, 1, true);
        // Warm-up further segments asynchronously
        generateSegment(sourceFilePath, cachePathDir, characteristics, 2).catch(()=>{});
        generateSegment(sourceFilePath, cachePathDir, characteristics, 3).catch(()=>{});
    } else if (dashProperties.fileType === 'm4s') {
        await generateSegment(sourceFilePath, cachePathDir, characteristics, dashProperties.segmentNumber);
    }

    return {
        file: await fs.readFile(cachePath),
        contentType
    };
};

const generateSegment = async (
    source: string,
    destDir: string,
    rep: StreamCharacteristics,
    segmentNumber: number,
    includeInit = false
) => {
    const baseName = path.basename(source);
    const start = (segmentNumber - 1) * SEGMENT_DURATION_SEC;
    const isAudio = rep.streamType === 'audio';
    const tempOut = path.join(destDir, `.__tmp_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`);
    const initPath = path.join(destDir, initFileName(baseName, rep));
    const segPath = path.join(destDir, segmentFileName(baseName, rep, segmentNumber));
    const commonStart = [ 'ffmpeg', '-hide_banner', '-loglevel', 'error', '-ss', String(start), '-i', `"${source}"`, '-t', String(SEGMENT_DURATION_SEC) ];

    const cmd = isAudio
        ? [ ...commonStart, '-vn', '-c:a', 'aac', '-b:a', String(rep.bitrate), '-movflags', 'frag_keyframe+empty_moov+default_base_moof', tempOut ]
        : [ ...commonStart, '-vf', `scale=${(rep as VideoStreamCharacteristics).width}:${(rep as VideoStreamCharacteristics).height}:force_original_aspect_ratio=decrease,pad=ceil(iw/2)*2:ceil(ih/2)*2`, '-c:v','h264_amf','-usage','transcoding','-quality','balanced','-profile:v','main','-level','4.0','-b:v', String(rep.bitrate), '-an', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', tempOut ];
        
    const { stderr } = await promisify(exec)(cmd.join(' '));
    if (stderr) throw new Error(stderr);

    const full = await fs.readFile(tempOut);
    if (includeInit) {
        const moofPos = full.indexOf(Buffer.from('moof'));
        if (moofPos > 8) {
            const initSlice = full.subarray(0, Math.max(0, moofPos - 4));
            await fs.writeFile(initPath, initSlice.length ? initSlice : full);
        } else {
            await fs.writeFile(initPath, full);
        }
    }
    await fs.copyFile(tempOut, segPath);
    // Delete temporary file
    await fs.unlink(tempOut).catch(() => {});
};

export const isDashFile = (filePath: string) =>
    filePath.toLowerCase().endsWith('.mpd') || filePath.includes('.m4s') || filePath.endsWith('.init');

