const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const QUALITY_FORMATS = {
  best: {
    label: 'Best',
    ext: 'mp4',
    format:
      'bv*[vcodec^=avc1]+ba[acodec^=mp4a]/bv*[vcodec^=avc]+ba[acodec^=mp4a]/bv*[vcodec!^=av01][ext=mp4]+ba[ext=m4a]/bv*+ba/b',
    audioOnly: false,
  },
  '1080p': {
    label: '1080p',
    ext: 'mp4',
    format:
      'bv*[height<=1080][vcodec^=avc1]+ba[acodec^=mp4a]/bv*[height<=1080][vcodec^=avc]+ba/bv*[height<=1080]+ba/b[height<=1080]/b',
    audioOnly: false,
  },
  '720p': {
    label: '720p',
    ext: 'mp4',
    format:
      'bv*[height<=720][vcodec^=avc1]+ba[acodec^=mp4a]/bv*[height<=720][vcodec^=avc]+ba/bv*[height<=720]+ba/b[height<=720]/b',
    audioOnly: false,
  },
  '480p': {
    label: '480p',
    ext: 'mp4',
    format:
      'bv*[height<=480][vcodec^=avc1]+ba[acodec^=mp4a]/bv*[height<=480][vcodec^=avc]+ba/bv*[height<=480]+ba/b[height<=480]/b',
    audioOnly: false,
  },
  mp3: {
    label: 'Audio only (MP3)',
    ext: 'mp3',
    format: 'ba/b',
    audioOnly: true,
  },
};

function validateUrl(raw) {
  if (typeof raw !== 'string') {
    throw new Error('Invalid link. Please enter a valid web URL.');
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('Please paste a video link first.');
  }
  if (/[\r\n\0]/.test(trimmed) || trimmed.length > 4096) {
    throw new Error('Invalid link. Please check the URL and try again.');
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('Invalid link. Include http:// or https:// and try again.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Invalid link. Only http:// and https:// URLs are supported.');
  }
  if (!parsed.hostname || !parsed.hostname.includes('.')) {
    throw new Error('Invalid link. Please enter a complete web address.');
  }
  return parsed.toString();
}

function sanitizeFilename(name, fallback = 'video') {
  const cleaned = String(name || '')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  const safe = cleaned || fallback;
  return safe.length > 160 ? safe.slice(0, 160).trim() : safe;
}

function resolveBinaries(binDir) {
  const exe = (name) => (process.platform === 'win32' ? `${name}.exe` : name);
  const ytdlpPath = path.join(binDir, exe('yt-dlp'));
  const ffmpegPath = path.join(binDir, exe('ffmpeg'));
  const ffprobePath = path.join(binDir, exe('ffprobe'));
  const aria2cPath = path.join(binDir, exe('aria2c'));

  return {
    binDir,
    ytdlp: fs.existsSync(ytdlpPath) ? ytdlpPath : null,
    ffmpeg: fs.existsSync(ffmpegPath) ? ffmpegPath : null,
    ffprobe: fs.existsSync(ffprobePath) ? ffprobePath : null,
    aria2c: fs.existsSync(aria2cPath) ? aria2cPath : null,
  };
}

