import { exec } from "node:child_process";
import path from "node:path"
import { promisify } from "node:util";
import { dashConfig } from "./dashConstants";
import { getVideoDetails } from "./getVideoDetails";
import { mkdir } from "node:fs/promises";

const runCommand = async (cmd:string)=>{
    console.log("running command: ", cmd);
    const result = await  promisify(exec)(cmd);
    if (result.stderr) {
        // throw new Error(result.stderr);
    }
    return result.stdout;
}

export const createDashFiles = async (relativeSourcePath:string, rootDir:string, cacheRootDir:string)=>{
    const fullSourcePath = path.join(rootDir, relativeSourcePath)
    const relativeDir = path.dirname(relativeSourcePath);
    const sourceFileName = path.basename(relativeSourcePath);

    await mkdir(path.join(cacheRootDir,relativeDir), { recursive: true });

    const audioFullPath = path.join(cacheRootDir,relativeDir, `${sourceFileName}_audio.m4a`);
    const createAudioVariantCmd = `ffmpeg -y -i "${fullSourcePath}" -vn -acodec aac -ab 128k -dash 1 "${audioFullPath}"`
    await runCommand(createAudioVariantCmd);

    const videoProbe = await getVideoDetails(fullSourcePath);

    const dashVideoStreams = dashConfig.videoQualityOptions.filter((option, index) => {
        if (index === 0){
            return true;
        }
        if (videoProbe.width >option.width || videoProbe.height > option.height){
            return false;
        }
        return true;
    }).map(configuration => ({
        relativePath: path.join(relativeDir, `${sourceFileName}_video_${configuration.width}x${configuration.height}_${configuration.bitrate}.m4v`),
        configuration,
    }));

    const createVideoVariantsCmd = [
        "ffmpeg",
        "-i", `"${fullSourcePath}"`,
        "-y", //force
        '-c:v', 'h264_amf',
        '-keyint_min', '150',
        '-g', '150',
        '-f', 'mp4',    
        '-movflags',
        '+faststart',
        ...dashVideoStreams.flatMap(({relativePath,configuration})=>[
            '-an',
            '-vf', `scale=${configuration.width}:${configuration.height}`,
            '-b:v', configuration.bitrate,
            '-dash', '1', // lets ffmpeg know it's a dash file (i.e., "isDash = true")
            `"${path.join(cacheRootDir, relativePath)}"`
        ])
    ].join(' ');

    await runCommand(createVideoVariantsCmd);

    const videoStreamLabels = dashVideoStreams.map(({configuration})=>`${configuration.width}x${configuration.height}:${configuration.bitrate}`);
    const streamLabels = ['audio',...videoStreamLabels]
    const createDashManifestCmd = [
        'ffmpeg',
        '-f', 'webm_dash_manifest', '-i', `"${audioFullPath}"`,
        ...dashVideoStreams.flatMap(({relativePath,configuration})=>[
            '-f', 'webm_dash_manifest', '-i', `"${relativePath}"`
        ]),
        '-c', 'copy',
        ...streamLabels.flatMap(streamLabel=>['-map',streamLabel]),
        '-f', 'webm_dash_manifest',
        '-adaptation_sets', `"id=0,streams=${streamLabels.join(',')}"`,
        `"${path.join(cacheRootDir,relativeSourcePath+'.mpd')}"`
    ].join(" ");

    await runCommand(createDashManifestCmd);
}