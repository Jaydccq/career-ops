/**
 * main.ts — Electron main process for the Career Ops desktop app.
 *
 * Tasks 5.1 + 5.2 of the client-app-delivery plan:
 *   - Boot a single BrowserWindow pointed at the dashboard.
 *   - Embed the bridge server in-process via createServer() — no child
 *     subprocess.
 *   - Cleanly stop the server when the app quits.
 *
 * Tray menu (5.3), settings UI (5.4), and electron-builder packaging
 * (5.5) are intentionally out of scope here.
 */

import { app, BrowserWindow, shell } from "electron";
import { createServer, type ServerHandle, type AdapterMode } from "@career-ops/server";

let server: ServerHandle | null = null;
let window: BrowserWindow | null = null;

const PORT = Number(process.env.CAREER_OPS_BRIDGE_PORT) || 47319;
const HOST = process.env.CAREER_OPS_BRIDGE_HOST || "127.0.0.1";

function resolveBackend(): AdapterMode {
  const raw = process.env.CAREER_OPS_BACKEND;
  if (
    raw === "fake" ||
    raw === "real-claude" ||
    raw === "real-codex" ||
    raw === "real-openrouter"
  ) {
    return raw;
  }
  return "real-codex";
}

async function startServer(): Promise<void> {
  const backend = resolveBackend();
  server = createServer({ backend });
  const info = await server.start({ port: PORT, host: HOST });
  console.log(
    `[career-ops] server listening on http://${info.host}:${info.port} (backend=${backend})`
  );
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

app.whenReady().then(async () => {
  try {
    await startServer();
    createWindow();
  } catch (err) {
    console.error("[career-ops] failed to start:", err);
    app.exit(1);
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
  // Tray (5.3) will keep the app alive on macOS once it's added. Until
  // then, closing the only window quits the app like a typical Mac app.
  if (process.platform !== "darwin") {
    app.quit();
  } else {
    app.quit();
  }
});
