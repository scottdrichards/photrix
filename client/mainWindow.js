import { generateDatabase } from './dataOperations.mjs';
import './folderExplorer.js';
import './previewWindow.js';

generateDatabase().then(db=>{
    db.search('sarah').then(console.log)
});

class MainWindow extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
    }

    connectedCallback() {
        const domString = `
        <div class="main-window">
            <folder-explorer data-path="/media/"></folder-explorer>
            <preview-window></preview-window>
        </div>
        `;

        const domElement = new DOMParser().parseFromString(domString, 'text/html').body.firstChild;
        this.shadowRoot.appendChild(domElement);

        const previewWindow = this.shadowRoot.querySelector('preview-window');
        this.addEventListener('selectedElement', (event) => {
            const { path, type } = event.detail;
            console.log(`Selected element path: ${path}, type: ${type}`);
            previewWindow.setAttribute('data-path', path);
            previewWindow.setAttribute('data-media-type', type);
        });

        const styleSheet = new CSSStyleSheet();
        styleSheet.replaceSync(`
            .main-window {
                display: flex;
                flex-direction: row;
                height: 100%;
            }
            preview-window {
                flex: 1;
            }
        `);
        this.shadowRoot.adoptedStyleSheets = [styleSheet];
        
    }
}

customElements.define('main-window', MainWindow);