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
  player.initialize(videoRef.current, mpdUrl, true);
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
