const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const dns = require('node:dns');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');

dns.setDefaultResultOrder('ipv4first');

const execFileAsync = promisify(execFile);

const REQUIRED_BINARIES = ['yt-dlp.exe', 'ffmpeg.exe', 'aria2c.exe'];

function getMissingBinaries(binDir) {
  return REQUIRED_BINARIES.filter((name) => {
    const full = path.join(binDir, name);
    return !fs.existsSync(full);
  });
}

async function fetchWithRetry(url, options = {}, attempts = 4) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'User-Agent': 'Snipr-Setup/1.0',
          ...(options.headers || {}),
        },
        ...options,
      });
      clearTimeout(timer);
      if (!res.ok && res.status !== 206) {
        throw new Error(`HTTP ${res.status} for ${url}`);
      }
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
      }
    }
  }
  throw lastError;
}

async function downloadSegment(url, start, end, fileHandle, onBytes) {
  let offset = start;
  for (let attempt = 0; attempt < 8; attempt++) {
    if (offset > end) return;
    const controller = new AbortController();
    let stallTimer = setTimeout(() => controller.abort(), 45000);
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'User-Agent': 'Snipr-Setup/1.0',
          Range: `bytes=${offset}-${end}`,
        },
      });
      clearTimeout(stallTimer);
      if (res.status !== 206 && res.status !== 200) {
        throw new Error(`HTTP ${res.status} for segment ${offset}-${end}`);
      }
      if (!res.body) throw new Error('Empty segment body');
      const reader = res.body.getReader();
      try {
        while (true) {
          stallTimer = setTimeout(() => controller.abort(), 45000);
          const { done, value } = await reader.read();
          clearTimeout(stallTimer);
          if (done) break;
          if (value && value.byteLength > 0) {
            const buf = Buffer.from(value);
            await fileHandle.write(buf, 0, buf.byteLength, offset);
            offset += buf.byteLength;
            onBytes(buf.byteLength);
          }
        }
      } finally {
        clearTimeout(stallTimer);
      }
      if (offset > end) return;
      if (attempt === 7) throw new Error('Incomplete segment');
    } catch (err) {
      clearTimeout(stallTimer);
      if (attempt === 7) throw err;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

async function downloadFileParallel(url, destPath, onProgress, concurrency = 4) {
  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  const tmpPath = `${destPath}.part`;

  // Resolve redirects + size via HEAD (or fallback GET Range 0-0)
  let finalUrl = url;
  let total = 0;
  let supportsRanges = false;

  try {
    const headRes = await fetchWithRetry(url, { method: 'HEAD' }, 3);
    finalUrl = headRes.url || url;
    total = Number.parseInt(headRes.headers.get('content-length') || '0', 10);
    supportsRanges =
      (headRes.headers.get('accept-ranges') || '').toLowerCase().includes('bytes') &&
      total > 512 * 1024;
  } catch {
    supportsRanges = false;
  }

  if (supportsRanges && total > 0) {
    const fh = await fsp.open(tmpPath, 'w+');
    try {
      await fh.truncate(total);
      let received = 0;
      let lastPct = -1;
      const chunkSize = Math.ceil(total / concurrency);
      const tasks = [];

      for (let i = 0; i < concurrency; i++) {
        const start = i * chunkSize;
        if (start >= total) break;
        const end = Math.min(total - 1, (i + 1) * chunkSize - 1);
        tasks.push(
          downloadSegment(finalUrl, start, end, fh, (bytes) => {
            received += bytes;
            const pct = Math.min(100, Math.round((received / total) * 100));
            if (pct !== lastPct) {
              lastPct = pct;
              onProgress?.(pct, received, total);
            }
          })
        );
      }
      await Promise.all(tasks);
    } finally {
      await fh.close();
    }
    await fsp.rename(tmpPath, destPath);
    return;
  }

  // Fallback single-stream with Range resume
  let existingBytes = 0;
  try {
    const st = await fsp.stat(tmpPath);
    existingBytes = st.size;
  } catch {
    existingBytes = 0;
  }

  for (let attempt = 0; attempt < 6; attempt++) {
    const headers = existingBytes > 0 ? { Range: `bytes=${existingBytes}-` } : {};
    const controller = new AbortController();
    let stallTimer = setTimeout(() => controller.abort(), 25000);
    try {
      const res = await fetch(finalUrl, {
        redirect: 'follow',
        signal: controller.signal,
        headers: { 'User-Agent': 'Snipr-Setup/1.0', ...headers },
      });
      clearTimeout(stallTimer);
      if (res.status === 416) {
        await fsp.rename(tmpPath, destPath);
        return;
      }
      if (!res.ok && res.status !== 206) {
        throw new Error(`HTTP ${res.status} for ${finalUrl}`);
      }
      const isResuming = res.status === 206 && existingBytes > 0;
      if (!isResuming) existingBytes = 0;
      const contentLen = Number.parseInt(res.headers.get('content-length') || '0', 10);
      const fullTotal = isResuming ? existingBytes + contentLen : contentLen;
      let received = existingBytes;
      const fileStream = fs.createWriteStream(tmpPath, {
        flags: isResuming ? 'a' : 'w',
      });
      const reader = res.body.getReader();
      try {
        while (true) {
          stallTimer = setTimeout(() => controller.abort(), 20000);
          const { done, value } = await reader.read();
          clearTimeout(stallTimer);
          if (done) break;
          if (value && value.byteLength > 0) {
            await new Promise((resolve, reject) => {
              fileStream.write(Buffer.from(value), (err) =>
                err ? reject(err) : resolve()
              );
            });
            received += value.byteLength;
            existingBytes = received;
            if (onProgress && fullTotal > 0) {
              onProgress(
                Math.min(100, Math.round((received / fullTotal) * 100)),
                received,
                fullTotal
              );
            }
          }
        }
      } finally {
        clearTimeout(stallTimer);
        await new Promise((resolve) => fileStream.end(resolve));
      }
      await fsp.rename(tmpPath, destPath);
      return;
    } catch (err) {
      clearTimeout(stallTimer);
      if (attempt === 5) throw err;
      await new Promise((r) => setTimeout(r, 1200));
    }
  }
}

function downloadWithAria2(aria2cPath, url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const dir = path.dirname(destPath);
    const out = path.basename(destPath);
    const args = [
      '-x16',
      '-s16',
      '-k1M',
      '--continue=true',
      '--allow-overwrite=true',
      '--file-allocation=none',
      '--summary-interval=1',
      '--connect-timeout=30',
      '--timeout=45',
      '--max-tries=10',
      '--retry-wait=2',
      '-d',
      dir,
      '-o',
      out,
      url,
    ];
    const proc = spawn(aria2cPath, args, {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      const lines = buf.split(/\r?\n|\r/);
      buf = lines.pop() || '';
      for (const line of lines) {
        const m = line.match(/\((\d+)%\)/);
        if (m && onProgress) {
          onProgress(Number.parseInt(m[1], 10));
        }
      }
    };

    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(destPath)) {
        resolve();
      } else {
        reject(new Error(`aria2c exited with code ${code}`));
      }
    });
  });
}