function mapYtDlpError(rawText) {
  const text = String(rawText || '').toLowerCase();

  if (
    text.includes('private video') ||
    text.includes('this video is private') ||
    text.includes('video is private')
  ) {
    return 'This video is private and cannot be downloaded.';
  }
  if (
    text.includes('sign in') ||
    text.includes('login') ||
    text.includes('cookies') ||
    text.includes('authentication') ||
    text.includes('confirm your age') ||
    text.includes('members-only')
  ) {
    return 'Login or age verification is required to access this video.';
  }
  if (
    text.includes('geo') ||
    text.includes('not available in your country') ||
    text.includes('blocked it in your country') ||
    text.includes('region')
  ) {
    return 'This video is geo-blocked or unavailable in your region.';
  }
  if (
    text.includes('getaddrinfo') ||
    text.includes('name resolution') ||
    text.includes('timed out') ||
    text.includes('connection refused') ||
    text.includes('network is unreachable') ||
    text.includes('unable to download webpage') ||
    text.includes('failed to resolve')
  ) {
    return 'No internet connection or unable to reach the server.';
  }
  if (text.includes('unsupported url')) {
    return 'Unsupported site or link. Please check the URL.';
  }
  if (
    text.includes('is not a valid url') ||
    text.includes('video unavailable') ||
    text.includes('404') ||
    text.includes('not found')
  ) {
    return 'Invalid link or video is no longer available.';
  }
  return 'Could not process this video link. Please verify the URL and try again.';
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'Live / Unknown';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

async function autoUpdateYtDlp(binDir) {
  try {
    const { ytdlp } = resolveBinaries(binDir);
    if (!ytdlp) return;
    await execFileAsync(ytdlp, ['-U'], {
      windowsHide: true,
      timeout: 20000,
    });
  } catch {
    // Silent failure when offline or rate-limited
  }
}

function fetchMetadata(binDir, rawUrl) {
  return new Promise((resolve, reject) => {
    let validUrl;
    try {
      validUrl = validateUrl(rawUrl);
    } catch (err) {
      reject(err);
      return;
    }

    const { ytdlp } = resolveBinaries(binDir);
    if (!ytdlp) {
      reject(new Error('yt-dlp is still setting up. Please wait a moment and try again.'));
      return;
    }

    const args = ['-j', '--no-playlist', '--no-warnings', '--', validUrl];
    const proc = spawn(ytdlp, args, {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {}
      reject(new Error('Request timed out while fetching video info.'));
    }, 40000);

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    proc.on('error', () => {
      clearTimeout(timer);
      reject(new Error('Unable to start yt-dlp. Please run setup again.'));
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 || !stdout.trim()) {
        reject(new Error(mapYtDlpError(stderr)));
        return;
      }
      try {
        const firstJsonLine = stdout.trim().split(/\r?\n/)[0];
        const info = JSON.parse(firstJsonLine);
        resolve({
          url: info.webpage_url || validUrl,
          title: info.title || 'Untitled Video',
          safeTitle: sanitizeFilename(info.title, 'video'),
          thumbnail: info.thumbnail || null,
          duration: formatDuration(info.duration),
          durationSeconds: info.duration || 0,
          platform: info.extractor_key || info.extractor || 'Web',
          uploader: info.uploader || info.channel || null,
          resolution: info.resolution || (info.height ? `${info.height}p` : null),
        });
      } catch {
        reject(new Error('Could not read video metadata from this link.'));
      }
    });
  });
}

const SIZE_MULT = {
  B: 1,
  KB: 1000,
  KIB: 1024,
  MB: 1000 ** 2,
  MIB: 1024 ** 2,
  GB: 1000 ** 3,
  GIB: 1024 ** 3,
};

function parseHumanBytes(str) {
  const m = String(str || '').trim().match(/^([\d.]+)\s*([A-Za-z]+)?$/);
  if (!m) return 0;
  const num = Number.parseFloat(m[1]);
  if (!Number.isFinite(num)) return 0;
  const mult = SIZE_MULT[(m[2] || 'B').toUpperCase()] || 1;
  return Math.round(num * mult);
}

function parseAriaEta(str) {
  if (!str) return null;
  let sec = 0;
  let ok = false;
  const h = str.match(/(\d+)h/i);
  const m = str.match(/(\d+)m/i);
  const s = str.match(/(\d+)s/i);
  if (h) { sec += Number.parseInt(h[1], 10) * 3600; ok = true; }
  if (m) { sec += Number.parseInt(m[1], 10) * 60; ok = true; }
  if (s) { sec += Number.parseInt(s[1], 10); ok = true; }
  return ok ? sec : null;
}

