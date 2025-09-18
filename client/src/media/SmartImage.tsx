import { JSX, useRef } from "react";
import { mediaURLBase } from "../data/api";
import { useDimensions } from "../hooks/useDimensions";

const standardizedWidth = (width: number) => {
    let bestWidth = 50;
    while (bestWidth < width) {
        bestWidth *= 2;
    }
    return bestWidth;
};

export type MediaBehavior = Partial<Pick<JSX.IntrinsicElements["img"], "fetchPriority"|"loading">>;

type Params = {
    path: string;
    aspectRatio?: number;
} & JSX.IntrinsicElements["img"];

export const SmartImage: React.FC<Params> = ({ path, aspectRatio, ...restProps }) => {
    const ref = useRef<HTMLImageElement>(null);
    const dimensions = useDimensions(ref);

    const baseUrl = new URL("."+path, mediaURLBase);
    if (dimensions) {
        const {width, height} = dimensions;
        const containerWidth = width && standardizedWidth(width);
        const heightConstrainedWidth = aspectRatio && height  && height * aspectRatio;
        const desiredWidth = containerWidth && heightConstrainedWidth ? Math.min(containerWidth, heightConstrainedWidth) : containerWidth || heightConstrainedWidth;
        if (desiredWidth) {
            baseUrl.searchParams.set("width", desiredWidth.toString());
        }
    }

    const imageURL = new URL(baseUrl);
    imageURL.searchParams.set("width", "100");
    const alt = `Image: ${path}`;

    return <img
        {...restProps}
        src={imageURL.toString()}
        alt={alt}
        ref={ref}
        style={{...restProps.style, contentVisibility:"auto"}}
    />;
};