async function downloadFast(aria2cPath, url, destPath, onProgress) {
  if (aria2cPath && fs.existsSync(aria2cPath)) {
    try {
      await downloadWithAria2(aria2cPath, url, destPath, onProgress);
      return;
    } catch {
      // Fallback to Node parallel downloader
    }
  }
  await downloadFileParallel(url, destPath, onProgress, 8);
}

async function expandZip(zipPath, destDir) {
  await fsp.mkdir(destDir, { recursive: true });
  const safeZip = zipPath.replace(/'/g, "''");
  const safeDest = destDir.replace(/'/g, "''");
  await execFileAsync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Expand-Archive -LiteralPath '${safeZip}' -DestinationPath '${safeDest}' -Force`,
    ],
    { windowsHide: true, timeout: 180000 }
  );
}

async function findFileRecursive(dir, filename) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === filename.toLowerCase()) {
      return full;
    }
    if (entry.isDirectory()) {
      const found = await findFileRecursive(full, filename);
      if (found) return found;
    }
  }
  return null;
}

async function resolveAria2Url() {
  try {
    const res = await fetchWithRetry('https://api.github.com/repos/aria2/aria2/releases/latest');
    const json = await res.json();
    const asset = (json.assets || []).find(
      (a) => a.name.includes('win-64bit') && a.name.endsWith('.zip')
    );
    if (asset && asset.browser_download_url) {
      return asset.browser_download_url;
    }
  } catch {
    // Fallback below
  }
  return 'https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0-win-64bit-build1.zip';
}

async function installAria2(binDir, emit) {
  const dest = path.join(binDir, 'aria2c.exe');
  if (fs.existsSync(dest)) return dest;

  emit({ tool: 'aria2c', stage: 'downloading', percent: 0, message: 'Fetching aria2c release...' });
  const url = await resolveAria2Url();
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'snipr-aria2-'));
  try {
    const zipPath = path.join(tempDir, 'aria2.zip');
    await downloadFileParallel(
      url,
      zipPath,
      (percent) =>
        emit({
          tool: 'aria2c',
          stage: 'downloading',
          percent: Math.round(percent * 0.8),
          message: `Downloading aria2c (${percent}%)`,
        }),
      4
    );
    emit({ tool: 'aria2c', stage: 'extracting', percent: 85, message: 'Extracting aria2c.exe...' });
    const extractDir = path.join(tempDir, 'out');
    await expandZip(zipPath, extractDir);
    const exePath = await findFileRecursive(extractDir, 'aria2c.exe');
    if (!exePath) {
      throw new Error('aria2c.exe was not found in downloaded archive.');
    }
    await fsp.copyFile(exePath, dest);
    emit({ tool: 'aria2c', stage: 'done', percent: 100, message: 'aria2c.exe ready' });
    return dest;
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
}

async function installYtDlp(binDir, aria2cPath, emit) {
  const dest = path.join(binDir, 'yt-dlp.exe');
  if (fs.existsSync(dest)) return;

  emit({ tool: 'yt-dlp', stage: 'downloading', percent: 0, message: 'Downloading yt-dlp.exe...' });
  await downloadFast(
    aria2cPath,
    'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe',
    dest,
    (percent) =>
      emit({
        tool: 'yt-dlp',
        stage: 'downloading',
        percent,
        message: `Downloading yt-dlp.exe (${percent}%)`,
      })
  );
  emit({ tool: 'yt-dlp', stage: 'done', percent: 100, message: 'yt-dlp.exe ready' });
}

async function installFfmpeg(binDir, aria2cPath, emit) {
  const dest = path.join(binDir, 'ffmpeg.exe');
  if (fs.existsSync(dest)) return;

  emit({ tool: 'ffmpeg', stage: 'downloading', percent: 0, message: 'Downloading FFmpeg essentials...' });
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'snipr-ffmpeg-'));
  try {
    const zipPath = path.join(tempDir, 'ffmpeg.zip');
    try {
      await downloadFast(
        aria2cPath,
        'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip',
        zipPath,
        (percent) =>
          emit({
            tool: 'ffmpeg',
            stage: 'downloading',
            percent: Math.round(percent * 0.8),
            message: `Downloading FFmpeg (${percent}%)`,
          })
      );
    } catch {
      await downloadFast(
        aria2cPath,
        'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
        zipPath,
        (percent) =>
          emit({
            tool: 'ffmpeg',
            stage: 'downloading',
            percent: Math.round(percent * 0.8),
            message: `Downloading FFmpeg (${percent}%)`,
          })
      );
    }

    emit({ tool: 'ffmpeg', stage: 'extracting', percent: 85, message: 'Extracting ffmpeg.exe...' });
    const extractDir = path.join(tempDir, 'out');
    await expandZip(zipPath, extractDir);
    const ffmpegExe = await findFileRecursive(extractDir, 'ffmpeg.exe');
    if (!ffmpegExe) {
      throw new Error('ffmpeg.exe was not found in downloaded archive.');
    }
    await fsp.copyFile(ffmpegExe, dest);

    const ffprobeExe = await findFileRecursive(extractDir, 'ffprobe.exe');
    if (ffprobeExe) {
      await fsp.copyFile(ffprobeExe, path.join(binDir, 'ffprobe.exe'));
    }
    emit({ tool: 'ffmpeg', stage: 'done', percent: 100, message: 'ffmpeg.exe ready' });
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
}

async function setupBinaries(binDir, onProgress) {
  const emit = onProgress || (() => {});
  await fsp.mkdir(binDir, { recursive: true });

  const missing = getMissingBinaries(binDir);
  if (missing.length === 0) {
    emit({ tool: 'all', stage: 'done', percent: 100, message: 'All binaries already installed.' });
    return { binDir, installed: [] };
  }

  // Install aria2c first so we can accelerate yt-dlp & ffmpeg downloads
  const aria2cPath = await installAria2(binDir, emit);
  await installYtDlp(binDir, aria2cPath, emit);
  await installFfmpeg(binDir, aria2cPath, emit);

  return { binDir, installed: missing };
}

if (require.main === module) {
  const projectBinDir = path.resolve(__dirname, '..', 'bin');
  console.log(`Setting up Snipr Download Manager binaries in: ${projectBinDir}`);
  let lastMsg = '';
  setupBinaries(projectBinDir, (ev) => {
    if (ev.message && ev.message !== lastMsg) {
      lastMsg = ev.message;
      console.log(`[${ev.tool}] ${ev.message}`);
    }
  })
    .then((res) => {
      if (res.installed.length === 0) {
        console.log('All required binaries are already present.');
      } else {
        console.log(`Setup complete! Installed: ${res.installed.join(', ')}`);
      }
    })
    .catch((err) => {
      console.error('Failed to setup binaries:', err.message || err);
      process.exitCode = 1;
    });
}

module.exports = {
  REQUIRED_BINARIES,
  getMissingBinaries,
  setupBinaries,
};
