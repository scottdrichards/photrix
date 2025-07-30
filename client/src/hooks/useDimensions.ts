import { RefObject, useEffect, useState } from "react";

export const useDimensions = (ref: RefObject<HTMLImageElement | null>) => {
    const [dimensions, setDimensions] = useState<{height:number, width:number}|null>(null);
    useEffect(() => {
        const resizeObserver = new ResizeObserver(([element]) => {
            setDimensions(element.contentRect ?? null);
        });
        if (ref?.current) {
            resizeObserver.observe(ref.current);
        }

        return () => {
            resizeObserver.disconnect();
        };
    }, [ref]);

    return dimensions;
};
