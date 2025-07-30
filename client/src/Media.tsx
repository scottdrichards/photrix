import React, { memo } from "react";
import { mediaURLBase } from "./data/api";
import { ImageSizedRight, MediaBehavior } from "./ImageSizedRight";

type Params = {
  path: string;
  aspectRatio?: number;
  thumbnailBehavior?: MediaBehavior;
  fullSizeBehavior?: MediaBehavior;
} & React.HTMLProps<HTMLImageElement>;

export const Media: React.FC<Params> = memo((params) => {
  const { path, width, aspectRatio, thumbnailBehavior, fullSizeBehavior, ...restProps } = params;

  const url = new URL(encodeURIComponent(path), mediaURLBase);
  if (width) {
    url.searchParams.set("width", width.toString());
  }

  const renderers = [
    [
      ["jpg", "png", "jpeg", "gif", "heif", "heic", "webp"],
      () => {
        
        const thumbnailUrl = new URL(url);
        thumbnailUrl.searchParams.set("width", "100");

        return (
          <ImageSizedRight
            path={path}
            aspectRatio={aspectRatio}
            thumbnailBehavior={thumbnailBehavior}
            fullSizeBehavior={fullSizeBehavior}
            {...restProps}
          />
        );
      },
    ],
    [["mp4", "mov", "avi"], () => <></>],
  ] as const;

  const ext = path.split(".").at(-1) as string;

  const Renderer = renderers.find(([exts]) =>
    (exts as any as string[]).includes(ext.toLocaleLowerCase()),
  )?.[1];

  return Renderer ? <Renderer /> : <div>Unsupported file type <code>{path}</code></div>;
});
