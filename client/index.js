document.addEventListener('DOMContentLoaded', () => {
    const root = document.getElementById('root');
    
    /**
     * Renders the contents of a directory as a nested list in the given parent element.
     * 
     * @param {HTMLElement} parent - The parent HTML element to which the directory contents will be appended.
     * @param {string} path - The path of the directory to be rendered.
     * @returns {Promise<void>} A promise that resolves when the directory contents have been rendered.
     */
    const renderDirectory = async (parent, path) => {
        const contents = (await getContentsOfDirectory(path)).toSorted((a,b)=>{
            if (a.type === b.type){
                return a.path.localeCompare(b.path);
            }
            return a.type === 'directory' ? -1 : 1;
        });

        const ul = document.createElement('ul');
        parent.appendChild(ul);
        contents.forEach(({path, type}) => {
            const li = document.createElement('li');
            const name = path.split('/').at(-1);
            if (type === 'directory') {
                li.className = 'directory';
                li.dataset.expanded = 'false';
                const title = document.createElement('span');
                title.className = 'title';
                title.textContent = name;
                li.appendChild(title);
                title.addEventListener('click', async (e) => {
                    e.preventDefault();
                    li.dataset.expanded = li.dataset.expanded === 'false' ? 'true' : 'false';
                    if (li.dataset.expanded === 'true') {
                        await renderDirectory(li, path);
                    }else{
                        li.removeChild(li.querySelector('ul'));
                    }
                });
            }else{
                li.className = 'file title';
                li.textContent = name;
            }
            ul.appendChild(li);
        });
    }
    renderDirectory(root, '/media/');   

});

/**
 * Fetches the contents of a directory from the server.
 * 
 * @param {string} path - The path of the directory whose contents are to be fetched.
 * @returns {Promise<{path:string, type:'directory'|'file'}[]>} A promise that resolves with the contents of the directory.
 */
const getContentsOfDirectory = async (path) => {
    const originNoPort = window.location.origin.split(/:\d+/).at(0);
    const response = await fetch(`${originNoPort}:9615` + path);
    if (!response.ok){
        throw new Error(`Failed to get contents of ${path}`);
    }
    return await response.json();
}