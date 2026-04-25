# Career-Ops hourly scan

Started at: 2026-04-25T02:08:17Z
Command: `npm run auto:hourly-scan`
Dry run: false

## Result

The hourly scan did not reach source execution. The orchestrator attempted to
start the real/codex bridge, but local sandbox permissions blocked both bridge
startup paths:

- `tsx` bridge startup failed with `listen EPERM` on the tsx IPC pipe under
  `/var/folders/ly/sdg_pj9x6xb8b89q5yytyhdw0000gn/T/tsx-501/...`.
- Direct compiled bridge startup failed with `listen EPERM` on
  `127.0.0.1:47319`.

## Sources

No configured sources ran.

## Evaluations

Completed evaluations: 0

## Blockers and recovery

- bridge: local network/listen permission blocked the real/codex bridge before
  scan sources could run.

Recovery command:

```bash
npm run ext:bridge
```

Run the recovery command in a normal local terminal with permission to bind the
loopback bridge port, then rerun:

```bash
npm run auto:hourly-scan
```

## Newest high-fit roles worth reviewing

None from this run because source execution did not start.
