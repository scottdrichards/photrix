import { cacheDir, mediaCacheDir, rootDir } from "config";
import path from 'node:path';
import fs from 'node:fs/promises';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { dashConfig, VIDEO_CODEC, AUDIO_CODEC, AUDIO_BITRATE, SEGMENT_DURATION_SEC } from '../dash/dashConstants';
import { getVideoDetails, getAudioDetails } from '../dash/getVideoDetails';

// Hardware / encoder configuration (hardcoded defaults)
const AMF_MAX_WIDTH = 4096;
const AMF_MAX_HEIGHT = 4096;
const ALLOW_SOFTWARE_FALLBACK = true;
const VIDEO_ENCODER = 'h264_amf';
const BASE_SCALE_FLAGS = 'bilinear';
const DOWNSCALE_FLAGS = 'fast_bilinear';
const MAX_REPRESENTATIONS = 4;

// Basic hwaccel choice (minimal detection for now)
const HWACCEL_FLAG: string[] = (() => {
  if (process.platform === 'win32') return ['-hwaccel', 'dxva2'];
  if (process.platform === 'linux') return ['-hwaccel', 'vaapi'];
  return [];
})();

type Representation = {
  id: string;
  width: number;
  height: number;
  bandwidth: number;
  codec: string;
};

const pickRepresentations = async (sourcePath: string): Promise<Representation[]> => {
  const videoDetails = await getVideoDetails(sourcePath);
  const reps = dashConfig.videoQualityOptions
    .filter((opt, idx) => {
      if (idx === 0) return true; // keep the lowest always
      if (videoDetails.width < opt.width || videoDetails.height < opt.height) return false; // no upscaling
      return true;
    })
    .slice(0, MAX_REPRESENTATIONS)
    .map((opt, i) => ({
      id: `${i}`,
      width: opt.width,
      height: opt.height,
      bandwidth: opt.bitrate,
      codec: VIDEO_CODEC
    }));

  // Hardware capability filter (currently only applying 4K constraint for AMF H.264)
  if (VIDEO_ENCODER === 'h264_amf') {
    const filtered: Representation[] = [];
    for (const r of reps) {
      if (r.width > AMF_MAX_WIDTH || r.height > AMF_MAX_HEIGHT) {
        const msg = `[DASH] WARNING: Representation ${r.width}x${r.height} exceeds AMF limit ${AMF_MAX_WIDTH}x${AMF_MAX_HEIGHT}.`;
        if (ALLOW_SOFTWARE_FALLBACK) {
          console.warn(msg + ' Keeping (software fallback libx264).');
          filtered.push(r);
        } else {
          console.warn(msg + ' Dropping (enable PHOTRIX_ALLOW_SOFTWARE_FALLBACK=1 to keep).');
        }
      } else filtered.push(r);
    }
    return filtered;
  }
  return reps;
};

