# Security Policy

## Supported Versions

| Version | Supported |
| :--- | :--- |
| `1.0.x` | Yes |

## Security Architecture

Snipr Download Manager (SDM) is built with defense-in-depth for desktop and browser-extension communication:

- **Electron Sandbox**: Renderer runs with `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, strict navigation (`will-navigate` / `setWindowOpenHandler`), and packaged Content Security Policy.
- **Authenticated Loopback Bridge (`127.0.0.1:48921`)**:
  - Binds strictly to `127.0.0.1` and validates `Host` headers against DNS-rebinding (`127.0.0.1:48921` / `localhost:48921`).
  - Requires a per-install random 64-hex token (`X-Snipr-Token`) verified via `crypto.timingSafeEqual`.
  - Allows CORS exclusively for the pinned extension origin (`chrome-extension://kofcdoipnfdooikalliekaklfocgaaeg`).
  - Rejects private/loopback target URLs and rate-limits `/api/grab`.
- **Tokenized Media Streaming**: Built-in playback uses short-lived random `/stream/<id>?t=<token>` URLs instead of exposing raw filesystem paths, and resolves `fs.realpathSync` inside authorized download/history paths to block traversal and symlink escapes.
- **No Bundled Executables**: External tools (`yt-dlp`, `aria2c`, `ffmpeg`) are downloaded to `userData/bin` on first run and spawned via argument arrays without shell interpolation.

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Instead, report vulnerabilities privately via GitHub Security Advisories:
- https://github.com/syedzargham-afk/snipr/security/advisories/new

Include reproduction steps, affected component (`electron/`, `extension/`, or `src/`), and impact. We will acknowledge reports promptly and coordinate a fix before public disclosure.
