import { rootDir } from "config"
import { webpCachePath } from "fileGenerators/webpCachePath"
import { exec } from "node:child_process";
import path from "node:path"
import { promisify } from "node:util";
import type { FileGeneratorType } from "./FileGeneratorType";


export const heicToThumbnails = (async ({inputPathRelative, widths}) => {
    const source = path.join(rootDir, inputPathRelative);
    const inMemoryAlias = 'mpr:img';
    
    const resizeOutCommands = widths?.flatMap(width => [
        inMemoryAlias, "-resize", `${width}x`, "+write", webpCachePath(inputPathRelative, { width }), "+delete"
    ])

    const noResizeOutCommand = [
        inMemoryAlias, "+write", webpCachePath(inputPathRelative, {}), "+delete"
    ]

    const command = [
        'magick',
        source,
        "-write", inMemoryAlias, "+delete",
        ...(resizeOutCommands?.length ? resizeOutCommands : noResizeOutCommand),
        "null:",
    ].map(arg=> arg.includes(' ') ? `"${arg}"` : arg)
    .join(' ');

    const {stderr} = await promisify(exec)(command);
    if (stderr) {
        console.error('[HEIC->WebP] Error converting HEIC to WebP:', stderr);
        throw new Error(`Error converting HEIC to WebP: ${stderr}`);
    }
}) satisfies FileGeneratorType;