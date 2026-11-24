/**
 * Runs in every page, sandboxed. It exposes exactly one call, used by the local offline page; the main process ignores
 * it from any other page (it checks the sender is the bundled offline page).
 */
import { contextBridge, ipcRenderer } from 'electron';

// console pages get nothing from the shell; only the bundled offline page (a file: URL) sees the bridge
if (globalThis.location?.protocol === 'file:') {
  contextBridge.exposeInMainWorld('nuzmDesktop', {
    retry: (url: string) => ipcRenderer.send('nuzm:retry', String(url)),
  });
}
