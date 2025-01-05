import { getContentsOfDirectory } from "./dataOperations.mjs";
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
                        `<li class="${type}" data-path="${path}">
                            <div>
                                ${type === 'directory' ? '<button class="expand" data-expanded="false" />' : ''}
                                <span class='name'>${path.split('/').at(-1)}</span>
                            </div>
                        </li>`)
                    .join(''))}
            </ul>`;

            const domElement = new DOMParser().parseFromString(domString, 'text/html').body.firstChild;
            domElement.querySelectorAll('button[data-expanded]').forEach(button => {
                button.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const li = button.closest('.directory');
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
                    this.onChange?.(span.textContent);
                });
            });
            return domElement;
        };

        renderDirectoryContents(this.dataset.path).then((ulContent) => {
            this.shadowRoot.appendChild(ulContent);
        });

        const styleSheet = new CSSStyleSheet();
        styleSheet.replaceSync(`
            ul.directory-contents {
                list-style-type: none;
                padding-left: 20px;
            }
            button.expand {
                margin-right: 5px;
                cursor: pointer;
                background: none;
                border: none;
                padding: 0;
                font: inherit;
                &::before {
                    content: '▶';
                    display: inline-block;
                    transition: transform 0.2s ease;
                }
                &[data-expanded="true"]::before {
                    transform: rotate(90deg);
                }
            }
        `);
        this.shadowRoot.adoptedStyleSheets = [styleSheet];
    }
}

customElements.define('folder-explorer', FolderExplorer);