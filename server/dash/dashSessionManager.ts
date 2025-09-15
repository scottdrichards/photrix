import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import { getVideoDetails, getAudioDetails } from './getVideoDetails';
import { dashConfig, AUDIO_BITRATE, AUDIO_CODEC, VIDEO_CODEC, SEGMENT_DURATION_SEC } from './dashConstants';
import { mediaCacheDir, rootDir } from '../config';

// Hardware / encoder configuration & limits
const AMF_MAX_WIDTH = Number(process.env.PHOTRIX_AMF_MAX_WIDTH || 4096);
const AMF_MAX_HEIGHT = Number(process.env.PHOTRIX_AMF_MAX_HEIGHT || 4096);
const ALLOW_SOFTWARE_FALLBACK = process.env.PHOTRIX_ALLOW_SOFTWARE_FALLBACK === '1';
const VIDEO_ENCODER = process.env.PHOTRIX_VIDEO_ENCODER || 'h264_amf'; // could be hevc_amf, h264_nvenc, libx264, etc.
const BASE_SCALE_FLAGS = process.env.PHOTRIX_BASE_SCALE_FLAGS || 'bilinear';
const DOWNSCALE_FLAGS = process.env.PHOTRIX_DOWNSCALE_FLAGS || 'fast_bilinear';
// Basic hwaccel choice (minimal detection for now)
const HWACCEL_FLAG: string[] = (() => {
  if (process.platform === 'win32') return ['-hwaccel', 'dxva2'];
  if (process.platform === 'linux') {
    if (process.env.PHOTRIX_VAAPI_DEVICE) return ['-hwaccel', 'vaapi', '-vaapi_device', process.env.PHOTRIX_VAAPI_DEVICE];
    return ['-hwaccel', 'vaapi'];
  }
  return [];
})();

// Representation definition
export type Representation = {
  id: string;
  width: number;
  height: number;
  bandwidth: number; // bits per second (approx average)
  codec: string;
};

export interface DashSessionOptions {
  segmentDurationSeconds?: number;
}

interface DashSession {
  sourceRelativePath: string;
  absoluteSourcePath: string;
  cacheDir: string;
  slug: string; // unique stable identifier used in segment file names
  representations: Representation[];
  audio: { codec: string; bandwidth: number } | null;
  mpdXml: string | null; // generated lazily
  encoderStarted: boolean;
  encoder?: ChildProcess;
  startPromise?: Promise<void>;
  lastAccess: number; // epoch ms
  closed: boolean;
}

const sessions = new Map<string, DashSession>();

const CLEANUP_IDLE_MS = 30 * 60 * 1000; // 30 min idle
const FILE_WAIT_TIMEOUT_MS = 10_000;
const INIT_FILE_WAIT_TIMEOUT_MS = 30_000; // allow longer for initial init segments
const FILE_WAIT_INTERVAL_MS = 120;

// Periodic cleanup
setInterval(() => {
  const now = Date.now();
  for (const [key, session] of sessions.entries()) {
    if (session.closed) continue;
    if (now - session.lastAccess > CLEANUP_IDLE_MS) {
      console.log(`[DASH] Cleaning idle session ${key}`);
      try { session.encoder?.kill('SIGTERM'); } catch {}
      session.closed = true;
      sessions.delete(key);
    }
  }
}, 60_000).unref();

const ensureDir = async (dir:string) => {
  await fs.mkdir(dir, { recursive: true });
};

