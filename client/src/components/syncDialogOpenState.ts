/**
 * Opens or closes a modal <dialog> to match `isOpen`. showModal() throws on a
 * dialog that is already open or no longer in the document, so both are checked
 * first rather than caught.
 */
export const syncDialogOpenState = (dialog: HTMLDialogElement, isOpen: boolean): void => {
  if (!dialog.isConnected) return;
  if (isOpen && !dialog.open) dialog.showModal();
  if (!isOpen && dialog.open) dialog.close();
};
