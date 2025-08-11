import { useCallback, useMemo, useRef, useState } from "react";
import { mediaURLBase } from "./data/api";
import { useDimensions } from "./hooks/useDimensions";

const standardizedWidth = (width: number) => {
    let bestWidth = 50;
    while (bestWidth < width) {
        bestWidth *= 2;
    }
    return bestWidth;
};

export type MediaBehavior = Partial<Pick<JSX.IntrinsicElements["img"], "fetchPriority"|"loading">> | "never";

type Params = {
    path: string;
    aspectRatio?: number;
    thumbnailBehavior?: MediaBehavior;
    fullSizeBehavior?: MediaBehavior;
} & React.HTMLProps<HTMLImageElement>

export const ImageSizedRight: React.FC<Params> = ({ path, aspectRatio, thumbnailBehavior, fullSizeBehavior, ...restProps }) => {
    const [fullSizeInCache, setFullSizeInCache] = useState(false);
    const ref = useRef<HTMLImageElement>(null);
    const dimensions = useDimensions(ref);

    const baseUrl = new URL("."+path, mediaURLBase);
    const desiredURL = useMemo(() => {
        if (dimensions) {
            const {width, height} = dimensions;
            const containerWidth = width && standardizedWidth(width);
            const heightConstrainedWidth = aspectRatio && height  && height * aspectRatio;
            const desiredWidth = containerWidth && heightConstrainedWidth ? Math.min(containerWidth, heightConstrainedWidth) : containerWidth || heightConstrainedWidth;
            if (desiredWidth) {
                const updatedUrl = new URL(baseUrl);
                updatedUrl.searchParams.set("width", desiredWidth.toString());
                return updatedUrl;
            }
        }
        return baseUrl;
    }, [path, dimensions]);

    const thumbnailURL = new URL(baseUrl);
    thumbnailURL.searchParams.set("width", "100");
    const alt = `Image: ${path}`;

    const loadFullSizeImageAfterThumbnail = useCallback(() => {
        if (fullSizeInCache || fullSizeBehavior === "never") {
            return;
        }
        // Use thumbnail image and replace when full image is loaded
        const fullImage = new Image();
        fullImage.src = desiredURL.toString();
        fullImage.onload = () => {
            setFullSizeInCache(true);
        };
    }, [desiredURL]);

    const renderFullSize = thumbnailBehavior === "never" || fullSizeInCache;

    const behavior = renderFullSize ? fullSizeBehavior : thumbnailBehavior;

    if (behavior === "never") {
        throw new Error(`Cannot use ${renderFullSize ? "full size" : "thumbnail"} image when ${renderFullSize ? "fullSizeBehavior" : "thumbnailBehavior"} is set to 'never'`);
    }

    return <img
            src={renderFullSize?desiredURL.toString():thumbnailURL.toString()}
            alt={alt}
            onLoad={!renderFullSize ? loadFullSizeImageAfterThumbnail : undefined}
            fetchPriority={behavior?.fetchPriority}
            loading={behavior?.loading}
            ref={ref}
            {...restProps}
        />;
};