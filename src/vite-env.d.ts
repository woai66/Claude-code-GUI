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
