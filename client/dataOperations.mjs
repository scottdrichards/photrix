export const dataPort = 9615;

/**
 * Fetches the contents of a directory from the server.
 * 
 * @param {string} path - The path of the directory whose contents are to be fetched.
 * @returns {Promise<{path:string, type:'directory'|'file'}[]>} A promise that resolves with the contents of the directory.
 */
export const getContentsOfDirectory = async (path) => {
    const {originNoPort} = getOriginAndPort();
    const response = await fetch(`${originNoPort}:${dataPort}${path}`);
    if (!response.ok){
        throw new Error(`Failed to get contents of ${path}`);
    }
    return await response.json();
}

export const getAllFileNames = async ()=>{
    const {originNoPort} = getOriginAndPort();
    const response = await fetch(`${originNoPort}:${dataPort}/allFileNames`);
    if (!response.ok){
        throw new Error(`Failed to get tree`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let { value: chunk, done: readerDone } = await reader.read();
    let text = '';

    while (!readerDone) {
        text += decoder.decode(chunk, { stream: true });
        let lines = text.split('\n');
        text = lines.pop(); // Keep the last partial line for the next chunk

        for (let line of lines) {
            if (line.trim() !== '') {
                yield line;
            }
        }

        ({ value: chunk, done: readerDone } = await reader.read());
    }

    if (text.trim() !== '') {
        yield text;
    }
}

export const getOriginAndPort = () => {
    const [originNoPort, port] = window.location.origin.split(/:\d+/);
    return { originNoPort, port };
}

export const generateDatabase = async () => {
    const fileNames = await getAllFileNames();

    const request = indexedDB.open('fileDatabase', 1);

    request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains('files')) {
            db.createObjectStore('files', { keyPath: 'id', autoIncrement: true });
        }
    };

    request.onsuccess = (event) => {
        const db = event.target.result;
        const transaction = db.transaction('files', 'readwrite');
        const store = transaction.objectStore('files');

        fileNames.forEach((fileName) => {
            store.add({ name: fileName });
        });

        transaction.oncomplete = () => {
            console.log('All files have been added to the database.');
        };

        transaction.onerror = (event) => {
            console.error('Transaction failed:', event.target.error);
        };
    };

    request.onerror = (event) => {
        console.error('Database error:', event.target.error);
    };

    return {
        search: async (query) => {
            const queryLower = query.toLocaleLowerCase();
            return DB.fileNames.filter(file => file.toLocaleLowerCase().includes(queryLower));
        },
    }
}