(() => {
  if (window.__sniprInjected) return;
  window.__sniprInjected = true;

  const PAGE_FIRST_HOSTS = [
    'youtube.com',
    'youtu.be',
    'facebook.com',
    'fb.watch',
    'instagram.com',
    'tiktok.com',
    'twitter.com',
    'x.com',
    'vimeo.com',
    'dailymotion.com',
    'twitch.tv',
    'reddit.com',
  ];

  const trackedVideos = new WeakMap();
  const dismissedVideos = new WeakSet();

  function prefersPageUrl() {
    const host = location.hostname.toLowerCase();
    return PAGE_FIRST_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  }

  function resolveDownloadUrl(video) {
    const pageUrl = location.href;
    if (prefersPageUrl()) return pageUrl;
    const src = video.currentSrc || video.src;
    if (src && (src.startsWith('http://') || src.startsWith('https://'))) {
      return src;
    }
    return pageUrl;
  }

  function createFloatingBar(video) {
    const host = document.createElement('div');
    host.className = 'snipr-ext-host';
    host.style.position = 'fixed';
    host.style.zIndex = '2147483647';
    host.style.pointerEvents = 'none';
    host.style.display = 'none';

    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        .bar {
          pointer-events: auto;
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 5px 8px;
          border-radius: 10px;
          background: rgba(15, 19, 28, 0.94);
          backdrop-filter: blur(10px);
          border: 1px solid rgba(56, 189, 248, 0.45);
          box-shadow: 0 10px 26px rgba(0, 0, 0, 0.5);
          color: #f8fafc;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          font-size: 12px;
          line-height: 1;
          transition: opacity 0.15s ease, transform 0.15s ease;
        }
        .dl-btn {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          border: none;
          border-radius: 7px;
          padding: 6px 11px;
          background: linear-gradient(135deg, #0ea5e9, #2563eb);
          color: #fff;
          font-weight: 700;
          font-size: 12px;
          cursor: pointer;
          white-space: nowrap;
        }
        .dl-btn:hover {
          filter: brightness(1.1);
        }
        .dl-btn:disabled {
          opacity: 0.7;
          cursor: default;
        }
        .q-select {
          background: rgba(27, 33, 46, 0.96);
          color: #e2e8f0;
          border: 1px solid rgba(148, 163, 184, 0.35);
          border-radius: 6px;
          padding: 4px 6px;
          font-size: 11px;
          font-weight: 600;
          outline: none;
          cursor: pointer;
        }
        .close-btn {
          background: transparent;
          border: none;
          color: #94a3b8;
          cursor: pointer;
          padding: 4px 5px;
          border-radius: 6px;
          font-size: 13px;
          line-height: 1;
        }
        .close-btn:hover {
          color: #fff;
          background: rgba(255, 255, 255, 0.12);
        }
        .status {
          font-size: 11px;
          color: #86efac;
          font-weight: 600;
          padding: 0 4px;
          display: none;
          white-space: nowrap;
        }
        .status.err {
          color: #fca5a5;
        }
      </style>
      <div class="bar">
        <button class="dl-btn" type="button" title="Download this video by Snipr Download Manager">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="9"/>
            <path d="M13 7l-3 5h4l-2 5"/>
          </svg>
          <span>Download by Snipr</span>
        </button>
        <select class="q-select" title="Select quality">
          <option value="best">Best (MP4)</option>
          <option value="1080p">1080p</option>
          <option value="720p">720p</option>
          <option value="480p">480p</option>
          <option value="mp3">MP3 Audio</option>
        </select>
        <span class="status"></span>
        <button class="close-btn" type="button" title="Hide for this video">✕</button>
      </div>
    `;

    const dlBtn = shadow.querySelector('.dl-btn');
    const select = shadow.querySelector('.q-select');
    const closeBtn = shadow.querySelector('.close-btn');
    const statusEl = shadow.querySelector('.status');

    function showStatus(text, isErr = false) {
      statusEl.textContent = text;
      statusEl.classList.toggle('err', isErr);
      statusEl.style.display = 'inline';
      setTimeout(() => {
        statusEl.style.display = 'none';
      }, 3200);
    }

    dlBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const targetUrl = resolveDownloadUrl(video);
      dlBtn.disabled = true;
      chrome.runtime.sendMessage(
        {
          type: 'SNIPR_SEND',
          payload: {
            url: targetUrl,
            title: document.title || 'Web Video',
            quality: select.value,
            autoStart: true,
          },
        },
        (resp) => {
          dlBtn.disabled = false;
          if (chrome.runtime.lastError || !resp?.ok) {
            if (resp?.needsToken) {
              showStatus('Pair Token in Popup', true);
            } else {
              showStatus(resp?.offline ? 'Open Snipr App!' : 'Failed', true);
            }
          } else if (resp.status === 'queued') {
            showStatus('Queued ✓');
          } else {
            showStatus('Snipr Downloading ✓');
          }
        }
      );
    });

    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      dismissedVideos.add(video);
      host.style.display = 'none';
    });

    document.documentElement.appendChild(host);
    return host;
  }

  function updatePosition(video, host) {
    if (dismissedVideos.has(video) || !document.contains(video)) {
      host.style.display = 'none';
      return;
    }
    const rect = video.getBoundingClientRect();
    if (
      rect.width < 200 ||
      rect.height < 120 ||
      rect.bottom < 0 ||
      rect.top > window.innerHeight ||
      rect.right < 0 ||
      rect.left > window.innerWidth
    ) {
      host.style.display = 'none';
      return;
    }

    const top = Math.max(8, rect.top + 10);
    const left = Math.max(8, rect.right - 310);
    host.style.top = `${top}px`;
    host.style.left = `${left}px`;
    host.style.display = 'block';
  }

  function attachVideo(video) {
    if (trackedVideos.has(video)) return;
    const host = createFloatingBar(video);
    trackedVideos.set(video, host);

    if (video.currentSrc || video.src) {
      chrome.runtime.sendMessage({
        type: 'SNIPR_CONTENT_FOUND_VIDEO',
        src: video.currentSrc || video.src,
      });
    }

    let hideTimer = null;
    const show = () => {
      clearTimeout(hideTimer);
      updatePosition(video, host);
    };
    const scheduleHide = () => {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        if (!host.matches(':hover')) {
          host.style.display = 'none';
        }
      }, 2200);
    };

    video.addEventListener('mouseenter', show);
    video.addEventListener('mousemove', show);
    video.addEventListener('play', show);
    video.addEventListener('mouseleave', scheduleHide);
    host.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    host.addEventListener('mouseleave', scheduleHide);

    if (!video.paused) {
      show();
      scheduleHide();
    }
  }

  function scanVideos() {
    const videos = document.querySelectorAll('video');
    videos.forEach(attachVideo);
  }

  scanVideos();
  const observer = new MutationObserver(() => scanVideos());
  observer.observe(document.documentElement, { childList: true, subtree: true });

  window.addEventListener(
    'scroll',
    () => {
      document.querySelectorAll('video').forEach((v) => {
        const host = trackedVideos.get(v);
        if (host && host.style.display !== 'none') {
          updatePosition(v, host);
        }
      });
    },
    { passive: true }
  );
})();
