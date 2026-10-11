import fs from 'node:fs/promises';
import path from 'node:path';

async function resolveDirectory(directoryPath) {
  if (typeof directoryPath !== 'string' || !path.isAbsolute(directoryPath)) {
    return { error: 'unavailable' };
  }

  try {
    if (!(await fs.stat(directoryPath)).isDirectory()) {
      return { error: 'not-directory' };
    }
    return { path: path.resolve(directoryPath) };
  } catch {
    return { error: 'unavailable' };
  }
}

/** 主窗口通过受限 IPC 选择或验证目录；不向页面开放任意文件系统访问。 */
export function registerDirectoryHandlers({ ipcMain, dialog, getWindow, assertLocalPage }) {
  ipcMain.handle('claude-gui:choose-directory', async (event, defaultPath) => {
    assertLocalPage(event);
    const result = await dialog.showOpenDialog(getWindow(), {
      properties: ['openDirectory'],
      ...(typeof defaultPath === 'string' && path.isAbsolute(defaultPath)
        ? { defaultPath }
        : {}),
    });
    if (result.canceled || !result.filePaths.length) {
      return null;
    }
    const directory = await resolveDirectory(result.filePaths[0]);
    if (!directory.path) {
      throw new Error('Selected directory is unavailable.');
    }
    return directory.path;
  });

  ipcMain.handle('claude-gui:resolve-directory', async (event, paths) => {
    assertLocalPage(event);
    if (!Array.isArray(paths) || paths.length !== 1) {
      return { error: 'single-folder' };
    }
    return resolveDirectory(paths[0]);
  });
}
