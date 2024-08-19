import path from "path";
import http from "http";

import { getFileList } from "./getFileList";
import { getImage } from "./media/getImage";

if (process.argv.length < 4){
    console.error("Usage: node server.js <rootDir> <thumbnailDir>");
    process.exit(1);
}
const [,,rootDir, thumbnailDir] =  process.argv;

getFileList(rootDir, {recursive: true}).then(files=>{
    const dirs = files.map(file=>path.relative(rootDir, file));
    console.log(dirs.join('\n'));
});

var port = 9615

http.createServer(async (request, response)=> {
    
    if (!request.url){
        response.writeHead(404);
        response.end();
        return;
    }
    
    try {
        var {pathname, searchParams} = new URL(`http://${process.env.HOST ?? 'localhost'}${request.url}`);
        // need to use path.normalize so people can't access directories underneath baseDirectory
        const relativePath = path.normalize(decodeURI(pathname))

        const widthStr = searchParams.get('width');
        const width = widthStr && parseInt(widthStr);
        const heightStr = searchParams.get('height');
        const height = heightStr && parseInt(heightStr);

        const image = await getImage(relativePath, {
            rootDir,
            ...((width && height)?
            {
                width,
                height,
                thumbnailDir,
            }:{} as Record<string,never>),
        });

        response.writeHead(200, {'Content-Type': 'image/jpeg'})
        response.write(image);
        response.end()
   } catch(e) {
        response.writeHead(500)
        response.end()     // end the response so browsers don't hang
        console.log(e)
   }
}).listen(port)

console.log("listening on port "+port)