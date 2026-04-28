/**
 * tray.ts — Menu-bar tray icon for the Career Ops desktop app.
 *
 * Task 5.3 of the client-app-delivery plan: surface server status,
 * current backend, and a small action menu (open dashboard, restart,
 * view logs, settings, quit). The tray is the persistent UI — closing
 * the dashboard window does not quit the app.
 *
 * The placeholder icon at apps/desktop/icons/tray.png is a simple 16x16
 * black ring; per-state variants (idle/running/error) are deferred to a
 * polish pass and noted as a concern in the commit message.
 */

import { Tray, Menu, shell, app, nativeImage, type MenuItemConstructorOptions } from "electron";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// In dev (tsx) __dirname points at apps/desktop/src, in build at apps/desktop/dist.
// Both resolve "../icons" correctly.
const ICON_DIR = join(__dirname, "..", "icons");
const LOG_DIR = join(homedir(), "Library", "Logs", "CareerOps");

export type TrayState = "idle" | "running" | "stopped" | "errored";

export interface TrayHooks {
  getStatus: () => TrayState;
  getBackend: () => string;
  onOpenDashboard: () => void;
  onRestart: () => Promise<void>;
  onOpenSettings: () => void;
}

export interface TrayController {
  tray: Tray;
  rebuild: () => void;
}

function loadTrayIcon(): Electron.NativeImage {
  // Prefer a Template variant on macOS so the icon adapts to light/dark menu bar.
  const templatePath = join(ICON_DIR, "trayTemplate.png");
  const fallbackPath = join(ICON_DIR, "tray.png");
  const image = nativeImage.createFromPath(
    process.platform === "darwin" ? templatePath : fallbackPath,
  );
  if (image.isEmpty()) {
    // If the template wasn't found, retry with the plain icon.
    return nativeImage.createFromPath(fallbackPath);
  }
  if (process.platform === "darwin") {
    image.setTemplateImage(true);
  }
  return image;
}

export function createTray(hooks: TrayHooks): TrayController {
  const icon = loadTrayIcon();
  const tray = new Tray(icon);
  tray.setToolTip("Career Ops");

  function rebuild(): void {
    const status = hooks.getStatus();
    const backend = hooks.getBackend();
    const statusLabel = {
      idle: "Status: Idle",
      running: "Status: Running",
      stopped: "Status: Stopped",
      errored: "Status: Error",
    }[status];

    const template: MenuItemConstructorOptions[] = [
      { label: statusLabel, enabled: false },
      { label: `Backend: ${backend}`, enabled: false },
      { type: "separator" },
      { label: "Open Dashboard", click: () => hooks.onOpenDashboard() },
      {
        label: "Restart Server",
        click: async () => {
          try {
            await hooks.onRestart();
          } catch (err) {
            console.error("[tray] restart failed:", err);
          } finally {
            rebuild();
          }
        },
      },
      {
        label: "View Logs",
        click: () => {
          void shell.openPath(LOG_DIR);
        },
      },
      { type: "separator" },
      { label: "Settings…", click: () => hooks.onOpenSettings() },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ];

    tray.setContextMenu(Menu.buildFromTemplate(template));
  }

  rebuild();
  return { tray, rebuild };
}
