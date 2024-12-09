import http from "http";
import path from "path";
import fs from "fs/promises";

if (process.argv.length < 4){
    console.error("Usage: node server.js <rootDir>");
    process.exit(1);
}
const [,,rootDir, thumbnailDir] =  process.argv;


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

        const isDirectory = pathname.endsWith('/');
        if (isDirectory){
            const paths = (await fs.readdir(path.join(rootDir, pathname), {recursive: true}))
                .map(file=>path.relative(rootDir, file));

            response.writeHead(200, {'Content-Type': 'text/json'})
            response.write(JSON.stringify(paths));
            response.end()
            return;
        };

        const file = await fs.readFile(path.join(rootDir, pathname));
        if (file){
            response.writeHead(200, {'Content-Type': 'image/jpeg'})
            response.write(file);
            response.end()
            return;
        }
   } catch(e) {
        response.writeHead(500)
        response.end()     // end the response so browsers don't hang
        console.log(e)
   }
}).listen(port)

console.log("listening on port "+port)