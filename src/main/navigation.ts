import { shell, type BrowserWindow } from 'electron';

function allowedAuthHost(hostname: string): boolean {
  return (
    hostname === 'chatgpt.com' ||
    hostname === 'chat.openai.com' ||
    hostname === 'openai.com' ||
    hostname.endsWith('.openai.com')
  );
}

export function restrictNavigation(window: BrowserWindow, mode: 'auth' | 'local'): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  window.webContents.on('will-navigate', (event, url) => {
    if (mode === 'local') {
      event.preventDefault();
      void shell.openExternal(url);
      return;
    }

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      event.preventDefault();
      return;
    }

    if (parsed.protocol !== 'https:' || !allowedAuthHost(parsed.hostname)) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });
}