const buildMPD = (session: DashSession, durationSeconds: number, segmentDurationSeconds: number): string => {
  const now = new Date().toISOString();
  const mediaPresentationDuration = `PT${Math.floor(durationSeconds)}S`;
  const profiles = 'urn:mpeg:dash:profile:isoff-live:2011';

  // We'll use SegmentTemplate with $Number$ starting at 1.
  const segmentTemplate = (repId:string) => `    <SegmentTemplate timescale="1" initialization="${session.slug}-init-${repId}.m4s" media="${session.slug}-chunk-${repId}-$Number$.m4s" startNumber="1" duration="${segmentDurationSeconds}" />`;

  const videoAdaptation = (session.representations && session.representations.length
    ? session.representations.map(r => `      <Representation id="${r.id}" bandwidth="${r.bandwidth}" width="${r.width}" height="${r.height}" codecs="${r.codec}" mimeType="video/mp4">
${segmentTemplate(r.id)}
      </Representation>`).join('\n')
    : '      <!-- no video representations available -->');

  // Audio representation id will follow immediately after last video rep index to align with ffmpeg's numeric naming pattern.
  const audioRepId = session.representations.length.toString();
  const audioAdaptation = session.audio ? `    <AdaptationSet id="1" contentType="audio" mimeType="audio/mp4" codecs="${session.audio.codec}" lang="en">
      <Representation id="${audioRepId}" bandwidth="${session.audio.bandwidth}" audioSamplingRate="48000">
        ${segmentTemplate(audioRepId)}
      </Representation>
    </AdaptationSet>` : '';

  return `<?xml version="1.0" encoding="UTF-8"?>\n<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" profiles="${profiles}" minBufferTime="PT2S" mediaPresentationDuration="${mediaPresentationDuration}" availabilityStartTime="${now}">\n  <Period start="PT0S" duration="${mediaPresentationDuration}">\n    <AdaptationSet id="0" contentType="video" mimeType="video/mp4">\n${videoAdaptation}\n    </AdaptationSet>\n${audioAdaptation}\n  </Period>\n</MPD>`;
};

