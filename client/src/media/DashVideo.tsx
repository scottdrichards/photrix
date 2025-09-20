import React from "react";
import * as dashjs from "dashjs";
import { useEffect, useRef } from "react";
import { mediaURLBase } from "../data/api";
import { SmartImage } from "./SmartImage";

const videoExtensions = ['.mp4', '.mov', '.mkv', '.avi', '.wmv', '.flv', '.webm'];

export const isVideo = (path:string)=> videoExtensions.some(ext => path.toLowerCase().endsWith(ext));

type Params = {
    path: string;
    /* defaults to false */
    thumbnail?: boolean;
}

export const DashVideo: React.FC<Params> = ({ path, thumbnail,...rest }) => {
    const videoRef = useRef<HTMLVideoElement | null>(null);

    useEffect(() => {
        if (!videoRef.current) return;
        const clean = path.startsWith('/') ? path.slice(1) : path;
        const mpdUrl = new URL(clean + '.mpd', mediaURLBase).toString();
        const player = dashjs.MediaPlayer().create();
        player.initialize(videoRef.current, mpdUrl, false); // Don't autoplay
        return () => {
            player.reset();
        };
    }, [path, videoRef.current, thumbnail]);

    return thumbnail ? 
     <SmartImage
     {...rest}
       path={path}
     /> : (
     <video ref={videoRef} preload="auto" />
   );
};