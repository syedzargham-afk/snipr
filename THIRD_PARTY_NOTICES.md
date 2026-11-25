# Third-Party Notices

**Snipr Download Manager (SDM)** does **not** bundle third-party downloader or media executables inside this Git repository, `app.asar`, or the Windows NSIS installer. Instead, on first launch (or via `npm run setup`), Snipr downloads the required binaries directly from their official upstream releases into the user's local `userData/bin` directory (`%APPDATA%\snipr-download-manager\bin`).

## External Tools Downloaded on First Run

### 1. yt-dlp
- **Upstream**: https://github.com/yt-dlp/yt-dlp
- **License**: The Unlicense (Public Domain)
- **Role**: Video metadata extraction and stream resolution.

### 2. FFmpeg (`ffmpeg.exe` & `ffprobe.exe`)
- **Upstream**: https://ffmpeg.org/ (Windows builds from https://github.com/BtbN/FFmpeg-Builds and https://www.gyan.dev/ffmpeg/builds/)
- **License**: GNU General Public License (GPL v3) / Lesser General Public License (LGPL v2.1+), depending on the upstream Windows build configuration.
- **Role**: Muxing separate audio/video streams, extracting MP3 audio, probing media codecs, and converting incompatible streams (e.g., AV1/VP9) to Windows-compatible H.264 + AAC MP4.

### 3. aria2 (`aria2c.exe`)
- **Upstream**: https://github.com/aria2/aria2
- **License**: GNU General Public License v2.0 (GPL-2.0) with OpenSSL exception.
- **Role**: Multi-connection segmented HTTP downloads (`-x16 -s16 -k1M`) with resumable `.aria2` partial state.

---

## Bundled npm Packages

Frontend & build dependencies (such as React, Vite, Electron, `@fontsource/inter`, and `lucide-react`) are licensed under their respective MIT / Apache-2.0 / SIL OFL licenses as listed in `package.json` and `package-lock.json`.
