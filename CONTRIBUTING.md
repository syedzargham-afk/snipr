# Contributing to Snipr Download Manager (SDM)

Thank you for your interest in contributing to **Snipr Download Manager** (`github.com/syedzargham-afk/snipr`)!

## Development Setup

1. Fork [syedzargham-afk/snipr](https://github.com/syedzargham-afk/snipr) and clone your fork:
   ```bash
   git clone https://github.com/YOUR_USERNAME/snipr.git
   cd snipr
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Download local dev binaries (`yt-dlp.exe`, `ffmpeg.exe`, `aria2c.exe`) into `/bin` (note: `/bin` is gitignored — never commit binaries):
   ```bash
   npm run setup
   ```
4. Launch Vite + Electron in development mode:
   ```bash
   npm run dev
   ```

## Contribution Guidelines

- Keep the codebase clean, modular, and dependency-light.
- Never commit executables, binaries (`/bin`, `/release`), tokens, or user data files.
- Maintain Electron & Bridge security boundaries:
  - `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
  - Bind the local HTTP bridge strictly to `127.0.0.1`, validate `Host`, enforce `X-Snipr-Token` with `crypto.timingSafeEqual`, and allow only exact `chrome-extension://<id>` origins.
  - Always spawn child processes with argument arrays (never `shell: true`).
- Test metadata fetching, downloading, pause/resume, H.264 compatibility, built-in streaming, and `npm run build:renderer` before opening a Pull Request.

## Reporting Issues

When opening an issue, please include:
- Your Windows version and Snipr version
- Steps to reproduce the issue
- Any error message shown in the UI (avoid sharing personal tokens, private URLs, or local file paths)