const pickRepresentations = async (sourcePath:string): Promise<Representation[]> => {
  const videoDetails = await getVideoDetails(sourcePath);
  const max = Number(process.env.DASH_MAX_REPRESENTATIONS || '4');
  const reps = dashConfig.videoQualityOptions
    .filter((opt, idx) => {
      if (idx === 0) return true; // keep the lowest always
      if (videoDetails.width < opt.width || videoDetails.height < opt.height) return false; // no upscaling
      return true;
    })
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

const waitForFile = async (fullPath: string, timeoutMs = FILE_WAIT_TIMEOUT_MS): Promise<boolean> => {
  const start = Date.now();
  let attempts = 0;
  while (Date.now() - start < timeoutMs) {
    try {
      await fs.access(fullPath);
      if (attempts > 0) {
        console.log(`[DASH] File became available after ${attempts} attempts: ${path.basename(fullPath)}`);
      }
      return true;
    } catch {
      if (attempts % 25 === 0 && attempts > 0) {
        console.log(`[DASH] Waiting for ${path.basename(fullPath)} (${Math.round((Date.now() - start)/1000)}s elapsed)`);
      }
      attempts++;
      await new Promise(r => setTimeout(r, FILE_WAIT_INTERVAL_MS));
    }
  }
  console.warn(`[DASH] Timeout waiting for ${path.basename(fullPath)} after ${Math.round((Date.now()-start)/1000)}s`);
  return false;
};

const startEncoder = async (session: DashSession, segmentDurationSeconds: number) => {
  if (session.encoderStarted) return session.startPromise;

  session.encoderStarted = true;
  const startP = (async () => {
    // Prepare ffmpeg command with hwaccel before input.
    const input = session.absoluteSourcePath;
    const args: string[] = ['-y', ...HWACCEL_FLAG, '-i', input];

    // ------------------------------------------------------------------
    // Cascaded scaling filter graph (single decode -> largest rep -> split -> downscale others)
    // ------------------------------------------------------------------
    const reps = session.representations;
    if (reps.length === 0) {
      console.warn('[DASH] No video representations selected; proceeding without video encodes.');
    }

    let filterComplex = '';
    const largestRep = reps[reps.length - 1]; // pickRepresentations outputs ascending quality
    const largestLabel = `v_${largestRep?.id}`;
    if (reps.length === 1 && largestRep) {
      // Single rep: optional scale only if size differs; still enforce format=nv12 for AMF
      filterComplex = `[0:v]format=nv12` + (largestRep.width && largestRep.height ? `,scale=${largestRep.width}:${largestRep.height}:flags=${BASE_SCALE_FLAGS}` : '') + `[${largestLabel}]`;
    } else if (reps.length > 1) {
      // Build split outputs (one for base + one per *other* rep)
      const splitOutputs: string[] = [];
      // We will create one temporary branch per non-largest rep
      const otherBranches: { rep: Representation; tmpLabel: string; finalLabel: string }[] = [];
      for (const r of reps.slice(0, -1)) { // all but largest
        const tmp = `tmp_${r.id}`;
        const final = `v_${r.id}`;
        splitOutputs.push(`[${tmp}]`);
        otherBranches.push({ rep: r, tmpLabel: tmp, finalLabel: final });
      }
      // Add largest output label last so order matches branches count
      splitOutputs.unshift(`[${largestLabel}]`); // first output of split is base largest label
      const splitCount = splitOutputs.length;
      // Base chain always scales to largest (even if same size; minimal overhead) then splits
      filterComplex = `[0:v]format=nv12,scale=${largestRep.width}:${largestRep.height}:flags=${BASE_SCALE_FLAGS},split=${splitCount}${splitOutputs.join('')}`;
      // Now add scale filters for each smaller rep
      otherBranches.forEach(b => {
        filterComplex += `;[${b.tmpLabel}]scale=${b.rep.width}:${b.rep.height}:flags=${DOWNSCALE_FLAGS}[${b.finalLabel}]`;
      });
    }
    if (filterComplex) {
      args.push('-filter_complex', filterComplex);
    }

    // For each representation create mapping & encoder settings (remove old -s based approach)
    reps.forEach((rep, idx) => {
      const label = `v_${rep.id}`;
      args.push('-map', `[${label}]`);
      const overLimit = (rep.width > AMF_MAX_WIDTH || rep.height > AMF_MAX_HEIGHT) && VIDEO_ENCODER === 'h264_amf';
      const encoder = overLimit && ALLOW_SOFTWARE_FALLBACK ? 'libx264' : VIDEO_ENCODER;
      if (overLimit && ALLOW_SOFTWARE_FALLBACK) {
        console.warn(`[DASH] Software fallback for rep ${rep.id} (${rep.width}x${rep.height}) using libx264.`);
      } else if (overLimit) {
        console.warn(`[DASH] Representation ${rep.width}x${rep.height} exceeded AMF limits but fallback disabled (may fail).`);
      }
      args.push(`-c:v:${idx}`, encoder);
      args.push(`-b:v:${idx}`, String(rep.bandwidth));
      args.push(`-maxrate:v:${idx}`, String(rep.bandwidth));
      args.push(`-bufsize:v:${idx}`, String(rep.bandwidth * 2));
      const g = segmentDurationSeconds * 30; // assume 30fps input
      args.push(`-g:v:${idx}`, String(g));
      args.push(`-keyint_min:v:${idx}`, String(g));
      args.push(`-sc_threshold:v:${idx}`, '0');
      if (encoder === 'h264_amf') {
        args.push(`-pix_fmt:v:${idx}`, 'nv12');
        // Optional AMF tuning flags (only if user sets env to enable) – can extend later
        if (process.env.PHOTRIX_AMF_QUALITY) args.push(`-quality:v:${idx}`, process.env.PHOTRIX_AMF_QUALITY);
        if (process.env.PHOTRIX_AMF_USAGE) args.push(`-usage:v:${idx}`, process.env.PHOTRIX_AMF_USAGE);
        if (process.env.PHOTRIX_AMF_ASYNC_DEPTH) args.push(`-async_depth:v:${idx}`, process.env.PHOTRIX_AMF_ASYNC_DEPTH);
      }
    });
    if (filterComplex) {
      console.log('[DASH] filter_complex:', filterComplex);
    }

    // Audio (single track) if present
    if (session.audio) {
        args.push('-map', '0:a:0?');
        args.push('-c:a', 'aac');
      args.push('-b:a', String(session.audio.bandwidth));
      args.push('-ac', '2');
    }

    // DASH muxer (let ffmpeg produce segments). We'll discard its MPD (write to temp) and supply our own MPD content.
    args.push(
      '-f', 'dash',
      '-seg_duration', String(segmentDurationSeconds),
      '-use_template', '1',
      '-use_timeline', '0',
      '-init_seg_name', session.slug + '-init-$RepresentationID$.m4s',
      '-media_seg_name', session.slug + '-chunk-$RepresentationID$-$Number$.m4s',
      '-remove_at_exit', '0',
      '-window_size', '0', // static VOD style
      '-extra_window_size', '0'
    );

  // Write temp MPD in cache directory (cwd will be set), use relative name so ffmpeg emits segments into cacheDir
  const tempMPD = 'temp.mpd';
  args.push(tempMPD);

    const spawnWithArgs = (codecLabel:string,) => {
      console.log(`[DASH] Spawn dir: ${session.cacheDir}`);
      console.log(`[DASH] HWACCEL: ${HWACCEL_FLAG.join(' ') || '(none)'}  ENCODER(base): ${VIDEO_ENCODER}  FALLBACK_ALLOWED: ${ALLOW_SOFTWARE_FALLBACK}`);
      console.log(`[DASH] Spawning ffmpeg (${codecLabel}):`, 'ffmpeg ' + args.join(' '));
      const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: session.cacheDir });
      proc.stdout.on('data', d => console.log('[ffmpeg-out]', d.toString().trim()));
      proc.stderr.on('data', d => console.log('[ffmpeg-err]', d.toString().trim()));
      return proc;
    };

    let encoder = spawnWithArgs('h264_amf');
    session.encoder = encoder;
    let exitedEarly = true;
    const earlyTimer = setTimeout(() => { exitedEarly = false; }, 1500); // if it survives 1.5s assume stable

    encoder.on('close', code => {
      clearTimeout(earlyTimer);
      console.log(`[DASH] ffmpeg exited with code ${code}`);
      session.closed = true;
    });
  })();
  session.startPromise = startP;
  return startP;
};

