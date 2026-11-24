# 1080p Hockey Broadcast Scorebug & Live Producer Studio (v9)

## What's New in v9
1. **Built-In Live Sync & Flat-File JSON Store (`/data/`)**: Zero external database setup required — room state, team presets, and `/assets/` uploads persist locally in `/data/` and stream live to Moblin (`?overlay=true`) and Rinkside Scorekeepers (`?mode=keeper`) over HTTPS Port 443 SSE + REST.
2. **Popup `/assets/` Media Library & Browser**: Visual thumbnail browser listing all files in `/assets/` so you can reuse logos, sponsor badges, and custom graphics across Home, Away, Sponsors, Custom Pads, and Saved Teams without re-uploading.
3. **Saved Teams & Opponent Presets Library**: Save league and tournament opponents once (name, color, `/assets/` logo) and swap Home or Away in 1 click before puck drop.
4. **Rinkside Phone Scorekeeper Mode (`?mode=keeper`)**: Thumb-friendly mobile controller URL with large Goal, SOG, Clock, Period, and PP/EN controls for a second operator in the stands.
5. **Undo Stack & One-Click Match Export**: Instant undo (`Ctrl+Z`) for accidental taps plus period-by-period scoring log and 1-click Match Summary export (`.txt` / `.json` / clipboard).

## Hosting Modes
- **Node.js Live Server (`npm install && npm start`)**: Full cross-device real-time sync between Producer Studio, Moblin (`?overlay=true`), and Rinkside Phone Scorekeeper (`?mode=keeper`), plus server-side `/assets/` uploads and flat-file `/data/` persistence.
  - **Single Persistent Volume (`/storage`)**: On Railway, attach one Volume mounted at `/storage` (Railway sets `RAILWAY_VOLUME_MOUNT_PATH` automatically), or set `STORAGE_DIR=/storage` on Render, Fly.io, Docker, or Raspberry Pi. Both `/data` (room snapshots & saved teams) and uploaded `/assets` live on the volume, while committed GitHub `/assets` remain available too.
  - **Optional Broadcast PIN (`ADMIN_PIN`)**: Set `ADMIN_PIN` in your host's environment variables to require a PIN in Studio and Phone Scorekeeper while keeping Moblin (`?overlay=true`) completely open and read-only.
- **GitHub Pages (Static Mode)**: Automatically detected when no Node backend is present. Works with zero errors for same-browser overlays, Undo + Match Export, `localStorage` Saved Teams, and `/assets/` browsing via `assets/manifest.json` + local browser uploads. Note: GitHub Pages only serves static files, so live cross-device Moblin / Phone Scorekeeper syncing requires running `server.js` on a Node host.
