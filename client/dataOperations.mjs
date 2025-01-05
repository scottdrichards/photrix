/**
 * Fetches the contents of a directory from the server.
 * 
 * @param {string} path - The path of the directory whose contents are to be fetched.
 * @returns {Promise<{path:string, type:'directory'|'file'}[]>} A promise that resolves with the contents of the directory.
 */
export const getContentsOfDirectory = async (path) => {
    const originNoPort = window.location.origin.split(/:\d+/).at(0);
    const response = await fetch(`${originNoPort}:9615` + path);
    if (!response.ok){
        throw new Error(`Failed to get contents of ${path}`);
    }
    return await response.json();
}