export const getOrCreateSession = async (relativeSourcePath: string, opts: DashSessionOptions = {}): Promise<DashSession> => {
  const key = relativeSourcePath;
  const existing = sessions.get(key);
  if (existing) {
    existing.lastAccess = Date.now();
    return existing;
  }

  const absoluteSourcePath = path.join(rootDir, relativeSourcePath);
  const cacheDir = path.join(mediaCacheDir, path.dirname(relativeSourcePath));
  await ensureDir(cacheDir);

  const representations = await pickRepresentations(absoluteSourcePath);
  let audio: DashSession['audio'] = null;
  try {
    const audioDetails = await getAudioDetails(absoluteSourcePath);
    if (audioDetails.hasAudio) {
      audio = { codec: AUDIO_CODEC, bandwidth: AUDIO_BITRATE };
    }
  } catch (e) {
    console.warn('[DASH] No audio track detected or probe failed:', e);
  }

  // Build MPD after session object is fully formed to prevent undefined property access
  const videoDetails = await getVideoDetails(absoluteSourcePath);
  const segmentDurationSeconds = opts.segmentDurationSeconds ?? SEGMENT_DURATION_SEC;
  const baseName = path.basename(relativeSourcePath, path.extname(relativeSourcePath));
  const slug = baseName.replace(/[^a-zA-Z0-9_-]/g, '_');

  const session: DashSession = {
    sourceRelativePath: relativeSourcePath,
    absoluteSourcePath,
    cacheDir,
    slug,
    representations,
    audio,
    mpdXml: null,
    encoderStarted: false,
    lastAccess: Date.now(),
    closed: false,
  };
  // Guard: if no video representations found, still provide empty adaptation set
  session.mpdXml = buildMPD(session, videoDetails.duration, segmentDurationSeconds);
  sessions.set(key, session);
  return session;
};

export const ensureEncodingStartedForFile = async (relativeSourcePath: string): Promise<DashSession> => {
  const session = await getOrCreateSession(relativeSourcePath);
  if (!session.encoderStarted) {
    await startEncoder(session, SEGMENT_DURATION_SEC);
  }
  return session;
};

export const awaitDashFile = async (relativeSourcePath: string, fileName: string): Promise<Buffer | null> => {
  const session = await ensureEncodingStartedForFile(relativeSourcePath);
  session.lastAccess = Date.now();

  const fullPath = path.join(mediaCacheDir, path.dirname(relativeSourcePath), fileName);
  const exists = await waitForFile(fullPath);
  if (!exists) return null;
  return fs.readFile(fullPath);
};

export const awaitDashFileBySlug = async (slug: string, fileName: string): Promise<Buffer | null> => {
  // Find session by slug quickly (O(n) acceptable for small set). Could optimize with secondary map if needed.
  let session: DashSession | undefined;
  for (const s of sessions.values()) {
    if (s.slug === slug) { session = s; break; }
  }
  if (!session) return null;
  session.lastAccess = Date.now();
  if (!session.encoderStarted) {
    await startEncoder(session, SEGMENT_DURATION_SEC);
  }
  const fullPath = path.join(mediaCacheDir, path.dirname(session.sourceRelativePath), fileName);
  const isInit = /-init-/.test(fileName);
  const exists = await waitForFile(fullPath, isInit ? INIT_FILE_WAIT_TIMEOUT_MS : FILE_WAIT_TIMEOUT_MS);
  if (!exists) return null;
  return fs.readFile(fullPath);
};

export const getMpdForSource = async (relativeSourcePath: string): Promise<string> => {
  const session = await getOrCreateSession(relativeSourcePath);
  session.lastAccess = Date.now();
  return session.mpdXml || '';
};
