const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const dns = require('node:dns');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');

dns.setDefaultResultOrder('ipv4first');

const execFileAsync = promisify(execFile);

const BINARY_SPECS = {
  'yt-dlp.exe': { minBytes: 1_000_000, versionArgs: ['--version'] },
  'ffmpeg.exe': { minBytes: 5_000_000, versionArgs: ['-version'] },
  'ffprobe.exe': { minBytes: 5_000_000, versionArgs: ['-version'] },
  'aria2c.exe': { minBytes: 500_000, versionArgs: ['--version'] },
};

const REQUIRED_BINARIES = Object.keys(BINARY_SPECS);

function isBinaryStructurallyValid(filePath, name) {
  const spec = BINARY_SPECS[name];
  if (!spec || !filePath || !fs.existsSync(filePath)) return false;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < spec.minBytes) return false;
    const fd = fs.openSync(filePath, 'r');
    try {
      const header = Buffer.alloc(2);
      const bytesRead = fs.readSync(fd, header, 0, 2, 0);
      // Windows PE executables must start with 'MZ' (0x4D 0x5A)
      if (bytesRead < 2 || header[0] !== 0x4d || header[1] !== 0x5a) {
        return false;
      }
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}

async function verifyBinaryExecutable(filePath, name) {
  if (!isBinaryStructurallyValid(filePath, name)) return false;
  const spec = BINARY_SPECS[name];
  try {
    await execFileAsync(filePath, spec.versionArgs, {
      windowsHide: true,
      timeout: 8000,
    });
    return true;
  } catch {
    return false;
  }
}

function getMissingBinaries(binDir) {
  return REQUIRED_BINARIES.filter((name) => {
    const full = path.join(binDir, name);
    return !isBinaryStructurallyValid(full, name);
  });
}

async function getUnhealthyBinaries(binDir) {
  const missingOrCorrupt = [];
  for (const name of REQUIRED_BINARIES) {
    const full = path.join(binDir, name);
    const healthy = await verifyBinaryExecutable(full, name);
    if (!healthy) {
      missingOrCorrupt.push(name);
    }
  }
  return missingOrCorrupt;
}

function mapSetupError(err) {
  const raw = String(err?.cause?.code || err?.code || err?.message || '').toLowerCase();
  if (
    raw.includes('enotfound') ||
    raw.includes('eai_again') ||
    raw.includes('econnrefused') ||
    raw.includes('enetunreach') ||
    raw.includes('ehostunreach') ||
    raw.includes('etimedout') ||
    raw.includes('fetch failed') ||
    raw.includes('abort') ||
    raw.includes('network')
  ) {
    return 'No internet connection or unable to reach download servers. Connect to the internet and click Retry Setup.';
  }
  return err?.message || 'Setup failed. Check your internet connection and click Retry Setup.';
}

async function fetchWithRetry(url, options = {}, attempts = 2) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
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
        await new Promise((r) => setTimeout(r, 800 * (i + 1)));
      }
    }
  }
  throw lastError;
}

