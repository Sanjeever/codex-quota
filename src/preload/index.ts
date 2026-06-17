import { contextBridge, ipcRenderer } from 'electron';
import type { DebugState } from '../shared/types';

const api = {
  getDebugState: (): Promise<DebugState> => ipcRenderer.invoke('debug:get-state'),
  refreshNow: (): Promise<DebugState> => ipcRenderer.invoke('debug:refresh-now'),
  copyJson: (): Promise<void> => ipcRenderer.invoke('debug:copy-json'),
  onStateChanged: (callback: (state: DebugState) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: DebugState) => callback(state);
    ipcRenderer.on('debug:state-changed', listener);
    return () => ipcRenderer.off('debug:state-changed', listener);
  }
};

contextBridge.exposeInMainWorld('codexQuota', api);

export type CodexQuotaApi = typeof api;
