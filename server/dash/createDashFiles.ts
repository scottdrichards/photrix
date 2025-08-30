import { mkdir } from "node:fs/promises";
import { spawn, exec } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { dashConfig } from "./dashConstants";

const execAsync = promisify(exec);

type Params = {
    sourceFilePath: string;
    destDir: string;
};

const dashInitToken = "init";
const dashChunkToken = "chunk";


const videoExtensions = ['.mp4', '.mov', '.mkv', '.avi', '.wmv', '.flv', '.webm'];

export const isDashFile = (filePath: string) =>
        path.extname(filePath).toLowerCase() === '.mpd' ||
        new RegExp(`\\.(${videoExtensions.map(ext=>ext.substring(1)).join('|')})-(${dashChunkToken}|${dashInitToken})-\\d+(-\\d+\\.m4s|\\.mp4)`, "gi").test(filePath);

export const createDashFiles = async (params: Params): Promise<string> => {
    const { sourceFilePath, destDir } = params;

    // Create the destination directory if it doesn't exist
    await mkdir(destDir, { recursive: true });

    // Get base name for output files
    const baseName = path.basename(sourceFilePath);

    // Probe source video dimensions
    const probeCmd = `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of json "${sourceFilePath}"`;
    const { stdout: probeOutput } = await execAsync(probeCmd);
    const probeResult = JSON.parse(probeOutput);
    const sourceWidth = probeResult.streams?.[0]?.width || 1920;
    const sourceHeight = probeResult.streams?.[0]?.height || 1080;

    // Probe for (optional) audio presence
    let hasAudio = false;
    try {
        const audioProbeCmd = `ffprobe -v error -select_streams a:0 -show_entries stream=index -of json "${sourceFilePath}"`;
        const { stdout: audioProbeOut } = await execAsync(audioProbeCmd);
        const audioProbe = JSON.parse(audioProbeOut);
        hasAudio = Array.isArray(audioProbe.streams) && audioProbe.streams.length > 0;
    } catch {
        hasAudio = false; // Treat probe failures as no audio
    }

    // Filter ladder to only include resolutions that fit within source
    const availableLadder = dashConfig.ladder.filter((r, i) =>
        i === 0 // Always make the smallest available even if the video is smaller
        || (r.width <= sourceWidth && r.height <= sourceHeight));

    // Build filter_complex for multi-rendition split and scale
    const splitCount = availableLadder.length;
    const splitLabels = availableLadder.map((_, i) => `v${i}`);
    const scaledLabels = availableLadder.map((_, i) => `v${i}out`);
    
    const splitPart = `[0:v]split=${splitCount}${splitLabels.map(l => `[${l}]`).join('')};`;
    const scaleParts = availableLadder.map((r, i) => 
        `[${splitLabels[i]}]scale=${r.width}:${r.height}:force_original_aspect_ratio=decrease,pad=ceil(iw/2)*2:ceil(ih/2)*2[${scaledLabels[i]}]`
    ).join(';');
    const filterComplex = `${splitPart}${scaleParts}`;

    const videoCodecArgs = availableLadder.flatMap((r, i)=>[
            `-c:v:${i}`, 'h264_amf',
            '-pix_fmt', 'yuv420p',
            `-b:v:${i}`, `${Math.round(r.bitrate/1000)}k`,
            `-maxrate:v:${i}`, `${Math.round(r.bitrate/1000)}k`,
            `-bufsize:v:${i}`, `${Math.round(r.bitrate/500)}k`
        ]);

    const mapArgs = [
        ... availableLadder.flatMap((_, i) => ['-map', `[${scaledLabels[i]}]`]),
        ...(hasAudio ? ['-map', '0:a:0'] : [])
    ];

    const audioArgs = hasAudio ? ['-c:a', 'aac', '-b:a', '128k', '-ac', '2'] : [];
    
    // Create adaptation sets string: all video renditions in one set; include audio set only if audio present
    const videoStreamIndices = availableLadder.map((_, i) => i).join(',');
    // Audio output stream index is immediately after last video if present
    const adaptationSets = hasAudio
        ? `id=0,streams=${videoStreamIndices} id=1,streams=${availableLadder.length}`
        : `id=0,streams=${videoStreamIndices}`;
    
    const dashArgs = [
        '-f', 'dash',
        '-seg_duration', String(dashConfig.segmentDurationSeconds),
        '-use_template', '1',
        '-use_timeline', '1',
        // Quote adaptation sets so both sets (video+audio) are treated as one argument
        '-adaptation_sets', `"${adaptationSets}"`,
        '-g', '60',
        '-keyint_min', '60',
        '-sc_threshold', '0',
        '-init_seg_name', `${baseName}-${dashInitToken}-$RepresentationID$.mp4`,        // Use relative paths
        '-media_seg_name', `${baseName}-${dashChunkToken}-$RepresentationID$-$Number%05d$.m4s`  // Use relative paths
    ];

    const manifestPath = path.join(destDir, `${baseName}.mpd`);
    
    // Build command as string with proper quoting for UNC paths
    const quotePath = (p: string) => `"${p.replace(/"/g, '\\"')}"`;
    const escapeFilterComplex = (filter: string) => `"${filter.replace(/"/g, '\\"')}"`;
    
    const cmd = [
        'ffmpeg',
        '-nostdin', '-y', '-hide_banner', '-loglevel', 'error',
        '-hwaccel', 'auto',
        '-i', quotePath(sourceFilePath),
        '-filter_complex', escapeFilterComplex(filterComplex),
        ...mapArgs,
        ...videoCodecArgs,
        ...audioArgs,
        ...dashArgs,
        quotePath(`${baseName}.mpd`)  // Use relative path for manifest
    ].join(' ');

    console.log(`[DASH] Creating manifest and segments: ${cmd}`);
    console.log(`[DASH] Working directory: ${destDir}`);

    // Use exec instead of spawn for better shell handling of UNC paths
    const child = exec(cmd, { cwd: destDir });
    
    // Monitor stdout live
    child.stdout?.on('data', (data) => {
        console.log(`[DASH-STDOUT] ${data.toString().trim()}`);
    });
    
    // Monitor stderr live  
    child.stderr?.on('data', (data) => {
        console.log(`[DASH-STDERR] ${data.toString().trim()}`);
    });
    
    // Wait for process to complete
    await new Promise<void>((resolve, reject) => {
        child.on('close', (code) => {
            if (code === 0) {
                console.log(`[DASH] Process completed successfully`);
                resolve();
            } else {
                reject(new Error(`[DASH] ffmpeg exited with code ${code}`));
            }
        });
        
        child.on('error', (err) => {
            reject(new Error(`[DASH] Process error: ${err.message}`));
        });
    });

    return manifestPath
};

// const startTime = Date.now();
// await createDashFiles({
//     sourceFilePath: "//TRUENAS/Date-uh/Pictures and Videos/2025/01/Snow/GX011823.MP4",
//     destDir: "C:\\cache\\media\\2025\\01\\Snow\\"
// });
// const duration = Date.now() - startTime;
// console.log(`[DASH] Process completed in ${duration}ms`);