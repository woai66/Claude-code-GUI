/// <reference types="vite/client" />

/**
 * Installed package version, injected by Vite's `define` at build time.
 * Read it through `APP_VERSION` in `@/shared/constants`, which also covers
 * runners such as `tsx` that do not apply Vite's define replacement.
 */
declare const __APP_VERSION__: string;

/** The isolated Electron preload exposes only local session bootstrap to the page. */
declare var cloudcliDesktopSession: {
  getSession(): Promise<{ token: string; user: { id: number; username: string } }>;
} | undefined;

/** 原生目录功能独立于登录桥接，网页版仍可手动输入服务器上的目录。 */
declare var claudeGuiDirectories: import('@/shared/types').DesktopDirectoryBridge | undefined;

/** Windows 桌面通过受限桥接在独立 PowerShell 中恢复 Claude 会话。 */
declare var claudeGuiClaude: import('@/shared/types').DesktopClaudeBridge | undefined;