function parseProgressLine(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('GRABIT_FILE|')) {
    const filePath = trimmed.slice('GRABIT_FILE|'.length).trim();
    return filePath ? { type: 'file', filePath } : null;
  }

  if (trimmed.startsWith('GRABIT_PROG|')) {
    const parts = trimmed.slice('GRABIT_PROG|'.length).split('|');
    const downloaded = Number.parseFloat(parts[0]);
    const totalExact = Number.parseFloat(parts[1]);
    const totalEst = Number.parseFloat(parts[2]);
    const speed = Number.parseFloat(parts[3]);
    const eta = Number.parseFloat(parts[4]);
    const total = Number.isFinite(totalExact)
      ? totalExact
      : Number.isFinite(totalEst)
        ? totalEst
        : 0;
    const dl = Number.isFinite(downloaded) ? downloaded : 0;
    const percent = total > 0 ? Math.min(100, Math.round((dl / total) * 1000) / 10) : 0;
    return {
      type: 'progress',
      percent,
      downloadedBytes: dl,
      totalBytes: total,
      speedBps: Number.isFinite(speed) ? speed : 0,
      etaSeconds: Number.isFinite(eta) ? Math.round(eta) : null,
    };
  }

  const aria = trimmed.match(
    /\[#[0-9a-f]+\s+([\d.]+(?:[KMG]i?B)?)\/([\d.]+(?:[KMG]i?B)?)\((\d+(?:\.\d+)?)%\)\s+CN:(\d+)\s+DL:([\d.]+(?:[KMG]i?B)?)(?:\s+ETA:([^\]]+))?\]/i
  );
  if (aria) {
    return {
      type: 'progress',
      downloadedBytes: parseHumanBytes(aria[1]),
      totalBytes: parseHumanBytes(aria[2]),
      percent: Number.parseFloat(aria[3]) || 0,
      speedBps: parseHumanBytes(aria[5]),
      etaSeconds: parseAriaEta(aria[6]),
    };
  }

  if (
    trimmed.startsWith('[Merger]') ||
    trimmed.startsWith('[ExtractAudio]') ||
    trimmed.startsWith('[Fixup')
  ) {
    const mergeDest = trimmed.match(/into\s+"(.+)"$/i);
    return { type: 'merging', filePath: mergeDest ? mergeDest[1] : null };
  }

  const dest = trimmed.match(/^\[(?:download|ExtractAudio)\]\s+Destination:\s+(.+)$/i);
  if (dest) {
    return { type: 'destination', filePath: dest[1].trim() };
  }

  return null;
}

function buildDownloadArgs({
  url,
  outputDir,
  title,
  quality,
  maxConnections,
  compatibleMp4 = true,
  binDir,
}) {
  const preset = QUALITY_FORMATS[quality] || QUALITY_FORMATS.best;
  const safeTitle = sanitizeFilename(title, 'video');
  const outTemplate = path.join(outputDir, `${safeTitle} [${quality}].%(ext)s`);
  const bins = resolveBinaries(binDir);
  const conn = Math.min(16, Math.max(1, Number(maxConnections) || 8));

  const args = [
    '--newline',
    '--continue',
    '--no-playlist',
    '--no-warnings',
    '--retries',
    '10',
    '--fragment-retries',
    '10',
    '-N',
    String(conn),
    '--progress-template',
    'download:GRABIT_PROG|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s',
    '--print',
    'after_move:GRABIT_FILE|%(filepath)s',
    '-f',
    preset.format,
    '-o',
    outTemplate,
  ];

  if (!preset.audioOnly && compatibleMp4) {
    // Strongly prefer Windows-native H.264 + AAC before falling back
    args.push('-S', 'vcodec:h264,acodec:m4a,res,fps');
  }

  if (preset.audioOnly) {
    args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
  } else {
    args.push('--merge-output-format', 'mp4');
  }

  if (bins.ffmpeg) {
    args.push('--ffmpeg-location', binDir);
  }

  if (bins.aria2c) {
    args.push(
      '--downloader',
      'aria2c',
      '--downloader-args',
      'aria2c:-x16 -s16 -k1M --summary-interval=1 --file-allocation=none --console-log-level=warn'
    );
  }

  args.push('--', url);
  return { args, bins, preset };
}