// Generate DASH segments and manifest for video file
// Note: Unlike thumbnail generators, this doesn't return a Buffer as DASH creates multiple files
export const videoToDash = (async ({ inputPathRelative }: { inputPathRelative: string }) => {
  // widths parameter ignored for DASH - uses config-based representations instead
  const fullInputPath = path.join(rootDir, inputPathRelative);
  const videoFileName = path.basename(inputPathRelative);
  const outputDir = path.join(mediaCacheDir, path.dirname(inputPathRelative));
  await fs.mkdir(outputDir, { recursive: true });

  const representations = await pickRepresentations(fullInputPath);
  const videoDetails = await getVideoDetails(fullInputPath);
  
  let hasAudio = false;
  try {
    const audioDetails = await getAudioDetails(fullInputPath);
    hasAudio = audioDetails.hasAudio;
  } catch (e) {
    console.warn('[DASH] No audio track detected or probe failed:', e);
  }

  // Build ffmpeg command
  const args: string[] = ['-y', ...HWACCEL_FLAG, '-i', fullInputPath];

  // Cascaded scaling filter graph (mirror session manager logic)
  let filterComplex = '';
  if (representations.length > 0) {
    const largestRep = representations[representations.length - 1];
    const largestLabel = `v_${largestRep.id}`;
    
    if (representations.length === 1) {
      filterComplex = `[0:v]format=nv12` + (largestRep.width && largestRep.height ? `,scale=${largestRep.width}:${largestRep.height}:flags=${BASE_SCALE_FLAGS}` : '') + `[${largestLabel}]`;
    } else {
      // Multi-representation scaling
      const splitOutputs: string[] = [];
      const otherBranches: { rep: Representation; tmpLabel: string; finalLabel: string }[] = [];
      
      for (const r of representations.slice(0, -1)) {
        const tmp = `tmp_${r.id}`;
        const final = `v_${r.id}`;
        splitOutputs.push(`[${tmp}]`);
        otherBranches.push({ rep: r, tmpLabel: tmp, finalLabel: final });
      }
      
      splitOutputs.unshift(`[${largestLabel}]`);
      const splitCount = splitOutputs.length;
      filterComplex = `[0:v]format=nv12,scale=${largestRep.width}:${largestRep.height}:flags=${BASE_SCALE_FLAGS},split=${splitCount}${splitOutputs.join('')}`;
      
      otherBranches.forEach(b => {
        filterComplex += `;[${b.tmpLabel}]scale=${b.rep.width}:${b.rep.height}:flags=${DOWNSCALE_FLAGS}[${b.finalLabel}]`;
      });
    }
    
    args.push('-filter_complex', filterComplex);
  }

  // Video encoding settings for each representation
  const videoArgs = representations.flatMap((rep, idx) => {
    const label = `v_${rep.id}`;
    const overLimit = (rep.width > AMF_MAX_WIDTH || rep.height > AMF_MAX_HEIGHT) && VIDEO_ENCODER === 'h264_amf';
    const encoder = overLimit && ALLOW_SOFTWARE_FALLBACK ? 'libx264' : VIDEO_ENCODER;
    
    if (overLimit && ALLOW_SOFTWARE_FALLBACK) {
      console.warn(`[DASH] Software fallback for rep ${rep.id} (${rep.width}x${rep.height}) using libx264.`);
    }
    
    const g = SEGMENT_DURATION_SEC * 30; // assume 30fps
    const baseArgs = [
      '-map', `[${label}]`,
      `-c:v:${idx}`, encoder,
      `-b:v:${idx}`, String(rep.bandwidth),
      `-maxrate:v:${idx}`, String(rep.bandwidth),
      `-bufsize:v:${idx}`, String(rep.bandwidth * 2),
      `-g:v:${idx}`, String(g),
      `-keyint_min:v:${idx}`, String(g),
      `-sc_threshold:v:${idx}`, '0'
    ];
    
    if (encoder === 'h264_amf') {
      return [
        ...baseArgs,
        `-pix_fmt:v:${idx}`, 'nv12',
        `-quality`, 'speed',
        `-usage`, 'transcoding'
      ];
    }
    
    return baseArgs;
  });

  // Audio settings
  const audioArgs = hasAudio ? [
    '-map', '0:a:0?',
    '-c:a', 'aac',
    '-b:a', String(AUDIO_BITRATE),
    '-ac', '2'
  ] : [];

  // DASH muxer settings
  const dashArgs = [
    '-f', 'dash',
    '-seg_duration', String(SEGMENT_DURATION_SEC),
    '-use_template', '1',
    '-use_timeline', '0',
    '-init_seg_name', videoFileName + '-init-$RepresentationID$.m4s',
    '-media_seg_name', videoFileName + '-chunk-$RepresentationID$-$Number$.m4s',
    '-remove_at_exit', '0',
    '-window_size', '0',
    '-extra_window_size', '0'
  ];

  const mpdPath = path.join(outputDir, `${videoFileName}.mpd`);
  const allArgs = [...args, ...videoArgs, ...audioArgs, ...dashArgs, mpdPath];

  // Execute ffmpeg
  const command = ['ffmpeg', ...allArgs].map(arg => arg.includes(' ') ? `"${arg}"` : arg).join(' ');
  console.log(`[DASH] Generating DASH segments for ${inputPathRelative}`);
  console.log(`[DASH] Output dir: ${outputDir}`);
  console.log(`[DASH] Command: ${command}`);

  const { stderr } = await promisify(exec)(command, { cwd: outputDir });
  if (stderr) {
    console.warn('[DASH] ffmpeg stderr:', stderr);
  }

  console.log(`[DASH] Generated DASH files for ${inputPathRelative}`);
});