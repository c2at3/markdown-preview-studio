// Speeds up repeat visits by caching the third-party libraries the app
// loads from CDNs (CodeMirror, highlight.js, DOMPurify, marked, mermaid) -
// that's normally a dozen+ cross-origin round trips before the editor is
// even usable. It does NOT cache the app's own files (app.js, style.css,
// index.html) with a cache-first policy: those already opt out of caching
// server-side (Cache-Control: no-cache) specifically so a deploy is picked
// up immediately, and this worker respects that - network first, cache only
// as an offline fallback.

const VENDOR_CACHE = 'mdps-vendor-v2';
const SHELL_CACHE = 'mdps-shell-v2';

// Version-pinned URLs: the content at this exact URL never changes, safe to
// cache indefinitely (cache-first).
const PINNED_VENDOR_URLS = [
  'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.18/codemirror.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.18/addon/dialog/dialog.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.18/addon/search/matchesonscrollbar.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.18/codemirror.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.18/mode/markdown/markdown.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.18/mode/xml/xml.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.18/addon/mode/overlay.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.18/mode/gfm/gfm.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.18/addon/dialog/dialog.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.18/addon/search/searchcursor.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.18/addon/search/search.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.18/addon/search/jump-to-line.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.18/addon/search/matchesonscrollbar.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.18/addon/scroll/annotatescrollbar.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.1.6/purify.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js'
];

// Unpinned ("latest") CDN URLs: cached for instant reuse, but always
// re-fetched in the background so the cache doesn't go stale forever.
const UNPINNED_VENDOR_URLS = [
  'https://cdn.jsdelivr.net/npm/marked/marked.min.js',
  'https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VENDOR_CACHE).then((cache) => cache.addAll([...PINNED_VENDOR_URLS, ...UNPINNED_VENDOR_URLS]))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== VENDOR_CACHE && n !== SHELL_CACHE).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = request.url;

  if (PINNED_VENDOR_URLS.includes(url)) {
    event.respondWith(
      caches.match(request).then((cached) => cached || fetch(request).then((res) => {
        const clone = res.clone();
        caches.open(VENDOR_CACHE).then((c) => c.put(request, clone));
        return res;
      }))
    );
    return;
  }

  if (UNPINNED_VENDOR_URLS.includes(url)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        const fresh = fetch(request).then((res) => {
          const clone = res.clone();
          caches.open(VENDOR_CACHE).then((c) => c.put(request, clone));
          return res;
        }).catch(() => cached);
        return cached || fresh;
      })
    );
    return;
  }

  // Same-origin app shell (app.js, style.css, /, index.html) - never serve a
  // cached copy while the network is reachable; only fall back to it if
  // offline, so a deploy is still picked up immediately when online.
  if (url.startsWith(self.location.origin) && !url.includes('/api/') && !url.includes('/uploads/')) {
    event.respondWith(
      fetch(request).then((res) => {
        const clone = res.clone();
        caches.open(SHELL_CACHE).then((c) => c.put(request, clone));
        return res;
      }).catch(() => caches.match(request))
    );
  }
});