function spawnYtDlp(binDir, args) {
  const bins = resolveBinaries(binDir);
  if (!bins.ytdlp) {
    throw new Error('yt-dlp.exe is missing. Please run setup.');
  }
  const envPath = `${binDir}${path.delimiter}${process.env.PATH || ''}`;
  return spawn(bins.ytdlp, args, {
    windowsHide: true,
    shell: false,
    env: {
      ...process.env,
      PATH: envPath,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function probeMedia(binDir, filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const stat = await fsp.stat(filePath).catch(() => null);
  const base = {
    fileSize: stat ? stat.size : 0,
    vcodec: null,
    acodec: null,
    width: null,
    height: null,
    durationSeconds: null,
    windowsCompatible: true,
  };

  const { ffprobe } = resolveBinaries(binDir);
  if (!ffprobe) return base;

  try {
    const { stdout } = await execFileAsync(
      ffprobe,
      [
        '-v',
        'error',
        '-show_entries',
        'stream=codec_type,codec_name,width,height:format=duration',
        '-of',
        'json',
        filePath,
      ],
      { windowsHide: true, timeout: 12000 }
    );
    const parsed = JSON.parse(stdout || '{}');
    const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
    const video = streams.find((s) => s.codec_type === 'video');
    const audio = streams.find((s) => s.codec_type === 'audio');
    const vcodec = video ? String(video.codec_name || '').toLowerCase() : null;
    const acodec = audio ? String(audio.codec_name || '').toLowerCase() : null;
    const ext = path.extname(filePath).toLowerCase();

    let windowsCompatible = true;
    if (ext === '.mp4' || ext === '.mkv' || ext === '.webm') {
      const videoOk = !vcodec || vcodec === 'h264';
      const audioOk = !acodec || acodec === 'aac' || acodec === 'mp3';
      windowsCompatible = ext === '.mp4' && videoOk && audioOk;
    }

    return {
      ...base,
      vcodec,
      acodec,
      width: video?.width || null,
      height: video?.height || null,
      durationSeconds: parsed.format?.duration
        ? Number.parseFloat(parsed.format.duration)
        : null,
      windowsCompatible,
    };
  } catch {
    return base;
  }
}

/**
 * Ensures an MP4 file uses H.264 video + AAC audio so Windows Media Player / Movies & TV
 * can open it natively without asking for AV1/VP9/HEVC Microsoft Store extensions.
 */
async function convertToCompatibleMp4(binDir, filePath, onProgress, onSpawn) {
  const { ffmpeg } = resolveBinaries(binDir);
  if (!ffmpeg || !filePath || !fs.existsSync(filePath)) {
    return { converted: false, filePath };
  }

  const probe = await probeMedia(binDir, filePath);
  if (!probe || probe.windowsCompatible) {
    return { converted: false, filePath, probe };
  }

  const dir = path.dirname(filePath);
  const parsed = path.parse(filePath);
  const tempOut = path.join(dir, `${parsed.name}.grabit_h264_tmp.mp4`);
  const finalOut =
    parsed.ext.toLowerCase() === '.mp4'
      ? filePath
      : path.join(dir, `${parsed.name}.mp4`);

  const videoAlreadyH264 = !probe.vcodec || probe.vcodec === 'h264';
  const durationSec = probe.durationSeconds || 0;

  const args = ['-y', '-i', filePath];
  if (videoAlreadyH264) {
    args.push('-c:v', 'copy');
  } else {
    args.push(
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '20',
      '-pix_fmt',
      'yuv420p'
    );
  }

  if (!probe.acodec || probe.acodec === 'aac' || probe.acodec === 'mp3') {
    args.push('-c:a', 'copy');
  } else {
    args.push('-c:a', 'aac', '-b:a', '192k');
  }

  args.push('-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', tempOut);

  await new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, args, {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (onSpawn) onSpawn(proc);

    let buf = '';
    proc.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() || '';
      for (const line of lines) {
        const m = line.match(/^out_time_ms=(\d+)/);
        if (m && durationSec > 0 && onProgress) {
          const outSec = Number.parseInt(m[1], 10) / 1_000_000;
          const pct = Math.min(99, Math.max(0, Math.round((outSec / durationSec) * 100)));
          onProgress(pct);
        }
      }
    });

    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(tempOut)) {
        resolve();
      } else {
        reject(new Error(`FFmpeg conversion exited with code ${code}`));
      }
    });
  });

  if (finalOut === filePath) {
    await fsp.rm(filePath, { force: true });
  }
  await fsp.rename(tempOut, finalOut);
  const newProbe = await probeMedia(binDir, finalOut);
  return { converted: true, filePath: finalOut, probe: newProbe };
}

async function killProcessTree(proc) {
  if (!proc || !proc.pid || proc.killed) return;
  if (process.platform === 'win32') {
    try {
      await execFileAsync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {
        windowsHide: true,
      });
      return;
    } catch {
      // Fallback
    }
  }
  try {
    proc.kill('SIGTERM');
  } catch {}
}

module.exports = {
  QUALITY_FORMATS,
  validateUrl,
  sanitizeFilename,
  resolveBinaries,
  mapYtDlpError,
  autoUpdateYtDlp,
  fetchMetadata,
  parseProgressLine,
  buildDownloadArgs,
  spawnYtDlp,
  probeMedia,
  convertToCompatibleMp4,
  killProcessTree,
};
