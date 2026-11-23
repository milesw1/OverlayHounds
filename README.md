# 1080p Hockey Broadcast Scorebug & Live Producer Studio (v8)

## What's New in v8
1. **Firebase Realtime Database Sync over Standard HTTPS Port 443**: Replaces the port-8084 public MQTT broker with your own private Firebase Realtime Database over pure HTTPS (`fetch` + `EventSource` SSE). Never blocked by arena Wi-Fi firewalls, zero external JS SDKs, and full state retention if Moblin reloads mid-game.
2. **GitHub `/assets/` Folder & `config.json` Flat-File Defaults**:
   - Commit logos (`./assets/home.png`, `./assets/sponsor1.png`) and hype videos (`./assets/hype.webm`) directly into `/assets/`.
   - Click **Export config.json** in **Setup & Layout** and commit it to the root of your GitHub repository so your PC, iPad, and Moblin iPhone all load your exact defaults and Firebase URL automatically on open.
