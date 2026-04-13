import "@testing-library/jest-dom/vitest";

// jsdom doesn't implement HTMLDialogElement.showModal / close
if (typeof HTMLDialogElement !== "undefined") {
  HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
    this.setAttribute("aria-modal", "true");
  };
  HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) {
    this.removeAttribute("open");
    this.removeAttribute("aria-modal");
  };
}
