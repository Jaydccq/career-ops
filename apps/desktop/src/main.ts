/**
 * main.ts — Electron main process for the Career Ops desktop app.
 *
 * Tasks 5.1 – 5.4 of the client-app-delivery plan:
 *   - Boot a single BrowserWindow pointed at the dashboard.
 *   - Embed the bridge server in-process via createServer() — no child
 *     subprocess.
 *   - Cleanly stop the server when the app quits.
 *   - Menu-bar tray icon (status, restart, open dashboard, view logs,
 *     settings, quit). The tray is the persistent UI.
 *   - Settings window for backend / OpenRouter key / start-at-login.
 *
 * Electron-builder packaging (5.5) is wired separately.
 */

import { app, BrowserWindow, shell } from "electron";
import { createServer, type ServerHandle, type AdapterMode } from "@career-ops/server";
import { createTray, type TrayController, type TrayState } from "./tray.js";
import { loadSettings, type Backend } from "./settings.js";
import { openSettingsWindow } from "./settings-window.js";

let server: ServerHandle | null = null;
let window: BrowserWindow | null = null;
let trayController: TrayController | null = null;
let trayState: TrayState = "idle";

const PORT = Number(process.env.CAREER_OPS_BRIDGE_PORT) || 47319;
const HOST = process.env.CAREER_OPS_BRIDGE_HOST || "127.0.0.1";

function resolveBackend(): AdapterMode {
  // env var wins; otherwise fall back to whatever's saved in settings.
  const raw = process.env.CAREER_OPS_BACKEND;
  if (
    raw === "fake" ||
    raw === "real-claude" ||
    raw === "real-codex" ||
    raw === "real-openrouter"
  ) {
    return raw;
  }
  return loadSettings().backend as Backend;
}

let currentBackend: AdapterMode = resolveBackend();

async function startServer(): Promise<void> {
  trayState = "idle";
  trayController?.rebuild();
  try {
    server = createServer({ backend: currentBackend });
    const info = await server.start({ port: PORT, host: HOST });
    console.log(
      `[career-ops] server listening on http://${info.host}:${info.port} (backend=${currentBackend})`,
    );
    trayState = "running";
  } catch (err) {
    trayState = "errored";
    throw err;
  } finally {
    trayController?.rebuild();
  }
}

async function restartServer(): Promise<void> {
  if (server) {
    try {
      await server.stop();
    } catch (err) {
      console.warn("[career-ops] error stopping server during restart:", err);
    }
    server = null;
  }
  trayState = "stopped";
  trayController?.rebuild();
  await startServer();
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1280,
    height: 860,
    title: "Career Ops",
    autoHideMenuBar: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  void window.loadURL(`http://${HOST}:${PORT}/dashboard/`);

  // Open external links in the system browser; keep loopback navigation
  // inside the app window.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost")) {
      return { action: "allow" };
    }
    void shell.openExternal(url);
    return { action: "deny" };
  });

  window.on("closed", () => {
    window = null;
  });
}

function openDashboardWindow(): void {
  if (!window || window.isDestroyed()) {
    createWindow();
    return;
  }
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function handleOpenSettings(): void {
  openSettingsWindow(async (next) => {
    if (next.backend !== currentBackend) {
      currentBackend = next.backend as AdapterMode;
      try {
        await restartServer();
      } catch (err) {
        console.error("[career-ops] failed to restart after settings change:", err);
      }
    }
    trayController?.rebuild();
  });
}

app.whenReady().then(async () => {
  trayController = createTray({
    getStatus: () => trayState,
    getBackend: () => currentBackend,
    onOpenDashboard: openDashboardWindow,
    onRestart: restartServer,
    onOpenSettings: handleOpenSettings,
  });

  try {
    await startServer();
    createWindow();
  } catch (err) {
    console.error("[career-ops] failed to start:", err);
    // Don't exit — the tray is still up so the user can retry via
    // "Restart Server".
  }
});

app.on("activate", () => {
  // macOS: re-create a window when the dock icon is clicked with no windows
  // open. Don't restart the server.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// Track whether we've already initiated shutdown so before-quit doesn't
// loop after we manually call app.exit().
let shuttingDown = false;

app.on("before-quit", (event) => {
  if (shuttingDown) return;
  if (server === null) return;

  event.preventDefault();
  shuttingDown = true;

  void (async () => {
    try {
      await server!.stop();
    } catch (err) {
      console.error("[career-ops] error stopping server:", err);
    } finally {
      server = null;
      app.exit(0);
    }
  })();
});

app.on("window-all-closed", () => {
  // Tray keeps the app alive on every platform now — quit only via the
  // tray's "Quit" item (which calls app.quit()). This matches standard
  // macOS menu-bar app behavior.
});
