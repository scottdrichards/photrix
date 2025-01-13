import { getContentsOfDirectory } from "./dataOperations.mjs";
import { QQQ } from "./notAFramework.mjs";

export const folderExplorer2 = QQQ`<div>
    <img src=${𐤈`src`}>
    <button onclick=${(e)=>console.log(e)}>Click me</button>
</div>`;


class FolderExplorer extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
    }

    connectedCallback() {
        const renderDirectoryContents = async (directoryPath) => {
            const domString = `<ul class="directory-contents">
                ${await getContentsOfDirectory(directoryPath)
                    .then(elements => elements.map(({ path, type }) => 
                        `<li data-type="${type}" data-path="${path}">
                            <div class="title">
                                ${type === 'directory' ? '<button class="expand" data-expanded="false">▶</button>' : ''}
                                <span class='name'>${path.split('/').at(-1)}</span>
                            </div>
                        </li>`)
                    .join(''))}
            </ul>`;

            const domElement = new DOMParser().parseFromString(domString, 'text/html').body.firstChild;
            domElement.querySelectorAll('button[data-expanded]').forEach(button => {
                button.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const li = button.closest('li[data-type="directory"]');
                    if (button.dataset.expanded === 'false') {
                        button.dataset.expanded = 'true';
                        const subDir = await renderDirectoryContents(li.dataset.path);
                        li.appendChild(subDir);
                    } else {
                        button.dataset.expanded = 'false';
                        li.removeChild(li.querySelector('ul.directory-contents'));
                    }
                });
            });
            domElement.querySelectorAll('span.name').forEach(span => {
                span.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const li = span.closest('li');
                    const event = new CustomEvent('selectedElement', { detail: { path: li.dataset.path, type: li.dataset.type }, bubbles:true, composed:true });
                    li.dispatchEvent(event);
                });
            });
            return domElement;
        };

        renderDirectoryContents(this.dataset.path).then((ulContent) => {
            const folderExplorerWindow = new DOMParser().parseFromString(`
                <div class="folder-explorer-window">
                    <div class="folder-explorer-wrapper"></div>
                </div>`, 'text/html').body.firstChild;

            const folderExplorerWrapper = folderExplorerWindow.querySelector('.folder-explorer-wrapper');
            
            folderExplorerWrapper.appendChild(ulContent);
            this.shadowRoot.appendChild(folderExplorerWindow);
        });

        const styleSheet = new CSSStyleSheet();
        styleSheet.replaceSync(`
            .folder-explorer-window {
                width: 200px;
                height: 100%;
            }
            .title{
                button.expand {
                    margin-right: 5px;
                    cursor: pointer;
                    background: none;
                    border: none;
                    padding: 0;
                    font: inherit;
                    display: inline-block;
                    transition: transform 0.2s ease;
                    &[data-expanded="true"] {
                        transform: rotate(90deg);
                    }
                }
            }
            
            .directory-contents {
                list-style-type: none;
                padding-left: 20px;
            }
        `);
        this.shadowRoot.adoptedStyleSheets = [styleSheet];
    }
}

customElements.define('folder-explorer', FolderExplorer);