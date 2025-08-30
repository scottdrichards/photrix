import * as dashjs from "dashjs";
import { mediaURLBase } from "./data/api";
import { ImageSizedRight, MediaBehavior } from "./ImageSizedRight";
import { useEffect, useRef } from 'react';

type Params = {
  path: string;
  thumbnailBehavior?: MediaBehavior;
  fullSizeBehavior?: MediaBehavior;
} & React.HTMLProps<HTMLImageElement>;

export const Media: React.FC<Params> = (params) => {
  const { path, width, thumbnailBehavior, fullSizeBehavior, ...restProps } = params;

  const renderers = [
    [
      ["jpg", "png", "jpeg", "gif", "heif", "heic", "webp"],
      () => (
        <ImageSizedRight
          path={path}
          thumbnailBehavior={thumbnailBehavior}
          fullSizeBehavior={fullSizeBehavior}
          {...restProps}
        />
      ),
    ],
  [["mp4", "mov", "avi", "mkv", "webm"], () => {
      const videoRef = useRef<HTMLVideoElement|null>(null);
      useEffect(() => {
    if (!videoRef.current) return;
  const clean = path.startsWith('/') ? path.slice(1) : path;
  const mpdUrl = new URL(clean + '.mpd', mediaURLBase).toString();
  const player = dashjs.MediaPlayer().create();
  
  // Configure adaptive bitrate settings
  player.updateSettings({
    streaming: {
      abr: {
        autoSwitchBitrate: {
          audio: true,
          video: true
        },
        initialBitrate: {
          audio: -1,      // Auto-select
          video: 250      // Start with lowest quality (160p) to avoid initial timeouts
        },
        maxBitrate: {
          audio: -1,      // No limit
          video: 1500     // Cap at 1.5Mbps to avoid high bitrate timeouts
        },
        minBitrate: {
          audio: -1,      // Use lowest available
          video: 250      // Use 250k (160p) as minimum
        }
      },
      buffer: {
        bufferToKeep: 10,           // Reduce buffer to 10s (was 20s)
        bufferTimeAtTopQuality: 60, // Need more buffer for top quality
        bufferTimeDefault: 12,       // Default buffer target
        bufferTimeAtTopQualityLongForm: 90
      },
      retryAttempts: {
        MediaSegment: 2,            // Reduce retries for faster switching
        InitializationSegment: 2,    
        MPD: 2                      
      },
      retryIntervals: {
        MediaSegment: 500,          // Faster retries
        InitializationSegment: 250,  
        MPD: 250                    
      }
    },
    debug: {
      logLevel: dashjs.Debug.LOG_LEVEL_DEBUG  // More detailed logging
    }
  });

  // Add event listeners for diagnostics
  player.on(dashjs.MediaPlayer.events.QUALITY_CHANGE_REQUESTED, (e) => {
    console.log('[DASH-ABR] Quality change requested:', e);
  });
  
  player.on(dashjs.MediaPlayer.events.QUALITY_CHANGE_RENDERED, (e) => {
    console.log('[DASH-ABR] Quality change rendered:', e);
  });
  
  player.on(dashjs.MediaPlayer.events.REPRESENTATION_SWITCH, (e) => {
    console.log('[DASH-ABR] Representation switch:', e);
  });
  
  player.on(dashjs.MediaPlayer.events.BUFFER_LEVEL_UPDATED, (e) => {
    console.log('[DASH-BUFFER] Buffer level:', e);
  });

  // Add error handling for timeouts and failed requests
  let consecutiveErrors = 0;
  player.on(dashjs.MediaPlayer.events.ERROR, (e) => {
    console.error('[DASH-ERROR] Player error:', e);
    consecutiveErrors++;
    
    // Check for download timeout errors
    if (e.error && typeof e.error === 'object' && 'code' in e.error) {
      console.log('[DASH-ERROR] Error code:', e.error.code, 'Consecutive errors:', consecutiveErrors);
      
      // Force switch to lowest quality after 2 consecutive errors
      if (consecutiveErrors >= 2) {
        console.log('[DASH-ERROR] Too many errors, forcing switch to lowest quality');
        try {
          // Disable ABR and force lowest quality
          player.updateSettings({
            streaming: {
              abr: {
                autoSwitchBitrate: { video: false, audio: true },
                initialBitrate: { video: 250, audio: -1 }  // Force 250k bitrate
              }
            }
          });
          console.log('[DASH-ERROR] Disabled video ABR and forced 250k bitrate');
          consecutiveErrors = 0; // Reset counter after manual intervention
        } catch (apiError) {
          console.error('[DASH-ERROR] Failed to force low quality:', apiError);
        }
      }
    }
  });

  // Reset error counter and potentially re-enable ABR on successful fragment loads
  player.on(dashjs.MediaPlayer.events.FRAGMENT_LOADING_COMPLETED, () => {
    if (consecutiveErrors > 0) {
      console.log('[DASH-SEGMENT] Fragment loaded successfully, resetting error counter');
      consecutiveErrors = 0;
      
      // Re-enable ABR after successful load
      setTimeout(() => {
        try {
          player.updateSettings({
            streaming: {
              abr: {
                autoSwitchBitrate: { video: true, audio: true }
              }
            }
          });
          console.log('[DASH-RECOVERY] Re-enabled video ABR after successful load');
        } catch (error) {
          console.warn('[DASH-RECOVERY] Failed to re-enable ABR:', error);
        }
      }, 5000); // Wait 5 seconds before re-enabling ABR
    }
  });

  player.on(dashjs.MediaPlayer.events.FRAGMENT_LOADING_ABANDONED, (e) => {
    console.warn('[DASH-SEGMENT] Fragment abandoned:', e);
  });

  player.on(dashjs.MediaPlayer.events.PLAYBACK_METADATA_LOADED, () => {
    console.log('[DASH-INFO] Manifest loaded, ABR should be active');
  });

  player.initialize(videoRef.current, mpdUrl, false); // Don't autoplay
    return () => { try { player.reset(); } catch {} };
      }, [path]);
      return <video ref={videoRef} style={{width: '100%', maxHeight:'100%'}} controls preload="auto" />;
    }],
  ] as const;

  const parts = path.split(".");
  const ext = parts[parts.length - 1] as string;

  const Renderer = renderers.find(([exts]) =>
    (exts as any as string[]).includes(ext.toLocaleLowerCase()),
  )?.[1];

  return Renderer ? <Renderer /> : <div>Unsupported file type <code>{path}</code></div>;
};
