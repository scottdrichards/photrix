import { JSX, useMemo, useRef } from "react";
import { mediaURLBase } from "../data/api";
import { useDimensions } from "../hooks/useDimensions";
import { SharedConstants } from "../../../shared/constants";

export type MediaBehavior = Partial<Pick<JSX.IntrinsicElements["img"], "fetchPriority"|"loading">>;

type Params = {
    path: string;
    aspectRatio?: number;
} & JSX.IntrinsicElements["img"];

export const SmartImage: React.FC<Params> = ({ path, aspectRatio, key: _, style, ...restProps }) => {
    const ref = useRef<HTMLImageElement>(null);
    const dimensions = useDimensions(ref);

    const baseUrl = new URL("."+path, mediaURLBase);
    
    // Calculate width based on container dimensions, not the image's loaded dimensions
    const width = useMemo(()=>{
        if (!dimensions) return 100;
        const {width} = dimensions;
        if (width) {
            return SharedConstants.thumbnailWidths.find(w => w >= width) || SharedConstants.thumbnailWidths[SharedConstants.thumbnailWidths.length - 1];
        }
        return 100;
    },[dimensions?.height, dimensions?.width]);

    const imageURL = new URL(baseUrl);
    imageURL.searchParams.set("width", `${Math.round(width)}`);

    return <img
        {...restProps}
        src={width ? imageURL.toString() : undefined}
        alt={`Image: ${path}`}
        ref={ref}
        style={{
            ...style,
        }}
    />;
};