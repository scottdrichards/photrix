import { getContentsOfDirectory } from "./dataOperations.mjs";
class FolderExplorer extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
    }

    connectedCallback() {
        const renderDirectoryContents = async (directoryPath) =>{
            const ul = document.createElement('ul');
            ul.classList.add('directory-contents');
            const elements = await getContentsOfDirectory(directoryPath);
            elements.forEach(({path, type}) => {
                const li = document.createElement('li');
                li.classList.add(type);

                const elementTitle = document.createElement('div');
                if (type === 'directory') {
                    const expand = document.createElement('button');
                    expand.textContent = '▶';
                    expand.dataset.expanded = 'false';
                    expand.addEventListener('click', async (e) => {
                        e.stopPropagation();
                        if (expand.dataset.expanded === 'false') {
                            expand.dataset.expanded = 'true';
                            const subDir = await renderDirectoryContents(path);
                            li.appendChild(subDir);
                            expand.textContent = '▼';
                        } else {
                            expand.dataset.expanded = 'false';
                            li.removeChild(li.querySelector('ul'));
                            expand.textContent = '▶';
                        }
                    });
                    elementTitle.appendChild(expand);
                }
                const name = path.split('/').at(-1);
                const nameElement = document.createElement('span');
                nameElement.textContent = name;
                nameElement.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.onChange?.(path);
                });
                elementTitle.appendChild(nameElement);
                li.appendChild(elementTitle);
                ul.appendChild(li);
            });
            return ul;
        };
        renderDirectoryContents(this.dataset.path).then((ul) => {
            this.shadowRoot.appendChild(ul);
        });
    }
}

customElements.define('folder-explorer', FolderExplorer);