async function downloadSegment(url, start, end, fileHandle, onBytes) {
  let offset = start;
  for (let attempt = 0; attempt < 6; attempt++) {
    if (offset > end) return;
    const controller = new AbortController();
    let stallTimer = setTimeout(() => controller.abort(), 30000);
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
          stallTimer = setTimeout(() => controller.abort(), 30000);
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
      if (attempt === 5) throw new Error('Incomplete segment');
    } catch (err) {
      clearTimeout(stallTimer);
      if (attempt === 5) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

async function downloadFileParallel(url, destPath, onProgress, concurrency = 4) {
  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  const tmpPath = `${destPath}.part`;

  let finalUrl = url;
  let total = 0;
  let supportsRanges = false;

  const headRes = await fetchWithRetry(url, { method: 'HEAD' }, 2);
  finalUrl = headRes.url || url;
  total = Number.parseInt(headRes.headers.get('content-length') || '0', 10);
  supportsRanges =
    (headRes.headers.get('accept-ranges') || '').toLowerCase().includes('bytes') &&
    total > 512 * 1024;

  if (supportsRanges && total > 0 && !fs.existsSync(tmpPath)) {
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

  // Single-stream with Range resume when .part already exists
  let existingBytes = 0;
  try {
    const st = await fsp.stat(tmpPath);
    existingBytes = st.size;
  } catch {
    existingBytes = 0;
  }

  for (let attempt = 0; attempt < 4; attempt++) {
    const headers = existingBytes > 0 ? { Range: `bytes=${existingBytes}-` } : {};
    const controller = new AbortController();
    let stallTimer = setTimeout(() => controller.abort(), 20000);
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
      if (attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, 1000));
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
      '--connect-timeout=15',
      '--timeout=25',
      '--max-tries=5',
      '--retry-wait=1',
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
  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  if (aria2cPath && fs.existsSync(aria2cPath)) {
    try {
      await downloadWithAria2(aria2cPath, url, destPath, onProgress);
      return;
    } catch {
      // If aria2c left a partial without .aria2 control file, clean it before Node fallback
      if (fs.existsSync(destPath) && !fs.existsSync(`${destPath}.aria2`)) {
        await fsp.rm(destPath, { force: true }).catch(() => {});
      }
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

async function installAtomically(stagedPath, finalDest, name) {
  const ok = await verifyBinaryExecutable(stagedPath, name);
  if (!ok) {
    throw new Error(`${name} failed integrity verification after download.`);
  }
  const tmpDest = `${finalDest}.tmp`;
  await fsp.copyFile(stagedPath, tmpDest);
  await fsp.rm(finalDest, { force: true });
  await fsp.rename(tmpDest, finalDest);
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

async function installAria2(binDir, cacheDir, emit) {
  const dest = path.join(binDir, 'aria2c.exe');
  if (await verifyBinaryExecutable(dest, 'aria2c.exe')) return dest;
  await fsp.rm(dest, { force: true });

  emit({ tool: 'aria2c', stage: 'downloading', percent: 0, message: 'Fetching aria2c release...' });
  const url = await resolveAria2Url();
  const zipPath = path.join(cacheDir, 'aria2.zip');
  const extractDir = path.join(cacheDir, 'aria2-out');

  if (!fs.existsSync(zipPath)) {
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
  }

  emit({ tool: 'aria2c', stage: 'extracting', percent: 85, message: 'Extracting aria2c.exe...' });
  await fsp.rm(extractDir, { recursive: true, force: true });
  try {
    await expandZip(zipPath, extractDir);
  } catch {
    // Corrupt cached zip: remove and fail cleanly so retry downloads fresh
    await fsp.rm(zipPath, { force: true });
    throw new Error('Downloaded aria2c archive was corrupted. Retrying will download a fresh copy.');
  }
  const exePath = await findFileRecursive(extractDir, 'aria2c.exe');
  if (!exePath) {
    await fsp.rm(zipPath, { force: true });
    throw new Error('aria2c.exe was not found in downloaded archive.');
  }
  await installAtomically(exePath, dest, 'aria2c.exe');
  await fsp.rm(zipPath, { force: true });
  await fsp.rm(extractDir, { recursive: true, force: true });
  emit({ tool: 'aria2c', stage: 'done', percent: 100, message: 'aria2c.exe ready' });
  return dest;
}

async function installYtDlp(binDir, cacheDir, aria2cPath, emit) {
  const dest = path.join(binDir, 'yt-dlp.exe');
  if (await verifyBinaryExecutable(dest, 'yt-dlp.exe')) return;
  await fsp.rm(dest, { force: true });

  const staged = path.join(cacheDir, 'yt-dlp.exe');
  emit({ tool: 'yt-dlp', stage: 'downloading', percent: 0, message: 'Downloading yt-dlp.exe...' });
  await downloadFast(
    aria2cPath,
    'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe',
    staged,
    (percent) =>
      emit({
        tool: 'yt-dlp',
        stage: 'downloading',
        percent,
        message: `Downloading yt-dlp.exe (${percent}%)`,
      })
  );

  try {
    await installAtomically(staged, dest, 'yt-dlp.exe');
  } catch (err) {
    await fsp.rm(staged, { force: true });
    await fsp.rm(`${staged}.aria2`, { force: true });
    throw err;
  }
  await fsp.rm(staged, { force: true });
  emit({ tool: 'yt-dlp', stage: 'done', percent: 100, message: 'yt-dlp.exe ready' });
}

async function installFfmpeg(binDir, cacheDir, aria2cPath, emit) {
  const ffmpegDest = path.join(binDir, 'ffmpeg.exe');
  const ffprobeDest = path.join(binDir, 'ffprobe.exe');
  const ffmpegOk = await verifyBinaryExecutable(ffmpegDest, 'ffmpeg.exe');
  const ffprobeOk = await verifyBinaryExecutable(ffprobeDest, 'ffprobe.exe');
  if (ffmpegOk && ffprobeOk) return;

  if (!ffmpegOk) await fsp.rm(ffmpegDest, { force: true });
  if (!ffprobeOk) await fsp.rm(ffprobeDest, { force: true });

  emit({ tool: 'ffmpeg', stage: 'downloading', percent: 0, message: 'Downloading FFmpeg essentials...' });
  const zipPath = path.join(cacheDir, 'ffmpeg.zip');
  const extractDir = path.join(cacheDir, 'ffmpeg-out');

  if (!fs.existsSync(zipPath)) {
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
  }

  emit({ tool: 'ffmpeg', stage: 'extracting', percent: 85, message: 'Extracting ffmpeg.exe & ffprobe.exe...' });
  await fsp.rm(extractDir, { recursive: true, force: true });
  try {
    await expandZip(zipPath, extractDir);
  } catch {
    await fsp.rm(zipPath, { force: true });
    throw new Error('Downloaded FFmpeg archive was corrupted. Retrying will download a fresh copy.');
  }

  const ffmpegExe = await findFileRecursive(extractDir, 'ffmpeg.exe');
  const ffprobeExe = await findFileRecursive(extractDir, 'ffprobe.exe');
  if (!ffmpegExe || !ffprobeExe) {
    await fsp.rm(zipPath, { force: true });
    throw new Error('ffmpeg.exe or ffprobe.exe was not found in downloaded archive.');
  }

  if (!ffmpegOk) await installAtomically(ffmpegExe, ffmpegDest, 'ffmpeg.exe');
  if (!ffprobeOk) await installAtomically(ffprobeExe, ffprobeDest, 'ffprobe.exe');

  await fsp.rm(zipPath, { force: true });
  await fsp.rm(extractDir, { recursive: true, force: true });
  emit({ tool: 'ffmpeg', stage: 'done', percent: 100, message: 'FFmpeg & ffprobe ready' });
}

async function setupBinaries(binDir, onProgress) {
  const emit = onProgress || (() => {});
  await fsp.mkdir(binDir, { recursive: true });

  const unhealthy = await getUnhealthyBinaries(binDir);
  if (unhealthy.length === 0) {
    emit({ tool: 'all', stage: 'done', percent: 100, message: 'All binaries already installed.' });
    return { binDir, installed: [] };
  }

  const cacheDir = path.join(binDir, '.setup-cache');
  await fsp.mkdir(cacheDir, { recursive: true });

  try {
    const aria2cPath = await installAria2(binDir, cacheDir, emit);
    await installYtDlp(binDir, cacheDir, aria2cPath, emit);
    await installFfmpeg(binDir, cacheDir, aria2cPath, emit);
    await fsp.rm(cacheDir, { recursive: true, force: true }).catch(() => {});
  } catch (err) {
    throw new Error(mapSetupError(err));
  }

  return { binDir, installed: unhealthy };
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
  BINARY_SPECS,
  REQUIRED_BINARIES,
  isBinaryStructurallyValid,
  verifyBinaryExecutable,
  getMissingBinaries,
  getUnhealthyBinaries,
  mapSetupError,
  setupBinaries,
};
