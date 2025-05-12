import React, { memo } from "react";
import { mediaURLBase } from "./data/api";

type Params = {
  path: string;
  style?: React.CSSProperties;
  width?: number;
} & React.HTMLProps<HTMLImageElement>;

export const Media: React.FC<Params> = memo((params) => {
  const { path, style, width } = params;


  const url = new URL(encodeURIComponent(path), mediaURLBase);
  if (width) {
    url.searchParams.set("width", width.toString());
  }

  const renderers = [
    [
      ["jpg", "png", "jpeg", "gif", "heif", "heic", "webp"],
      () => (
        <img
          alt={path}
          style={{ objectFit: "contain", ...style }}
          src={url.toString()}
          loading="lazy"
        />
      ),
    ],
    [["mp4", "mov", "avi"], () => <></>],
  ] as const;

  const ext = path.split(".").at(-1) as string;

  const Renderer = renderers.find(([exts]) =>
    (exts as any as string[]).includes(ext.toLocaleLowerCase()),
  )?.[1];

  return Renderer ? <Renderer /> : <div>Unsupported file type</div>;
});
