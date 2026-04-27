# Career-Ops Client App

The career-ops bridge + dashboard runs as a single local process. To make
it start automatically at login (so you never need to open a terminal),
install the macOS LaunchAgent:

## One-time install

```bash
npm run app:install
```

This creates `~/Library/LaunchAgents/io.hongxi.career-ops.plist` and loads
it via `launchctl`. The server starts immediately and re-launches at login.

## Day-to-day commands

```bash
npm run app:status       # Is it running? Show PID
npm run app:logs         # Tail stdout + stderr
npm run app:logs:err     # Tail stderr only
npm run app:restart      # Restart the running server
npm run app:uninstall    # Remove the LaunchAgent (stops it now + at next login)
```

## Where things live

- LaunchAgent plist: `~/Library/LaunchAgents/io.hongxi.career-ops.plist`
- Logs: `~/Library/Logs/CareerOps/server.out.log` (stdout), `server.err.log` (stderr)
- Auth token: `apps/server/.bridge-token` (random per-machine)
- Default port: `127.0.0.1:47319`
- Dashboard URL: `http://127.0.0.1:47319/dashboard/`

## Default backend

The LaunchAgent runs with `CAREER_OPS_BACKEND=real-codex` (Codex CLI).
Switch to OpenRouter or Claude CLI by editing the plist's
`EnvironmentVariables` block, then `npm run app:restart`.

## Crash recovery

The plist sets `KeepAlive: { Crashed: true, SuccessfulExit: false }`,
so the server is auto-restarted only after a crash, never after a clean
exit (so `npm run app:uninstall` actually stops it).

## Verifying the install

```bash
npm run app:status
# Status: RUNNING (pid 12345)

curl -s http://127.0.0.1:47319/dashboard/ | head -5
# (should print HTML)
```

If `app:status` says NOT INSTALLED, run `npm run app:install`. If it
says LOADED but not running, check logs with `npm run app:logs:err`.
