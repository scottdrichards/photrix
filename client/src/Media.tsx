import { mediaURLBase } from "./data/api";
import { ImageSizedRight, MediaBehavior } from "./ImageSizedRight";

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
      () => {
        
        const thumbnailUrl = new URL(mediaURLBase);
        thumbnailUrl.searchParams.set("width", "100");

        return (
          <ImageSizedRight
            path={path}
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
};
