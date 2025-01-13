import { dataPort, getOriginAndPort } from "./dataOperations.mjs";

const origin = getOriginAndPort().originNoPort+":" + dataPort;
class PreviewWindow extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
    }

    static get observedAttributes() {
        return ['data-path'];
    }

    attributeChangedCallback(name, oldValue, newValue) {
        console.log(name, oldValue, newValue);
        if (name === 'data-path') {
            this.render();
        }
    }

    render() {
        const path = this.getAttribute('data-path');
        const mediaType = path.includes('.jpg') || path.includes('.png') ? 'image' : path.includes('.mp4') ? 'video' : 'unknown';
        
        this.shadowRoot.innerHTML = `
            <style>
                img {
                    max-width: 100%;
                    height: auto;
                }
            </style>
            ${mediaType === 'image'? `<img src="${origin}${path}" alt="Image Preview">`:
            `<video controls>
                <source src="${origin}${path}" type="video/mp4">
                Your browser does not support the video tag.
            </video>`}
        `;
    }
}

customElements.define('preview-window', PreviewWindow);