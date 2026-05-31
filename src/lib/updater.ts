/**
 * One-click in-app updater (signed) with a browser fallback.
 *
 * In the Tauri app this drives `tauri-plugin-updater`: it checks the signed
 * `latest.json` manifest, and `install()` downloads the new installer, verifies
 * its minisign signature against the embedded public key, installs it, and
 * relaunches via `tauri-plugin-process`. In the browser preview (no Tauri), it
 * falls back to the lightweight GitHub-API check that just links to the release.
 */
import { APP_VERSION } from './appInfo';
import { isTauri } from './ipc';
import { checkForUpdate as ghCheck } from './updates';

export interface PreparedUpdate {
  available: boolean;
  current: string;
  version?: string;
  error?: string;
  /** In-app install + relaunch (Tauri only). `onProgress` is a 0–100 % or null. */
  install?: (onProgress?: (pct: number | null) => void) => Promise<void>;
  /** Browser fallback: a URL to open for a manual download. */
  url?: string;
}

export async function prepareUpdate(): Promise<PreparedUpdate> {
  if (isTauri()) {
    try {
      const { check } = await import('@tauri-apps/plugin-updater');
      const update = await check();
      if (!update) return { available: false, current: APP_VERSION };
      return {
        available: true,
        current: APP_VERSION,
        version: update.version,
        install: async (onProgress) => {
          let total = 0;
          let downloaded = 0;
          await update.downloadAndInstall((event) => {
            switch (event.event) {
              case 'Started':
                total = event.data.contentLength ?? 0;
                onProgress?.(total ? 0 : null);
                break;
              case 'Progress':
                downloaded += event.data.chunkLength;
                onProgress?.(total ? Math.min(100, Math.round((downloaded / total) * 100)) : null);
                break;
              case 'Finished':
                onProgress?.(100);
                break;
            }
          });
          // Installer applied — relaunch into the new version.
          const { relaunch } = await import('@tauri-apps/plugin-process');
          await relaunch();
        },
      };
    } catch (e) {
      return { available: false, current: APP_VERSION, error: e instanceof Error ? e.message : String(e) };
    }
  }

  // Browser preview: notify + link only.
  const gh = await ghCheck();
  return {
    available: gh.status === 'available',
    current: gh.current,
    version: gh.latest,
    url: gh.url,
    error: gh.status === 'error' ? gh.error : undefined,
  };
}
