const getHEVCMimeTypes = (): readonly string[] => {
  const envValue = import.meta.env.VITE_HEVC_MIME_TYPES;
  if (!envValue) {
    // Fallback to default types if env var not set
    return [
      'video/mp4; codecs="hvc1"',
      'video/mp4; codecs="hev1"',
      'video/mp4; codecs="hvc1.1.6.L123.B0"',
      'video/mp4; codecs="hev1.1.6.L123.B0"',
      'video/quicktime; codecs="hvc1"',
      'video/quicktime; codecs="hev1"',
    ];
  }
  return envValue.split(",").map((t: string) => t.trim());
};

const HEVC_MIME_TYPES = getHEVCMimeTypes();

type NetworkInformationLike = {
  downlink?: number;
};

export type VideoPlaybackProfile = {
  bandwidthMbps: number | null;
  hevcSupported: boolean;
};

let cachedPlaybackProfile: VideoPlaybackProfile | null = null;
let pendingPlaybackProfile: Promise<VideoPlaybackProfile> | null = null;

const detectHevcSupport = (): boolean => {
  if (typeof document === "undefined") {
    return false;
  }

  const video = document.createElement("video");
  return HEVC_MIME_TYPES.some((mimeType) => {
    const supportLevel = video.canPlayType(mimeType);
    return supportLevel === "probably" || supportLevel === "maybe";
  });
};

const getNavigatorBandwidthEstimate = (): number | null => {
  if (typeof navigator === "undefined") {
    return null;
  }

  const connection = (navigator as Navigator & { connection?: NetworkInformationLike })
    .connection;
  if (typeof connection?.downlink !== "number" || !Number.isFinite(connection.downlink)) {
    return null;
  }

  return connection.downlink;
};

const buildPlaybackProfile = async (): Promise<VideoPlaybackProfile> => {
  const hevcSupported = detectHevcSupport();

  const profile = {
    bandwidthMbps: getNavigatorBandwidthEstimate(),
    hevcSupported,
  };

  console.info("[Video] Playback profile (no startup bandwidth probe)", profile);
  return profile;
};

export const probeVideoPlaybackProfile = (): Promise<VideoPlaybackProfile> => {
  if (cachedPlaybackProfile) {
    return Promise.resolve(cachedPlaybackProfile);
  }

  if (pendingPlaybackProfile) {
    return pendingPlaybackProfile;
  }

  pendingPlaybackProfile = buildPlaybackProfile().then((profile) => {
    cachedPlaybackProfile = profile;
    pendingPlaybackProfile = null;
    return profile;
  });

  return pendingPlaybackProfile;
};

export const resetVideoPlaybackProfileForTests = () => {
  cachedPlaybackProfile = null;
  pendingPlaybackProfile = null;
};