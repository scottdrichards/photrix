import path, { relative } from "path";
import http from "http";

import { getFileList } from "./getFileList";
import { getImage } from "./media/getImage";
import { server } from "./database";

server();

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
        
        // We don't want to allow access to parent directories
        if (pathname.includes('..')){
            response.writeHead(403)
            response.end()
            return;
        }

        if (pathname.endsWith('/')){
            const files = await getFileList(path.join(rootDir,pathname), {recursive: true});
            const relativePaths = files.map(file=>path.relative(rootDir, file));
            response.writeHead(200, {'Content-Type': 'text/json'})
            response.write(JSON.stringify(relativePaths));
            response.end()
            return;
        };

        const widthStr = searchParams.get('width');
        const width = widthStr && parseInt(widthStr);
        const heightStr = searchParams.get('height');
        const height = heightStr && parseInt(heightStr);

        const image = await getImage(pathname, {
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