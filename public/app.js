(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  const preview = $('#preview');
  const fileNameInput = $('#file-name');
  const fileList = $('#file-list');
  const saveStatus = $('#save-status');
  const toast = $('#toast');
  const modalOverlay = $('#modal-overlay');
  const modalTitle = $('#modal-title');
  const modalBody = $('#modal-body');
  const sidebar = $('#sidebar');

  // ===== CodeMirror Editor =====
  const cm = CodeMirror($('#editor-wrap'), {
    mode: 'gfm',
    theme: 'default',
    lineNumbers: true,
    lineWrapping: true,
    tabSize: 2,
    indentWithTabs: false,
    placeholder: 'Start writing markdown...',
    viewportMargin: Infinity,
    extraKeys: {
      'Tab': (cm) => cm.replaceSelection('  '),
      'Ctrl-B': () => insertAround('**', '**'),
      'Ctrl-I': () => insertAround('*', '*'),
      'Ctrl-S': () => showToast('All changes saved automatically'),
      'Ctrl-F': () => toggleFindPanel(true),
      'Ctrl-H': () => { toggleFindPanel(true); replaceInput.focus(); },
    }
  });

  let files = [];
  let folders = [];
  let activeFileId = null;
  let saveTimer = null;
  let isSharedView = false;
  let dragItem = null;
  let dragType = null;
  let staleBannerShown = false;

  // ===== Loading state for async action buttons =====
  const SPINNER_SVG = '<svg class="spinner-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><circle cx="12" cy="12" r="9" opacity="0.25"/><path d="M21 12a9 9 0 00-9-9"/></svg>';
  async function withLoading(btn, fn) {
    if (!btn) return fn();
    const original = btn.innerHTML;
    const wasDisabled = btn.disabled;
    btn.innerHTML = SPINNER_SVG;
    btn.disabled = true;
    try {
      return await fn();
    } finally {
      btn.innerHTML = original;
      btn.disabled = wasDisabled;
    }
  }

  const DEFAULT_MD = `# Welcome to Markdown Live Preview

Write your markdown on the left, see the result on the right - in real time.

## Features

- **Live preview** with syntax highlighting
- **Folders** to organize your files
- **Drag & drop** to reorder and move
- **Share** your documents via link
- **Export** to PDF
- **Dark mode** support
- **Image upload** support
- **Mermaid** diagram rendering

## Formatting Examples

### Text Styles

*Italic text* and **bold text** and ***bold italic***.

~~Strikethrough~~ and \`inline code\`.

### Links & Images

Visit [GitHub](https://github.com) for more info.

![Sample image](https://picsum.photos/600/200)

### Blockquote

> "The best way to predict the future is to invent it."
> - Alan Kay

### Code Block

\`\`\`javascript
function greet(name) {
  return \`Hello, \${name}!\`;
}

console.log(greet('World'));
\`\`\`

### Table

| Feature       | Status |
| ------------- | ------ |
| Live Preview  | ✅     |
| Folders       | ✅     |
| Drag & Drop   | ✅     |
| Image Upload  | ✅     |
| Share Links   | ✅     |

### Task List

- [x] Create editor
- [x] Add preview
- [x] Database storage
- [x] Folder support
- [ ] More themes

### Mermaid Diagram

\`\`\`mermaid
graph TD
    A[Write Markdown] --> B{Preview}
    B --> C[Share]
    B --> D[Export PDF]
    C --> E[Collaborate]
\`\`\`

---

*Start editing to see the magic happen!*
`;

  // ===== API =====
  const api = {
    async getFiles() { return (await fetch('/api/files')).json(); },
    async createFile(name, content, folder_id) {
      return (await fetch('/api/files', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, content, folder_id })
      })).json();
    },
    async getFile(id) { return (await fetch('/api/files/' + id)).json(); },
    async updateFile(id, data) {
      return (await fetch('/api/files/' + id, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      })).json();
    },
    async deleteFile(id) { await fetch('/api/files/' + id, { method: 'DELETE' }); },
    async shareFile(id) { return (await fetch('/api/files/' + id + '/share', { method: 'POST' })).json(); },
    async getShared(shareId) { const r = await fetch('/api/shared/' + shareId); return r.ok ? r.json() : null; },
    async forkShared(shareId) { return (await fetch('/api/shared/' + shareId + '/fork', { method: 'POST' })).json(); },
    async getFolders() { return (await fetch('/api/folders')).json(); },
    async createFolder(name, parent_id) {
      return (await fetch('/api/folders', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, parent_id })
      })).json();
    },
    async updateFolder(id, data) {
      return (await fetch('/api/folders/' + id, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      })).json();
    },
    async deleteFolder(id) { await fetch('/api/folders/' + id, { method: 'DELETE' }); },
    async getTemplates() { return (await fetch('/api/templates')).json(); },
    async createTemplate(name, content) {
      return (await fetch('/api/templates', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, content })
      })).json();
    },
    async updateTemplate(id, data) {
      return (await fetch('/api/templates/' + id, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      })).json();
    },
    async deleteTemplate(id) { await fetch('/api/templates/' + id, { method: 'DELETE' }); },
    async getApiKeys() { return (await fetch('/api/apikeys')).json(); },
    async createApiKey(name) {
      return (await fetch('/api/apikeys', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      })).json();
    },
    async deleteApiKey(id) { await fetch('/api/apikeys/' + id, { method: 'DELETE' }); },
    async uploadImage(data, filename) {
      return (await fetch('/api/upload', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data, filename })
      })).json();
    }
  };

  // ===== Marked config =====
  const renderer = new marked.Renderer();

  renderer.code = function (code, language) {
    if (typeof code === 'object') { language = code.lang; code = code.text; }
    if (language === 'mermaid') {
      return '<div class="mermaid-placeholder" data-mermaid="' + encodeURIComponent(code) + '"><div style="padding:20px;text-align:center;color:var(--text-3)">Loading diagram...</div></div>';
    }
    let highlighted = code;
    if (language && hljs.getLanguage(language)) {
      try { highlighted = hljs.highlight(code, { language }).value; } catch (e) {}
    } else {
      try { highlighted = hljs.highlightAuto(code).value; } catch (e) {}
    }
    return '<pre><code class="hljs language-' + (language || '') + '">' + highlighted + '</code></pre>';
  };

  renderer.checkbox = function (checked) {
    const c = (typeof checked === 'object') ? checked.checked : checked;
    return '<input type="checkbox" disabled' + (c ? ' checked' : '') + '> ';
  };

  marked.setOptions({ breaks: true, gfm: true });
  marked.use({ renderer });

  // ===== Mermaid =====
  const MERMAID_FONT = '"Inter", "Segoe UI", "Roboto", "Noto Sans", sans-serif';

  function initMermaid() {
    const isDark = document.body.classList.contains('dark');
    mermaid.initialize({
      startOnLoad: false, theme: isDark ? 'dark' : 'default',
      securityLevel: 'loose', suppressErrorRendering: true,
      fontFamily: MERMAID_FONT, fontSize: 13,
      flowchart: { curve: 'basis', padding: 20, htmlLabels: true, useMaxWidth: true, nodeSpacing: 30, rankSpacing: 40 },
      themeVariables: {
        fontFamily: MERMAID_FONT, fontSize: '13px',
        primaryColor: isDark ? '#334155' : '#e0e7ff',
        primaryTextColor: isDark ? '#e2e8f0' : '#1e293b',
        primaryBorderColor: isDark ? '#475569' : '#818cf8',
        lineColor: isDark ? '#64748b' : '#94a3b8',
        secondaryColor: isDark ? '#1e293b' : '#f1f5f9',
        tertiaryColor: isDark ? '#1e293b' : '#f8fafc'
      }
    });
  }
  initMermaid();

  function cleanupMermaidErrors() {
    document.querySelectorAll('[id^="dmmd-"]').forEach(el => el.remove());
    document.querySelectorAll('.mermaid-error, .error-icon, [id*="mermaid"] .error-text').forEach(el => {
      if (!preview.contains(el)) el.remove();
    });
  }

  // preview.innerHTML is fully rebuilt on every keystroke (see render() below),
  // which would otherwise re-run mermaid's layout engine for every diagram in
  // the document on every render, even ones nowhere near the edit. Cache the
  // rendered SVG by diagram source so only a diagram whose own code actually
  // changed pays that cost again.
  const mermaidCache = new Map();

  async function renderMermaidBlocks() {
    const els = preview.querySelectorAll('.mermaid-placeholder');
    for (const el of els) {
      const code = decodeURIComponent(el.getAttribute('data-mermaid'));
      const cached = mermaidCache.get(code);
      if (cached) {
        el.innerHTML = cached;
        el.classList.replace('mermaid-placeholder', 'mermaid-rendered');
        continue;
      }
      try {
        const id = 'mmd-' + Date.now() + '-' + Math.random().toString(36).slice(2, 5);
        const { svg } = await mermaid.render(id, code);
        mermaidCache.set(code, svg);
        el.innerHTML = svg;
        el.classList.replace('mermaid-placeholder', 'mermaid-rendered');
      } catch (e) {
        cleanupMermaidErrors();
        const msg = (e.message || 'Invalid syntax').replace(/<[^>]*>/g, '').substring(0, 200);
        el.innerHTML = '<div class="mermaid-error-box"><div><strong>Mermaid syntax error</strong><pre class="mermaid-error-detail">' + msg + '</pre></div></div>';
        el.classList.replace('mermaid-placeholder', 'mermaid-rendered');
      }
    }
    cleanupMermaidErrors();
  }

  // ===== Rendering =====
  let renderTimer = null;
  let isRendering = false;

  function scheduleRender() { clearTimeout(renderTimer); renderTimer = setTimeout(render, 60); }

  function render() {
    isRendering = true;
    preview.innerHTML = DOMPurify.sanitize(marked.parse(cm.getValue()), {
      ADD_TAGS: ['input'],
      ADD_ATTR: ['target', 'checked', 'disabled', 'data-mermaid']
    });
    preview.querySelectorAll('a').forEach(a => {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    });
    renderMermaidBlocks().then(wrapZoomableMedia);
    wrapZoomableMedia();
    updateStats();
    setTimeout(() => { isRendering = false; syncPreviewToEditor(); }, 10);
  }

  // ===== Lightbox with zoom/pan =====
  const lightbox = $('#lightbox');
  const lbViewport = $('#lightbox-viewport');
  const lbTransform = $('#lightbox-transform');
  const lbCaption = $('#lightbox-caption');
  const lbZoomLevel = $('#lb-zoom-level');

  let lbZoom = 1, lbPanX = 0, lbPanY = 0, lbDragging = false, lbDragStart = { x: 0, y: 0 };
  let lbIsSvg = false, lbSvgBaseW = 0, lbSvgBaseH = 0, lbSource = null, lbOriginalSvg = null;
  const LB_MIN_ZOOM = 0.25, LB_MAX_ZOOM = 5, LB_ZOOM_STEP = 0.25;

  function lbApplyTransform(animate) {
    if (animate) lbTransform.classList.add('animate'); else lbTransform.classList.remove('animate');
    if (lbIsSvg) {
      const svg = lbTransform.querySelector('svg');
      if (svg) { svg.setAttribute('width', Math.round(lbSvgBaseW * lbZoom)); svg.setAttribute('height', Math.round(lbSvgBaseH * lbZoom)); }
      lbTransform.style.transform = `translate(${lbPanX}px, ${lbPanY}px)`;
    } else {
      lbTransform.style.transform = `translate(${lbPanX}px, ${lbPanY}px) scale(${lbZoom})`;
    }
    lbZoomLevel.textContent = Math.round(lbZoom * 100) + '%';
  }

  function lbSetZoom(newZoom, cx, cy) {
    const clamped = Math.max(LB_MIN_ZOOM, Math.min(LB_MAX_ZOOM, newZoom));
    if (cx !== undefined) { const r = clamped / lbZoom; lbPanX = cx - (cx - lbPanX) * r; lbPanY = cy - (cy - lbPanY) * r; }
    lbZoom = clamped; lbApplyTransform(false);
  }

  function lbReset() { lbZoom = 1; lbPanX = 0; lbPanY = 0; lbApplyTransform(true); }

  function openLightbox(content, caption) {
    lbTransform.innerHTML = ''; lbZoom = 1; lbPanX = 0; lbPanY = 0; lbIsSvg = false; lbSource = content; lbOriginalSvg = null;
    if (typeof content === 'string') {
      const img = document.createElement('img');
      img.className = 'lightbox-content'; img.src = content; img.alt = caption || ''; img.draggable = false;
      lbTransform.appendChild(img);
    } else {
      lbIsSvg = true;
      lbOriginalSvg = content;
      const svgClone = content.cloneNode(true);
      const vb = svgClone.getAttribute('viewBox');
      const vbParts = vb ? vb.split(/[\s,]+/).map(Number) : null;
      const naturalW = vbParts ? vbParts[2] : 800, naturalH = vbParts ? vbParts[3] : 600;
      if (!vb) svgClone.setAttribute('viewBox', '0 0 ' + naturalW + ' ' + naturalH);
      const fitScale = Math.min(1, window.innerWidth * 0.85 / naturalW, window.innerHeight * 0.8 / naturalH);
      lbSvgBaseW = naturalW * fitScale; lbSvgBaseH = naturalH * fitScale;
      svgClone.removeAttribute('style'); svgClone.removeAttribute('width'); svgClone.removeAttribute('height');
      svgClone.setAttribute('width', Math.round(lbSvgBaseW)); svgClone.setAttribute('height', Math.round(lbSvgBaseH));
      svgClone.setAttribute('overflow', 'hidden');
      svgClone.style.cssText = 'display:block;background:var(--surface);border-radius:var(--radius);padding:16px;box-sizing:content-box;box-shadow:0 4px 40px rgba(0,0,0,0.5);';
      svgClone.setAttribute('shape-rendering', 'geometricPrecision'); svgClone.setAttribute('text-rendering', 'optimizeLegibility');
      lbTransform.appendChild(svgClone);
    }
    lbCaption.textContent = caption || ''; lbCaption.style.display = caption ? '' : 'none';
    lbApplyTransform(false); lightbox.classList.add('open'); document.body.style.overflow = 'hidden';
  }

  function closeLightbox() { lightbox.classList.remove('open'); lbTransform.innerHTML = ''; document.body.style.overflow = ''; }

  $('#lb-zoom-in').addEventListener('click', () => { lbSetZoom(lbZoom + LB_ZOOM_STEP); lbApplyTransform(true); });
  $('#lb-zoom-out').addEventListener('click', () => { lbSetZoom(lbZoom - LB_ZOOM_STEP); lbApplyTransform(true); });
  $('#lb-reset').addEventListener('click', lbReset);
  $('#lb-download').addEventListener('click', () => {
    if (!lbSource) return;
    if (typeof lbSource === 'string') {
      const a = document.createElement('a');
      a.href = lbSource;
      a.download = lbSource.split('/').pop() || 'image';
      a.click();
    } else {
      showDiagramDownloadMenu();
    }
  });

  function showDiagramDownloadMenu() {
    const btn = $('#lb-download');
    const rect = btn.getBoundingClientRect();
    let menu = $('#lb-download-menu');
    if (menu) { menu.remove(); return; }

    menu = document.createElement('div');
    menu.id = 'lb-download-menu';
    menu.className = 'lb-download-menu';
    menu.style.top = (rect.bottom + 6) + 'px';
    menu.style.left = rect.left + 'px';

    // Use original preview SVG for real dimensions
    const origSvg = lbOriginalSvg || lbTransform.querySelector('svg');
    const vb = origSvg?.getAttribute('viewBox');
    const vbParts = vb ? vb.split(/[\s,]+/).map(Number) : null;
    // For mermaid with useMaxWidth, viewBox has the natural size
    // but we also check the SVG's rendered size in preview for accuracy
    let baseW, baseH;
    if (vbParts && vbParts[2] > 0) {
      baseW = Math.round(vbParts[2]);
      baseH = Math.round(vbParts[3]);
    } else {
      baseW = origSvg?.getBoundingClientRect?.()?.width || parseInt(origSvg?.getAttribute('width')) || 800;
      baseH = origSvg?.getBoundingClientRect?.()?.height || parseInt(origSvg?.getAttribute('height')) || 600;
    }

    const scales = [
      { pct: 50, s: 0.5 },
      { pct: 100, s: 1 },
      { pct: 150, s: 1.5 },
      { pct: 200, s: 2 },
      { pct: 300, s: 3 },
      { pct: 500, s: 5 },
    ];
    const pngItems = scales.map(({ pct, s }) => {
      const w = Math.round(baseW * s);
      const h = Math.round(baseH * s);
      return '<div class="lb-dl-item" data-format="png" data-scale="' + s + '">PNG ' + pct + '% <span style="color:rgba(255,255,255,0.4);font-size:10px;margin-left:4px">' + w + '×' + h + '</span></div>';
    }).join('');

    menu.innerHTML = '<div class="lb-dl-item" data-format="svg">SVG (vector)</div><div class="lb-dl-divider"></div><div class="lb-dl-label">PNG (raster)</div>' + pngItems;

    menu.addEventListener('click', (e) => {
      const item = e.target.closest('.lb-dl-item');
      if (!item) return;
      menu.remove();
      const format = item.dataset.format;
      const svgEl = lbTransform.querySelector('svg');
      if (!svgEl) return;

      const srcSvg = lbOriginalSvg || lbTransform.querySelector('svg');
      if (!srcSvg) return;
      if (format === 'svg') {
        const clone = srcSvg.cloneNode(true);
        clone.removeAttribute('style');
        clone.removeAttribute('width');
        clone.removeAttribute('height');
        const blob = new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'diagram.svg';
        a.click();
        URL.revokeObjectURL(a.href);
      } else {
        const scale = parseFloat(item.dataset.scale);
        exportSvgAsPng(srcSvg, scale, baseW, baseH);
      }
    });

    document.body.appendChild(menu);
    const closeMenu = (e) => { if (!menu.contains(e.target) && e.target !== btn) { menu.remove(); document.removeEventListener('click', closeMenu); } };
    setTimeout(() => document.addEventListener('click', closeMenu), 0);
  }

  function exportSvgAsPng(svgEl, scale, baseW, baseH) {
    const clone = svgEl.cloneNode(true);
    clone.removeAttribute('style');
    const vb = clone.getAttribute('viewBox');
    const parts = vb ? vb.split(/[\s,]+/).map(Number) : null;
    const w = baseW || (parts ? parts[2] : parseFloat(clone.getAttribute('width')) || 800);
    const h = baseH || (parts ? parts[3] : parseFloat(clone.getAttribute('height')) || 600);

    clone.setAttribute('width', w);
    clone.setAttribute('height', h);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');

    const svgData = new XMLSerializer().serializeToString(clone);
    const img = new Image();
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext('2d');

    img.onload = () => {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(blob => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'diagram-' + Math.round(scale * 100) + 'pct.png';
        a.click();
        URL.revokeObjectURL(a.href);
      }, 'image/png');
    };
    img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgData)));
  }

  $('#lb-close').addEventListener('click', closeLightbox);

  lbViewport.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = lbViewport.getBoundingClientRect();
    lbSetZoom(lbZoom + (e.deltaY > 0 ? -LB_ZOOM_STEP : LB_ZOOM_STEP), e.clientX - rect.left - rect.width / 2, e.clientY - rect.top - rect.height / 2);
  }, { passive: false });

  lbViewport.addEventListener('mousedown', (e) => {
    if (e.target.closest('.lightbox-toolbar')) return;
    lbDragging = true; lbDragStart = { x: e.clientX - lbPanX, y: e.clientY - lbPanY };
    lbViewport.classList.add('dragging'); e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => { if (!lbDragging) return; lbPanX = e.clientX - lbDragStart.x; lbPanY = e.clientY - lbDragStart.y; lbApplyTransform(false); });
  document.addEventListener('mouseup', () => { if (!lbDragging) return; lbDragging = false; lbViewport.classList.remove('dragging'); });

  lbViewport.addEventListener('dblclick', (e) => {
    if (e.target.closest('.lightbox-toolbar')) return;
    if (lbZoom > 1.1) lbReset();
    else { const rect = lbViewport.getBoundingClientRect(); lbSetZoom(2.5, e.clientX - rect.left - rect.width / 2, e.clientY - rect.top - rect.height / 2); lbApplyTransform(true); }
  });

  lbViewport.addEventListener('click', (e) => { if (e.target === lbViewport && lbZoom <= 1 && Math.abs(lbPanX) < 5 && Math.abs(lbPanY) < 5) closeLightbox(); });
  document.addEventListener('keydown', (e) => {
    if (!lightbox.classList.contains('open')) return;
    if (e.key === 'Escape') closeLightbox();
    if (e.key === '+' || e.key === '=') { lbSetZoom(lbZoom + LB_ZOOM_STEP); lbApplyTransform(true); }
    if (e.key === '-') { lbSetZoom(lbZoom - LB_ZOOM_STEP); lbApplyTransform(true); }
    if (e.key === '0') lbReset();
  });

  // ===== Wrap media with zoom buttons =====
  const ZOOM_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>';

  function wrapZoomableMedia() {
    preview.querySelectorAll('img:not(.wrapped-zoom)').forEach(img => {
      img.classList.add('wrapped-zoom');
      const wrapper = document.createElement('div'); wrapper.className = 'media-wrapper';
      img.parentNode.insertBefore(wrapper, img); wrapper.appendChild(img);
      const btn = document.createElement('button'); btn.className = 'media-zoom-btn'; btn.innerHTML = ZOOM_SVG; btn.title = 'Zoom';
      wrapper.appendChild(btn);
    });
    preview.querySelectorAll('.mermaid-rendered:not(.wrapped-zoom)').forEach(el => {
      const svg = el.querySelector('svg'); if (!svg) return;
      el.classList.add('wrapped-zoom');
      const wrapper = document.createElement('div'); wrapper.className = 'media-wrapper'; wrapper.style.display = 'block';
      el.parentNode.insertBefore(wrapper, el); wrapper.appendChild(el);
      const btn = document.createElement('button'); btn.className = 'media-zoom-btn'; btn.innerHTML = ZOOM_SVG; btn.title = 'Zoom diagram';
      wrapper.appendChild(btn);
    });
  }

  preview.addEventListener('click', (e) => {
    const btn = e.target.closest('.media-zoom-btn'); if (!btn) return;
    e.preventDefault(); e.stopPropagation();
    const wrapper = btn.closest('.media-wrapper');
    const img = wrapper?.querySelector('img');
    const svg = wrapper?.querySelector('.mermaid-rendered svg');
    if (img) openLightbox(img.src, img.alt);
    else if (svg) openLightbox(svg, 'Mermaid Diagram');
  });

  // ===== Font controls =====
  let editorFontSize = parseInt(localStorage.getItem('md-font-size')) || 14;
  let editorFontWeight = parseInt(localStorage.getItem('md-font-weight')) || 300;

  function applyFont() {
    const wrap = cm.getWrapperElement();
    wrap.style.fontSize = editorFontSize + 'px';
    wrap.style.fontWeight = editorFontWeight;
    wrap.style.setProperty('--editor-bold-weight', Math.min(900, editorFontWeight + 200));
    cm.refresh();
    $('#font-size-val').textContent = editorFontSize;
    $('#weight-val').textContent = editorFontWeight;
    localStorage.setItem('md-font-size', editorFontSize);
    localStorage.setItem('md-font-weight', editorFontWeight);
  }

  $('#font-up').addEventListener('click', () => { editorFontSize = Math.min(24, editorFontSize + 1); applyFont(); });
  $('#font-down').addEventListener('click', () => { editorFontSize = Math.max(10, editorFontSize - 1); applyFont(); });
  const WEIGHT_STEPS = [200, 300, 400, 500, 700];
  $('#weight-up').addEventListener('click', () => { const i = WEIGHT_STEPS.indexOf(editorFontWeight); editorFontWeight = WEIGHT_STEPS[Math.min(i + 1, WEIGHT_STEPS.length - 1)] || 700; applyFont(); });
  $('#weight-down').addEventListener('click', () => { const i = WEIGHT_STEPS.indexOf(editorFontWeight); editorFontWeight = WEIGHT_STEPS[Math.max(i - 1, 0)] || 200; applyFont(); });

  applyFont();

  // ===== Find/Replace =====
  const findPanel = $('#find-panel');
  const findInput = $('#find-input');
  const replaceInput = $('#replace-input');
  const findCount = $('#find-count');
  const findResults = $('#find-results');
  let findScope = 'file';
  let findMatchCase = false;
  let findUseRegex = false;
  let findMatches = [];
  let findCurrentIdx = -1;
  let findMarkers = [];

  function toggleFindPanel(show) {
    const visible = show !== undefined ? show : findPanel.style.display === 'none';
    findPanel.style.display = visible ? '' : 'none';
    if (visible) { findInput.focus(); findInput.select(); doFind(); }
    else { clearFindMarkers(); findMatches = []; findCurrentIdx = -1; findCount.textContent = ''; findResults.style.display = 'none'; $('#find-results-resizer').style.display = 'none'; }
  }

  function clearFindMarkers() {
    findMarkers.forEach(m => m.clear());
    findMarkers = [];
  }

  function buildRegex(query) {
    if (!query) return null;
    let pattern = findUseRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    try { return new RegExp(pattern, findMatchCase ? 'g' : 'gi'); }
    catch (e) { return null; }
  }

  function doFind() {
    const query = findInput.value;
    clearFindMarkers();
    findMatches = [];
    findCurrentIdx = -1;
    findResults.style.display = 'none';
    $('#find-results-resizer').style.display = 'none';
    findResults.innerHTML = '';

    if (!query) { findCount.textContent = ''; return; }

    if (findScope === 'file') {
      const text = cm.getValue();
      const re = buildRegex(query);
      if (!re) { findCount.textContent = ''; return; }
      let m;
      while ((m = re.exec(text)) !== null) {
        findMatches.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
        if (!re.global) break;
      }
      // Highlight all matches in editor
      findMatches.forEach((match, idx) => {
        const from = cm.posFromIndex(match.start);
        const to = cm.posFromIndex(match.end);
        findMarkers.push(cm.markText(from, to, { className: idx === 0 ? 'cm-find-active' : 'cm-find-match' }));
      });
      findCount.textContent = findMatches.length ? `${findMatches.length} found` : 'No results';
      if (findMatches.length) { findCurrentIdx = 0; scrollToMatch(); }
    } else {
      findAcrossFiles(query);
    }
  }

  function scrollToMatch() {
    if (!findMatches.length) return;
    // Update markers
    clearFindMarkers();
    findMatches.forEach((match, idx) => {
      const from = cm.posFromIndex(match.start);
      const to = cm.posFromIndex(match.end);
      findMarkers.push(cm.markText(from, to, { className: idx === findCurrentIdx ? 'cm-find-active' : 'cm-find-match' }));
    });
    // Scroll to current
    const m = findMatches[findCurrentIdx];
    const pos = cm.posFromIndex(m.start);
    cm.scrollIntoView(pos, 100);
    findCount.textContent = `${findCurrentIdx + 1} / ${findMatches.length}`;
  }

  async function findAcrossFiles(query) {
    const re = buildRegex(query);
    if (!re) { findCount.textContent = 'Invalid'; return; }
    const allFiles = await api.getFiles();
    const results = [];
    let totalMatches = 0;
    for (const f of allFiles) {
      const file = await api.getFile(f.id);
      const lines = file.content.split('\n');
      const fileMatches = [];
      lines.forEach((line, idx) => {
        re.lastIndex = 0;
        if (re.test(line)) { re.lastIndex = 0; fileMatches.push({ lineNum: idx + 1, line, fileId: f.id, fileName: f.name }); totalMatches++; }
      });
      if (fileMatches.length) results.push({ file: f, matches: fileMatches });
    }
    findCount.textContent = totalMatches ? `${totalMatches} in ${results.length} files` : 'No results';
    findResults.innerHTML = '';
    if (results.length) {
      findResults.style.display = ''; $('#find-results-resizer').style.display = '';
      results.forEach(r => {
        const fileEl = document.createElement('div'); fileEl.className = 'find-result-file';
        fileEl.textContent = r.file.name + ' (' + r.matches.length + ')';
        fileEl.addEventListener('click', () => switchFile(r.file.id));
        findResults.appendChild(fileEl);
        r.matches.forEach(m => {
          const lineEl = document.createElement('div'); lineEl.className = 'find-result-line';
          const highlighted = escapeHtml(m.line).replace(buildRegex(query), match => '<mark>' + match + '</mark>');
          lineEl.innerHTML = '<span style="color:var(--text-3);margin-right:6px">' + m.lineNum + ':</span>' + highlighted;
          lineEl.addEventListener('click', async () => {
            await switchFile(m.fileId);
            // Highlight all matches in this file
            const fileRe = buildRegex(query);
            if (fileRe) {
              clearFindMarkers();
              const text = cm.getValue();
              let fm;
              while ((fm = fileRe.exec(text)) !== null) {
                const from = cm.posFromIndex(fm.index);
                const to = cm.posFromIndex(fm.index + fm[0].length);
                findMarkers.push(cm.markText(from, to, { className: 'cm-find-match' }));
                if (!fileRe.global) break;
              }
            }
            // Jump to clicked line and highlight it
            const lineText = cm.getLine(m.lineNum - 1) || '';
            const re2 = buildRegex(query);
            if (re2) {
              const lineMatch = re2.exec(lineText);
              if (lineMatch) {
                const from = { line: m.lineNum - 1, ch: lineMatch.index };
                const to = { line: m.lineNum - 1, ch: lineMatch.index + lineMatch[0].length };
                findMarkers.push(cm.markText(from, to, { className: 'cm-find-active' }));
                cm.setSelection(from, to);
              }
            }
            cm.scrollIntoView({ line: m.lineNum - 1, ch: 0 }, 100);
            cm.focus();
          });
          findResults.appendChild(lineEl);
        });
      });
    }
  }

  function findNext() { if (!findMatches.length) return; findCurrentIdx = (findCurrentIdx + 1) % findMatches.length; scrollToMatch(); }
  function findPrev() { if (!findMatches.length) return; findCurrentIdx = (findCurrentIdx - 1 + findMatches.length) % findMatches.length; scrollToMatch(); }

  function replaceOne() {
    if (findScope !== 'file' || !findMatches.length || findCurrentIdx < 0) return;
    const m = findMatches[findCurrentIdx];
    const from = cm.posFromIndex(m.start);
    const to = cm.posFromIndex(m.end);
    cm.replaceRange(replaceInput.value, from, to);
    scheduleSave(); scheduleRender(); doFind();
  }

  function replaceAll() {
    if (findScope !== 'file') { replaceAllFiles(); return; }
    const query = findInput.value;
    const re = buildRegex(query);
    if (!re || !query) return;
    const text = cm.getValue();
    const replaced = text.replace(re, replaceInput.value);
    if (replaced === text) return;
    cm.setValue(replaced);
    scheduleSave(); scheduleRender(); doFind();
  }

  async function replaceAllFiles() {
    const query = findInput.value;
    const re = buildRegex(query);
    if (!re || !query) return;
    if (!confirm('Replace all occurrences across ALL files?')) return;
    const allFiles = await api.getFiles();
    let count = 0;
    for (const f of allFiles) {
      const file = await api.getFile(f.id);
      const replaced = file.content.replace(re, replaceInput.value);
      if (replaced !== file.content) { await api.updateFile(f.id, { content: replaced }); re.lastIndex = 0; count++; }
    }
    if (activeFileId) { const cur = await api.getFile(activeFileId); cm.setValue(cur.content); scheduleRender(); }
    showToast(count + ' files updated'); doFind();
  }

  // Find panel events
  $('#find-panel-close').addEventListener('click', () => toggleFindPanel(false));
  findInput.addEventListener('input', doFind);
  findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); findPrev(); }
    else if (e.key === 'Enter') { e.preventDefault(); findNext(); }
    if (e.key === 'Escape') toggleFindPanel(false);
  });
  replaceInput.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggleFindPanel(false); });
  $('#find-next').addEventListener('click', findNext);
  $('#find-prev').addEventListener('click', findPrev);
  $('#replace-one').addEventListener('click', replaceOne);
  $('#replace-all-btn').addEventListener('click', replaceAll);
  $('#find-opt-case').addEventListener('click', function() { findMatchCase = !findMatchCase; this.classList.toggle('active'); doFind(); });
  $('#find-opt-regex').addEventListener('click', function() { findUseRegex = !findUseRegex; this.classList.toggle('active'); doFind(); });
  $$('.find-tab').forEach(tab => {
    tab.addEventListener('click', () => { $$('.find-tab').forEach(t => t.classList.remove('active')); tab.classList.add('active'); findScope = tab.dataset.scope; doFind(); });
  });

  // ===== Folder color context menu =====
  const FOLDER_COLORS = [
    { name: 'Red', value: '#ef4444' },
    { name: 'Orange', value: '#f97316' },
    { name: 'Yellow', value: '#eab308' },
    { name: 'Green', value: '#22c55e' },
    { name: 'Blue', value: '#3b82f6' },
    { name: 'Purple', value: '#a855f7' },
    { name: 'Pink', value: '#ec4899' },
    { name: 'Teal', value: '#14b8a6' },
    { name: 'Gray', value: '#6b7280' },
  ];

  const ctxMenu = $('#context-menu');
  const ctxColors = $('#context-menu-colors');
  let ctxFolderId = null;

  // ===== File icons (right-click on a file) =====
  const FILE_ICONS = [
    { key: 'default', name: 'File', path: '<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>' },
    { key: 'note', name: 'Note', path: '<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M8 13h8M8 17h8"/>' },
    { key: 'bug', name: 'Bug', path: '<path d="M8 2l1.88 1.88M14.12 3.88L16 2"/><path d="M9 7.13V6a3 3 0 116 0v1.13"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 014-4h4a4 4 0 014 4v3c0 3.3-2.7 6-6 6z"/><path d="M12 20v-9M6.53 9C4.6 8.8 3 7.1 3 5M6 13H2M3 21c0-2.1 1.7-3.9 3.8-4M20.97 5c0 2.1-1.6 3.8-3.5 4M22 13h-4M17.2 17c2.1.1 3.8 1.9 3.8 4"/>' },
    { key: 'vulnerability', name: 'Vulnerability', path: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M12 8v4M12 16h.01"/>' },
    { key: 'lock', name: 'Security', path: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/>' },
    { key: 'warning', name: 'Warning', path: '<path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><path d="M12 9v4M12 17h.01"/>' },
    { key: 'work', name: 'Work', path: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16"/>' },
    { key: 'checklist', name: 'Checklist', path: '<polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/>' },
    { key: 'idea', name: 'Idea', path: '<path d="M9 18h6M10 22h4M12 2a6 6 0 016 6c0 3-2 4.5-3 6H9c-1-1.5-3-3-3-6a6 6 0 016-6z"/>' },
    { key: 'book', name: 'Book', path: '<path d="M4 19.5A2.5 2.5 0 016.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/>' },
    { key: 'chart', name: 'Chart', path: '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>' },
    { key: 'star', name: 'Star', path: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>' },
    { key: 'flag', name: 'Flag', path: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/>' },
    { key: 'rocket', name: 'Rocket', path: '<path d="M12 15l-3-3a22 22 0 012-3.95A12.88 12.88 0 0122 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 01-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>' },
    { key: 'calendar', name: 'Calendar', path: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>' },
    { key: 'code', name: 'Code', path: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>' },
  ];

  function fileIconHTML(f) {
    const icon = FILE_ICONS.find(i => i.key === f.icon) || FILE_ICONS[0];
    const color = f.icon_color || '';
    return '<svg class="file-item-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="' + (color || 'currentColor') + '" stroke-width="2">' + icon.path + '</svg>';
  }

  function showFileContextMenu(file, x, y) {
    $('#file-icon-menu')?.remove();
    const menu = document.createElement('div');
    menu.id = 'file-icon-menu';
    menu.className = 'context-menu';
    menu.style.display = 'block';
    menu.style.left = Math.min(x, window.innerWidth - 190) + 'px';
    menu.style.top = Math.min(y, window.innerHeight - 360) + 'px';

    const iconsHTML = FILE_ICONS.map(ic =>
      '<div class="ctx-icon-swatch' + ((file.icon || 'default') === ic.key ? ' active' : '') + '" data-icon="' + ic.key + '" title="' + ic.name + '">' +
        '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' + ic.path + '</svg>' +
      '</div>'
    ).join('');

    let colorsHTML = '<div class="ctx-color ctx-none' + (!file.icon_color ? ' active' : '') + '" data-color="" title="No color">✕</div>';
    FOLDER_COLORS.forEach(c => {
      colorsHTML += '<div class="ctx-color' + (file.icon_color === c.value ? ' active' : '') + '" data-color="' + c.value + '" style="background:' + c.value + '" title="' + c.name + '"></div>';
    });

    menu.innerHTML =
      '<button class="context-menu-item" data-action="pin">' +
        '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>' +
        (file.is_pinned ? 'Unpin' : 'Pin') + '</button>' +
      '<button class="context-menu-item" data-action="share">' +
        '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.59 13.51l6.83 3.98M15.41 6.51l-6.82 3.98"/></svg>' +
        'Share</button>' +
      '<div class="context-menu-divider"></div>' +
      '<div class="context-menu-label">Icon</div>' +
      '<div class="ctx-icons-grid">' + iconsHTML + '</div>' +
      '<div class="context-menu-divider"></div>' +
      '<div class="context-menu-label">Color</div>' +
      '<div class="context-menu-colors">' + colorsHTML + '</div>' +
      '<div class="context-menu-divider"></div>' +
      '<button class="context-menu-item context-menu-item-danger" data-action="delete">' +
        '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>' +
        'Delete</button>';
    document.body.appendChild(menu);

    menu.addEventListener('click', async (e) => {
      e.stopPropagation();
      const iconSwatch = e.target.closest('.ctx-icon-swatch');
      if (iconSwatch) {
        const icon = iconSwatch.dataset.icon;
        file.icon = icon === 'default' ? null : icon;
        await api.updateFile(file.id, { icon: file.icon });
        menu.querySelectorAll('.ctx-icon-swatch').forEach(s => s.classList.toggle('active', s.dataset.icon === icon));
        renderSidebar();
        return;
      }
      const colorSwatch = e.target.closest('.ctx-color');
      if (colorSwatch) {
        const color = colorSwatch.dataset.color;
        file.icon_color = color || null;
        await api.updateFile(file.id, { icon_color: file.icon_color });
        menu.querySelectorAll('.ctx-color').forEach(s => s.classList.toggle('active', s.dataset.color === color));
        renderSidebar();
        return;
      }
      const actionBtn = e.target.closest('[data-action]');
      const action = actionBtn?.dataset.action;
      if (action === 'pin') { await withLoading(actionBtn, () => togglePin(file.id, !file.is_pinned)); menu.remove(); return; }
      if (action === 'share') { menu.remove(); shareCurrentFile(file.id); return; }
      if (action === 'delete') { menu.remove(); deleteFile(file.id); return; }
    });

    const closeMenu = (e) => {
      if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', closeMenu); document.removeEventListener('contextmenu', closeMenu); }
    };
    setTimeout(() => { document.addEventListener('click', closeMenu); document.addEventListener('contextmenu', closeMenu); }, 0);
  }

  // Build color swatches
  let colorsHTML = '<div class="ctx-color ctx-none" data-color="" title="No color">✕</div>';
  FOLDER_COLORS.forEach(c => { colorsHTML += '<div class="ctx-color" data-color="' + c.value + '" style="background:' + c.value + '" title="' + c.name + '"></div>'; });
  ctxColors.innerHTML = colorsHTML;

  ctxColors.addEventListener('click', async (e) => {
    e.stopPropagation();
    const swatch = e.target.closest('.ctx-color');
    if (!swatch || !ctxFolderId) return;
    const color = swatch.dataset.color;
    await api.updateFolder(ctxFolderId, { color: color || null });
    const f = folders.find(x => x.id === ctxFolderId);
    if (f) f.color = color || null;
    ctxMenu.style.display = 'none';
    renderSidebar();
  });

  function startFolderRename(folder, header) {
    if (!header) header = fileList.querySelector(`[data-folder-id="${folder.id}"] .folder-header`);
    if (!header) return;
    const nameSpan = header.querySelector('.folder-name');
    if (!nameSpan) return;
    const input = document.createElement('input');
    input.className = 'folder-name-input';
    input.value = folder.name;
    nameSpan.replaceWith(input);
    input.addEventListener('mousedown', (e) => e.stopPropagation());
    input.addEventListener('click', (e) => e.stopPropagation());
    let done = false;
    const finish = async () => {
      if (done) return;
      done = true;
      await api.updateFolder(folder.id, { name: input.value.trim() || folder.name });
      folder.name = input.value.trim() || folder.name;
      renderSidebar();
    };
    input.addEventListener('blur', finish);
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') input.blur(); if (ev.key === 'Escape') { input.value = folder.name; input.blur(); } });
    setTimeout(() => { input.focus(); input.select(); }, 0);
  }

  $('#ctx-rename').addEventListener('click', () => {
    ctxMenu.style.display = 'none';
    if (!ctxFolderId) return;
    const folder = folders.find(f => f.id === ctxFolderId);
    if (!folder) return;
    startFolderRename(folder);
  });

  document.addEventListener('click', (e) => { if (!e.target.closest('.context-menu')) ctxMenu.style.display = 'none'; });
  document.addEventListener('contextmenu', (e) => {
    if (!e.target.closest('.folder-header')) { ctxMenu.style.display = 'none'; return; }
  });

  // Find results resizer
  (() => {
    const resizer = $('#find-results-resizer');
    let dragging = false, startY = 0, startH = 0;
    resizer.addEventListener('mousedown', (e) => { dragging = true; startY = e.clientY; startH = findResults.offsetHeight; document.body.style.cursor = 'ns-resize'; document.body.style.userSelect = 'none'; e.preventDefault(); });
    document.addEventListener('mousemove', (e) => { if (!dragging) return; findResults.style.height = Math.max(60, Math.min(window.innerHeight * 0.5, startH + (startY - e.clientY))) + 'px'; });
    document.addEventListener('mouseup', () => { if (!dragging) return; dragging = false; document.body.style.cursor = ''; document.body.style.userSelect = ''; });
  })();

  // ===== Stats =====
  function updateStats() {
    const text = cm.getValue();
    const lines = cm.lineCount();
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    $('#stat-lines').textContent = lines + ' lines';
    $('#stat-words').textContent = words + ' words';
    $('#stat-chars').textContent = text.length + ' chars';
  }

  function updateCursor() {
    const pos = cm.getCursor();
    $('#stat-cursor').textContent = 'Ln ' + (pos.line + 1) + ', Col ' + (pos.ch + 1);
  }

  // ===== Sidebar =====
  async function loadAll() { [files, folders] = await Promise.all([api.getFiles(), api.getFolders()]); renderSidebar(); }

  function renderSidebar() {
    fileList.innerHTML = '';
    const rootFolders = folders.filter(f => !f.parent_id).sort((a, b) => a.sort_order - b.sort_order);
    const rootFiles = files.filter(f => !f.folder_id).sort((a, b) => (b.is_pinned || 0) - (a.is_pinned || 0) || a.sort_order - b.sort_order);
    rootFolders.forEach(folder => fileList.appendChild(buildFolderEl(folder)));
    rootFiles.forEach(f => fileList.appendChild(buildFileEl(f)));
    fileList.addEventListener('dragover', (e) => { if (!dragItem) return; e.preventDefault(); });
    fileList.addEventListener('drop', async (e) => { e.preventDefault(); fileList.classList.remove('drag-over-root'); if (dragType === 'file' && dragItem) { await api.updateFile(dragItem, { folder_id: null }); await loadAll(); } });
  }

  function buildFolderEl(folder) {
    const childFolders = folders.filter(f => f.parent_id === folder.id).sort((a, b) => a.sort_order - b.sort_order);
    const childFiles = files.filter(f => f.folder_id === folder.id).sort((a, b) => a.sort_order - b.sort_order);
    const el = document.createElement('div'); el.className = 'folder-item'; el.dataset.folderId = folder.id;
    const header = document.createElement('div'); header.className = 'folder-header'; header.draggable = true;
    const folderColor = folder.color || '';
    const iconFill = folderColor || 'none';
    const iconStroke = folderColor || 'currentColor';
    header.innerHTML = `<svg class="folder-chevron ${folder.collapsed ? 'collapsed' : ''}" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg><svg class="folder-icon" width="14" height="14" viewBox="0 0 24 24" fill="${iconFill}" stroke="${iconStroke}" stroke-width="2" style="${folderColor ? 'opacity:0.9' : ''}"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg><span class="folder-name">${escapeHtml(folder.name)}</span><div class="folder-actions"><button data-action="add-file" title="New file here"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg></button><button class="btn-delete-folder" data-action="delete-folder" title="Delete folder"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg></button></div>`;
    // Right-click for color picker
    header.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      ctxFolderId = folder.id;
      ctxMenu.style.display = '';
      ctxMenu.style.left = Math.min(e.clientX, window.innerWidth - 160) + 'px';
      ctxMenu.style.top = Math.min(e.clientY, window.innerHeight - 100) + 'px';
      ctxMenu.querySelectorAll('.ctx-color').forEach(s => s.classList.toggle('active', s.dataset.color === (folder.color || '')));
    });
    header.addEventListener('click', async (e) => {
      if (header.querySelector('.folder-name-input')) return;
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action === 'delete-folder') { e.stopPropagation(); if (confirm('Delete folder "' + folder.name + '"?')) { await api.deleteFolder(folder.id); await loadAll(); } return; }
      if (action === 'add-file') { e.stopPropagation(); const file = await api.createFile('Untitled', '', folder.id); await loadAll(); await switchFile(file.id); fileNameInput.focus(); fileNameInput.select(); return; }
      folder.collapsed = !folder.collapsed; await api.updateFolder(folder.id, { collapsed: !folder.collapsed }); renderSidebar();
    });
    header.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      startFolderRename(folder, header);
    });
    header.addEventListener('dragstart', (e) => { dragItem = folder.id; dragType = 'folder'; header.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
    header.addEventListener('dragend', () => { header.classList.remove('dragging'); dragItem = null; dragType = null; });
    header.addEventListener('dragover', (e) => { if (!dragItem || (dragType === 'folder' && dragItem === folder.id)) return; e.preventDefault(); header.classList.add('drag-over'); });
    header.addEventListener('dragleave', () => header.classList.remove('drag-over'));
    header.addEventListener('drop', async (e) => { e.preventDefault(); e.stopPropagation(); header.classList.remove('drag-over'); if (dragType === 'file') { await api.updateFile(dragItem, { folder_id: folder.id }); await loadAll(); } else if (dragType === 'folder' && dragItem !== folder.id) { await api.updateFolder(dragItem, { parent_id: folder.id }); await loadAll(); } });
    el.appendChild(header);
    const children = document.createElement('div'); children.className = 'folder-children' + (folder.collapsed ? ' hidden' : '');
    childFolders.forEach(cf => children.appendChild(buildFolderEl(cf)));
    childFiles.forEach(f => children.appendChild(buildFileEl(f)));
    el.appendChild(children); return el;
  }

  function buildFileEl(f) {
    const el = document.createElement('div'); el.className = 'file-item' + (f.id === activeFileId ? ' active' : ''); el.draggable = true; el.dataset.fileId = f.id;
    const lockHTML = f.is_shared ? '' : '<span class="file-item-lock" title="Private - not shared"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg></span>';
    const pinHTML = f.is_pinned ? '<span class="file-item-pin pinned" title="Pinned"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg></span>' : '';
    el.innerHTML = `${fileIconHTML(f)}<span class="file-item-name">${escapeHtml(f.name || 'Untitled')}</span>${lockHTML}${pinHTML}`;
    el.addEventListener('click', () => switchFile(f.id));
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); showFileContextMenu(f, e.clientX, e.clientY); });
    el.addEventListener('dragstart', (e) => { dragItem = f.id; dragType = 'file'; el.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
    el.addEventListener('dragend', () => { el.classList.remove('dragging'); dragItem = null; dragType = null; });
    el.addEventListener('dragover', (e) => { if (!dragItem || dragType !== 'file' || dragItem === f.id) return; e.preventDefault(); el.classList.add('drag-over'); });
    el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
    el.addEventListener('drop', async (e) => { e.preventDefault(); e.stopPropagation(); el.classList.remove('drag-over'); if (dragType === 'file' && dragItem !== f.id) { await api.updateFile(dragItem, { folder_id: f.folder_id || null, sort_order: f.sort_order }); await loadAll(); } });
    return el;
  }

  function getDragAfterElement(container, y) {
    const items = [...container.querySelectorAll('.file-item:not(.dragging), .folder-item:not(.dragging)')];
    return items.reduce((c, child) => { const box = child.getBoundingClientRect(); const offset = y - box.top - box.height / 2; if (offset < 0 && offset > c.offset) return { offset, element: child }; return c; }, { offset: Number.NEGATIVE_INFINITY }).element;
  }

  // ===== File management =====
  // fileId -> { name, content, updated_at } for files already opened this
  // session, so switching back to one is instant instead of a fresh fetch.
  const fileCache = new Map();

  async function switchFile(id, forceRefresh) {
    if (id === activeFileId && cm.getValue() && !forceRefresh) return; // already open, nothing to fetch

    // Flush any not-yet-saved edit on the file we're leaving *before*
    // touching activeFileId or cm's buffer - otherwise a pending debounce
    // fires later against the wrong (new) file id, or reads content that's
    // already been replaced, silently dropping the edit.
    await flushPendingSave();

    // Instant feedback: highlight the clicked row before anything else, so a
    // click never looks like it did nothing.
    const prevActiveEl = fileList.querySelector('.file-item.active');
    if (prevActiveEl) prevActiveEl.classList.remove('active');
    const rowEl = fileList.querySelector('.file-item[data-file-id="' + id + '"]');
    if (rowEl) rowEl.classList.add('active');

    activeFileId = id;
    localStorage.setItem('md-active-file', id);

    const cached = !forceRefresh && fileCache.get(id);
    if (cached) {
      // No network wait for a file we've already opened this session -
      // apply it immediately, then quietly check in the background whether
      // it's still current (surfaces via the existing stale-file banner).
      cm.setValue(cached.content);
      fileNameInput.value = cached.name;
      hideStaleBanner();
      renderSidebar(); render(); showSaveStatus('Loaded');
      revalidateFileCache(id);
      return;
    }

    if (rowEl) rowEl.querySelector('.file-item-icon')?.classList.add('spinner-icon');
    showSaveStatus('Loading...');
    const file = await api.getFile(id);
    fileCache.set(id, { name: file.name, content: file.content, updated_at: file.updated_at });
    cm.setValue(file.content);
    fileNameInput.value = file.name;
    hideStaleBanner();
    renderSidebar(); render(); showSaveStatus('Loaded');
  }

  async function revalidateFileCache(id) {
    if (id === activeFileId && staleBannerShown) return; // Reload will fetch fresh anyway
    try {
      const file = await api.getFile(id);
      const cached = fileCache.get(id);
      if (!cached || file.updated_at === cached.updated_at) return;
      fileCache.set(id, { name: file.name, content: file.content, updated_at: file.updated_at });
      // Only the file you're actually looking at is a real conflict - one you
      // haven't opened just gets its cache refreshed silently, so clicking
      // into it later shows the new content with nothing to reload.
      if (id === activeFileId) showStaleBanner();
    } catch (e) {}
  }

  // ===== Stale-file detection (edited elsewhere: another tab, or the API) =====
  function showStaleBanner() {
    staleBannerShown = true;
    $('#stale-banner').classList.add('show');
  }
  function hideStaleBanner() {
    staleBannerShown = false;
    $('#stale-banner').classList.remove('show');
  }
  function startStaleCheck() {
    setInterval(async () => {
      if (document.hidden || isSharedView) return;
      // Sweep every file opened this session, not just the active one, so a
      // file changed elsewhere while you're not looking at it gets its cache
      // refreshed silently - open it later and it's already current, no
      // reload needed. The banner only fires for the file you're on right
      // now, since that's the only case where someone else's change and
      // yours could actually collide.
      await Promise.all([...fileCache.keys()].map((id) => revalidateFileCache(id)));
    }, 8000);
  }

  async function createNewFile(folderId, name, content) {
    const file = await api.createFile(name || 'Untitled', content || '', folderId || null);
    await loadAll(); await switchFile(file.id); fileNameInput.focus(); fileNameInput.select();
  }

  function showNewFileMenu() {
    const btn = $('#btn-new-file');
    const existing = $('#new-file-menu');
    if (existing) { existing.remove(); return; }

    const rect = btn.getBoundingClientRect();
    const menu = document.createElement('div');
    menu.id = 'new-file-menu';
    menu.className = 'context-menu';
    menu.style.display = 'block';
    menu.style.top = (rect.bottom + 6) + 'px';
    menu.style.left = rect.left + 'px';
    menu.innerHTML =
      '<button class="context-menu-item" data-action="blank">' +
        '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z"/><path d="M13 2v7h7"/></svg>' +
        'Blank file</button>' +
      '<div class="context-menu-divider"></div>' +
      '<div class="context-menu-label">Templates</div>' +
      '<div class="ctx-templates-slot" style="padding:6px 8px;color:var(--text-3);font-size:12px">Loading...</div>' +
      '<div class="context-menu-divider"></div>' +
      '<button class="context-menu-item" data-action="manage">' +
        '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>' +
        'Manage templates…</button>';
    document.body.appendChild(menu);

    let templates = [];
    api.getTemplates().then(list => {
      templates = list;
      const slot = menu.querySelector('.ctx-templates-slot');
      if (!slot) return; // menu already closed
      if (!list.length) { slot.textContent = 'No templates yet'; return; }
      slot.outerHTML = list.map(t =>
        '<div class="context-menu-item" data-action="use" data-id="' + t.id + '">' +
          '<span class="file-template-name">' + escapeHtml(t.name) + '</span>' +
        '</div>'
      ).join('');
    });

    menu.addEventListener('click', async (e) => {
      const item = e.target.closest('[data-action]');
      if (!item) return;
      menu.remove();
      if (item.dataset.action === 'blank') {
        await createNewFile();
      } else if (item.dataset.action === 'manage') {
        openTemplateManager();
      } else if (item.dataset.action === 'use') {
        const t = templates.find(x => x.id === item.dataset.id);
        if (t) await createNewFile(null, t.name, t.content);
      }
    });

    const closeMenu = (e) => {
      if (!menu.contains(e.target) && e.target !== btn) { menu.remove(); document.removeEventListener('click', closeMenu); }
    };
    setTimeout(() => document.addEventListener('click', closeMenu), 0);
  }

  // ===== API Keys manager =====
  async function openApiKeysManager() {
    const keys = await api.getApiKeys();
    renderApiKeysManager(keys);
    modalOverlay.classList.add('show');
  }

  function formatApiKeyDate(iso) {
    if (!iso) return 'Never used';
    const d = new Date(iso);
    return 'Last used ' + d.toLocaleDateString();
  }

  function renderApiKeysManager(keys) {
    modalTitle.textContent = 'API Keys';
    const listHTML = keys.length
      ? '<div class="template-list" style="max-height:260px;overflow-y:auto;margin-bottom:12px">' +
        keys.map(k =>
          '<div class="file-item" style="cursor:default">' +
            '<svg class="file-item-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="8" cy="8" r="5"/><line x1="11.5" y1="11.5" x2="21" y2="21"/><line x1="15" y1="15" x2="18" y2="12"/><line x1="18" y1="18" x2="21" y2="15"/></svg>' +
            '<span class="file-item-name" title="' + escapeHtml(k.name) + '">' + escapeHtml(k.name) +
              '<span style="color:var(--text-3);font-weight:400;margin-left:6px;font-family:var(--font-mono,monospace);font-size:11px">' + escapeHtml(k.key_prefix) + '…</span>' +
              '<span style="color:var(--text-3);font-weight:400;margin-left:6px;font-size:11px">' + formatApiKeyDate(k.last_used_at) + '</span>' +
            '</span>' +
            '<div class="file-item-actions" style="opacity:1">' +
              '<button data-action="revoke" data-id="' + k.id + '" title="Revoke"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg></button>' +
            '</div>' +
          '</div>'
        ).join('') +
        '</div>'
      : '<p style="color:var(--text-3);font-size:13px;text-align:center;padding:16px 0">No API keys yet.</p>';

    modalBody.innerHTML = listHTML +
      '<div style="display:flex;gap:8px;margin-bottom:8px">' +
        '<input type="text" id="apikey-name-input" class="file-name-input" placeholder="Key name (e.g. Zapier)" style="flex:1">' +
        '<button class="btn-new-file" id="apikey-create-btn" style="margin:0;width:auto">Create</button>' +
      '</div>' +
      '<p class="share-info">Full read/write access to files, folders, and templates. <a href="/docs.html" target="_blank" rel="noopener noreferrer">View API docs</a></p>';

    modalBody.querySelectorAll('[data-action="revoke"]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const k = keys.find(x => x.id === btn.dataset.id);
        if (!confirm('Revoke API key "' + (k?.name || '') + '"? Any integration using it will stop working.')) return;
        await withLoading(e.currentTarget, () => api.deleteApiKey(btn.dataset.id));
        renderApiKeysManager(await api.getApiKeys());
      });
    });

    $('#apikey-create-btn').addEventListener('click', async (e) => {
      const name = $('#apikey-name-input').value.trim() || 'API Key';
      const created = await withLoading(e.currentTarget, () => api.createApiKey(name));
      showCreatedApiKey(created);
    });
    $('#apikey-name-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#apikey-create-btn').click(); });
  }

  function showCreatedApiKey(created) {
    modalTitle.textContent = 'API key created';
    modalBody.innerHTML =
      '<p style="font-size:13px;color:var(--text-2);margin-bottom:10px">Copy this key now - it won\'t be shown again.</p>' +
      '<div class="share-url-box" style="margin-bottom:16px">' +
        '<input type="text" id="apikey-raw-value" value="' + escapeHtml(created.raw_key) + '" readonly style="font-family:var(--font-mono,monospace);font-size:12px">' +
        '<button id="apikey-copy-btn">Copy</button>' +
      '</div>' +
      '<button class="btn-new-file" id="apikey-done-btn" style="margin:0;width:100%">Done</button>';
    $('#apikey-copy-btn').addEventListener('click', () => {
      navigator.clipboard.writeText(created.raw_key).then(() => { $('#apikey-copy-btn').textContent = 'Copied!'; setTimeout(() => { $('#apikey-copy-btn').textContent = 'Copy'; }, 2000); });
    });
    $('#apikey-done-btn').addEventListener('click', async () => renderApiKeysManager(await api.getApiKeys()));
  }

  // ===== Template manager =====
  async function openTemplateManager() {
    const templates = await api.getTemplates();
    renderTemplateManager(templates);
    modalOverlay.classList.add('show');
  }

  function renderTemplateManager(templates) {
    modalTitle.textContent = 'Manage templates';
    if (!templates.length) {
      modalBody.innerHTML = '<p style="color:var(--text-3);font-size:13px;text-align:center;padding:24px 0">No templates yet. Use "Save as template" from the toolbar to create one.</p>';
      return;
    }
    modalBody.innerHTML = '<div class="template-list" style="max-height:340px;overflow-y:auto">' +
      templates.map(t =>
        '<div class="file-item" draggable="true" data-id="' + t.id + '">' +
          '<svg class="file-item-icon" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="8" cy="6" r="1.5"/><circle cx="16" cy="6" r="1.5"/><circle cx="8" cy="12" r="1.5"/><circle cx="16" cy="12" r="1.5"/><circle cx="8" cy="18" r="1.5"/><circle cx="16" cy="18" r="1.5"/></svg>' +
          '<span class="file-item-name">' + escapeHtml(t.name) + '</span>' +
          '<div class="file-item-actions">' +
            '<button data-action="rename" data-id="' + t.id + '" title="Rename"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>' +
            '<button data-action="edit" data-id="' + t.id + '" title="Edit content"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 18l6-6-6-6M8 6l-6 6 6 6"/></svg></button>' +
            '<button data-action="delete" data-id="' + t.id + '" title="Delete"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0l-1 14a2 2 0 01-2 2H7a2 2 0 01-2-2L4 6"/></svg></button>' +
          '</div>' +
        '</div>'
      ).join('') +
      '</div>';

    const list = modalBody.querySelector('.template-list');
    let dragId = null;
    list.querySelectorAll('.file-item').forEach(row => {
      row.addEventListener('dragstart', () => { dragId = row.dataset.id; row.style.opacity = '0.4'; });
      row.addEventListener('dragend', () => { row.style.opacity = ''; });
      row.addEventListener('dragover', (e) => e.preventDefault());
      row.addEventListener('drop', async (e) => {
        e.preventDefault();
        if (!dragId || dragId === row.dataset.id) return;
        const from = templates.findIndex(t => t.id === dragId);
        const to = templates.findIndex(t => t.id === row.dataset.id);
        if (from < 0 || to < 0) return;
        const [moved] = templates.splice(from, 1);
        templates.splice(to, 0, moved);
        await Promise.all(templates.map((t, i) => api.updateTemplate(t.id, { sort_order: i })));
        renderTemplateManager(templates);
      });
    });

    modalBody.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        const t = templates.find(x => x.id === id);
        if (!t) return;
        if (btn.dataset.action === 'delete') {
          if (!confirm('Delete template "' + t.name + '"?')) return;
          await withLoading(btn, () => api.deleteTemplate(id));
          renderTemplateManager(templates.filter(x => x.id !== id));
        } else if (btn.dataset.action === 'rename') {
          const nameEl = btn.closest('.file-item').querySelector('.file-item-name');
          const input = document.createElement('input');
          input.type = 'text'; input.value = t.name; input.className = 'file-name-input'; input.style.flex = '1';
          nameEl.replaceWith(input);
          input.focus(); input.select();
          const commit = async () => {
            const newName = input.value.trim() || t.name;
            t.name = newName;
            await api.updateTemplate(id, { name: newName });
            renderTemplateManager(templates);
          };
          input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') input.blur(); if (ev.key === 'Escape') { input.value = t.name; input.blur(); } });
          input.addEventListener('blur', commit, { once: true });
        } else if (btn.dataset.action === 'edit') {
          modalTitle.textContent = 'Edit template - ' + t.name;
          modalBody.innerHTML =
            '<textarea id="template-content-input" spellcheck="false" style="width:100%;min-height:280px;padding:10px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--text);font-family:var(--font-mono, monospace);font-size:12.5px;resize:vertical">' + escapeHtml(t.content) + '</textarea>' +
            '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">' +
              '<button class="btn-new-folder" id="template-edit-back" style="margin:0;width:auto">Back</button>' +
              '<button class="btn-new-file" id="template-edit-save" style="margin:0;width:auto">Save</button>' +
            '</div>';
          $('#template-edit-back').addEventListener('click', () => renderTemplateManager(templates));
          $('#template-edit-save').addEventListener('click', async (e) => {
            const content = $('#template-content-input').value;
            t.content = content;
            await withLoading(e.currentTarget, () => api.updateTemplate(id, { content }));
            renderTemplateManager(templates);
          });
        }
      });
    });
  }

  async function deleteFile(id) {
    if (files.length <= 1) { showToast('Cannot delete the last file'); return; }
    const f = files.find(x => x.id === id);
    if (!confirm('Delete "' + (f?.name || 'Untitled') + '"?')) return;
    await api.deleteFile(id); files = files.filter(x => x.id !== id);
    fileCache.delete(id);
    if (id === activeFileId) await switchFile(files[0].id);
    renderSidebar(); showToast('File deleted');
  }

  async function togglePin(id, pinned) { await api.updateFile(id, { is_pinned: pinned }); await loadAll(); }
  async function createNewFolder() {
    const folder = await api.createFolder('New Folder');
    await loadAll();
    startFolderRename(folders.find(f => f.id === folder.id) || folder);
  }

  // ===== Auto-save =====
  // Pending edits are captured (file id + value) at schedule time, not read
  // lazily when the timer fires - if the user switches files before the
  // debounce elapses, activeFileId and cm's buffer have both already moved
  // on to the new file, so reading them late would silently drop the edit
  // (or worse, save the new file's content over itself under the old id).
  let pendingSaveFileId = null;
  let pendingContent = null;
  let pendingName = null;

  function scheduleSave() {
    if (!activeFileId) return;
    clearTimeout(saveTimer); showSaveStatus('Saving...');
    pendingSaveFileId = activeFileId;
    pendingContent = cm.getValue();
    saveTimer = setTimeout(flushPendingSave, 500);
  }

  async function flushPendingSave() {
    clearTimeout(saveTimer); saveTimer = null;
    if (!pendingSaveFileId) return;
    const id = pendingSaveFileId;
    const patch = {};
    if (pendingContent !== null) patch.content = pendingContent;
    if (pendingName !== null) patch.name = pendingName;
    pendingSaveFileId = null; pendingContent = null; pendingName = null;
    if (!Object.keys(patch).length) return;

    const updated = await api.updateFile(id, patch);
    if (updated?.updated_at) {
      const cached = fileCache.get(id);
      fileCache.set(id, {
        name: patch.name !== undefined ? patch.name : (cached?.name ?? updated.name),
        content: patch.content !== undefined ? patch.content : (cached?.content ?? updated.content),
        updated_at: updated.updated_at
      });
    }
    if (patch.name !== undefined) { const f = files.find(x => x.id === id); if (f) { f.name = patch.name; renderSidebar(); } }
    showSaveStatus('Saved');
  }
  function showSaveStatus(text) {
    const el = $('#stat-save');
    if (el) { el.textContent = text; if (text === 'Saved') setTimeout(() => { if (el.textContent === 'Saved') el.textContent = ''; }, 2000); }
  }

  // ===== Image upload =====
  function setupImageUpload() {
    const fileInput = $('#image-upload');
    $('#btn-image').addEventListener('click', () => {
      modalTitle.textContent = 'Insert Image';
      modalBody.innerHTML = `<div style="display:flex;flex-direction:column;gap:12px"><button class="btn-new-file" id="btn-upload-file" style="margin:0"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg> Upload from computer</button><div style="text-align:center;color:var(--text-3);font-size:12px">or</div><div class="share-url-box"><input type="text" id="image-url-input" placeholder="Paste image URL..." style="font-family:var(--font-sans)"><button id="btn-insert-url">Insert</button></div></div>`;
      modalOverlay.classList.add('show');
      $('#btn-upload-file').addEventListener('click', () => fileInput.click());
      $('#btn-insert-url').addEventListener('click', () => { const url = $('#image-url-input').value.trim(); if (url) { insertText('\n![image](' + url + ')\n'); modalOverlay.classList.remove('show'); } });
      $('#image-url-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-insert-url').click(); });
    });
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files[0]; if (!file) return;
      const allowedTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
      if (!allowedTypes.includes(file.type)) { showToast('Only PNG, JPG, GIF, WebP allowed'); return; }
      if (file.size > 5 * 1024 * 1024) { showToast('Image too large (max 5MB)'); return; }
      showToast('Uploading...');
      const reader = new FileReader();
      reader.onload = async () => { try { const { url } = await api.uploadImage(reader.result, file.name); insertText('\n![' + file.name + '](' + url + ')\n'); modalOverlay.classList.remove('show'); showToast('Image uploaded'); } catch (e) { showToast('Upload failed'); } };
      reader.readAsDataURL(file); fileInput.value = '';
    });
    cm.on('paste', (cmInst, e) => {
      const items = e.clipboardData?.items; if (!items) return;
      for (const item of items) {
        if (item.type.startsWith('image/')) { e.preventDefault();
          const file = item.getAsFile(); showToast('Uploading pasted image...');
          const reader = new FileReader();
          reader.onload = async () => { try { const { url } = await api.uploadImage(reader.result, 'pasted-image'); insertText('![image](' + url + ')'); showToast('Image uploaded'); } catch (err) { showToast('Upload failed'); } };
          reader.readAsDataURL(file); break;
        }
      }
    });
  }

  // ===== Sync scroll =====
  let programmaticScroll = false, activeScroller = null, scrollLockTimer = null;

  function syncPreviewToEditor() {
    if (!$('#toggle-sync').checked) return;
    const info = cm.getScrollInfo();
    const maxEd = info.height - info.clientHeight;
    const maxPr = preview.scrollHeight - preview.clientHeight;
    if (maxEd <= 0 || maxPr <= 0) return;
    programmaticScroll = true;
    preview.scrollTop = (info.top / maxEd) * maxPr;
    requestAnimationFrame(() => { programmaticScroll = false; });
  }

  function setupSyncScroll() {
    cm.on('scroll', () => {
      if (!$('#toggle-sync').checked || isRendering) return;
      if (activeScroller === 'preview') return;
      activeScroller = 'editor'; clearTimeout(scrollLockTimer);
      syncPreviewToEditor();
      scrollLockTimer = setTimeout(() => { activeScroller = null; }, 100);
    });
    preview.addEventListener('scroll', () => {
      if (!$('#toggle-sync').checked || programmaticScroll || isRendering) return;
      if (activeScroller === 'editor') return;
      activeScroller = 'preview'; clearTimeout(scrollLockTimer);
      const maxPr = preview.scrollHeight - preview.clientHeight;
      const info = cm.getScrollInfo();
      const maxEd = info.height - info.clientHeight;
      if (maxPr > 0 && maxEd > 0) { programmaticScroll = true; cm.scrollTo(null, (preview.scrollTop / maxPr) * maxEd); requestAnimationFrame(() => { programmaticScroll = false; }); }
      scrollLockTimer = setTimeout(() => { activeScroller = null; }, 100);
    });
  }

  // ===== Divider drag =====
  function setupDivider() {
    const divider = $('#divider'), container = $('.editor-container'), editorPane = $('#editor-pane'), previewPane = $('#preview-pane');
    let dragging = false;
    divider.addEventListener('mousedown', (e) => { dragging = true; divider.classList.add('dragging'); document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'; e.preventDefault(); });
    document.addEventListener('mousemove', (e) => { if (!dragging) return; const rect = container.getBoundingClientRect(); const pct = Math.max(20, Math.min(80, ((e.clientX - rect.left) / rect.width) * 100)); editorPane.style.flex = 'none'; previewPane.style.flex = 'none'; editorPane.style.width = pct + '%'; previewPane.style.width = (100 - pct) + '%'; cm.refresh(); });
    document.addEventListener('mouseup', () => { if (!dragging) return; dragging = false; divider.classList.remove('dragging'); document.body.style.cursor = ''; document.body.style.userSelect = ''; cm.refresh(); });
  }

  // ===== Dark mode =====
  function applyDark(dark) {
    document.body.classList.toggle('dark', dark);
    $('#toggle-dark').checked = dark;
    localStorage.setItem('md-dark', dark ? '1' : '0');
    cm.setOption('theme', dark ? 'dark' : 'default');
    $('#hljs-light').disabled = dark;
    $('#hljs-dark').disabled = !dark;
    initMermaid();
    mermaidCache.clear(); // cached SVGs have the old theme's colors baked in
    if (cm.getValue()) render();
  }

  // ===== Share =====
  async function shareCurrentFile(fileId) {
    const fid = fileId || activeFileId;
    if (!fid) return;

    const file = await api.getFile(fid);
    const hasPublic = !!file.share_id;
    const hasPrivate = !!(file.private_view_token || file.private_edit_token);

    modalTitle.textContent = 'Share';
    modalBody.innerHTML = `
      <div class="share-section">
        <div class="share-label">Public (anyone can view & fork)</div>
        <div id="pub-area">
          ${hasPublic
            ? '<div class="share-url-box"><input type="text" value="' + location.origin + '/s/' + file.share_id + '" readonly><button id="copy-pub">Copy</button><button id="revoke-pub" class="share-revoke-btn" title="Revoke">Revoke</button></div>'
            : '<button class="btn-new-folder" id="btn-gen-public" style="margin:0;width:auto">Generate public link</button>'
          }
        </div>
      </div>
      <hr style="border:none;border-top:1px solid var(--border);margin:14px 0">
      <div class="share-section">
        <div class="share-label">Private read-only (password protected)</div>
        ${hasPrivate && file.private_view_token
          ? '<div id="priv-view-area"><div class="share-url-box"><input type="text" value="' + location.origin + '/p/' + file.private_view_token + '" readonly><button data-url="' + location.origin + '/p/' + file.private_view_token + '">Copy</button><button id="revoke-view" class="share-revoke-btn" title="Revoke">Revoke</button></div></div>'
          : '<div id="priv-view-area"><div class="share-url-box" style="margin-bottom:6px"><input type="password" id="share-view-pw" placeholder="Set password for view link..."></div></div>'
        }
      </div>
      <div class="share-section">
        <div class="share-label">Private edit (password protected)</div>
        ${hasPrivate && file.private_edit_token
          ? '<div id="priv-edit-area"><div class="share-url-box"><input type="text" value="' + location.origin + '/e/' + file.private_edit_token + '" readonly><button data-url="' + location.origin + '/e/' + file.private_edit_token + '">Copy</button><button id="revoke-edit" class="share-revoke-btn" title="Revoke">Revoke</button></div></div>'
          : '<div id="priv-edit-area"><div class="share-url-box" style="margin-bottom:6px"><input type="password" id="share-edit-pw" placeholder="Set password for edit link..."></div></div>'
        }
      </div>
      ${(!hasPrivate || !file.private_view_token || !file.private_edit_token) ? '<button class="btn-new-file" id="btn-gen-private" style="margin:8px 0 0">Generate private links</button>' : ''}
      <div id="private-links-result"></div>
      <p class="share-info">Private links require a password. Share link + password separately.</p>
    `;
    modalOverlay.classList.add('show');

    // Copy buttons
    modalBody.querySelectorAll('[data-url]').forEach(btn => {
      btn.addEventListener('click', () => {
        navigator.clipboard.writeText(btn.dataset.url).then(() => { btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = 'Copy'; }, 2000); });
      });
    });

    if ($('#copy-pub')) {
      $('#copy-pub').addEventListener('click', () => {
        const url = location.origin + '/s/' + file.share_id;
        navigator.clipboard.writeText(url).then(() => { $('#copy-pub').textContent = 'Copied!'; setTimeout(() => { $('#copy-pub').textContent = 'Copy'; }, 2000); });
      });
    }

    // Generate public
    if ($('#btn-gen-public')) {
      $('#btn-gen-public').addEventListener('click', async (e) => {
        await withLoading(e.currentTarget, () => api.shareFile(fid));
        showToast('Public link created');
        await loadAll();
        shareCurrentFile(fid);
      });
    }

    // Revoke public
    if ($('#revoke-pub')) {
      $('#revoke-pub').addEventListener('click', async (e) => {
        if (!confirm('Revoke public link? Anyone with the link will lose access.')) return;
        await withLoading(e.currentTarget, () => fetch('/api/files/' + fid + '/share', { method: 'DELETE' }));
        showToast('Public link revoked');
        await loadAll();
        shareCurrentFile(fid);
      });
    }

    // Revoke private view
    if ($('#revoke-view')) {
      $('#revoke-view').addEventListener('click', async (e) => {
        if (!confirm('Revoke private view link?')) return;
        await withLoading(e.currentTarget, () => fetch('/api/files/' + fid + '/share-private', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'view' }) }));
        showToast('View link revoked');
        await loadAll();
        shareCurrentFile(fid);
      });
    }

    // Revoke private edit
    if ($('#revoke-edit')) {
      $('#revoke-edit').addEventListener('click', async (e) => {
        if (!confirm('Revoke private edit link?')) return;
        await withLoading(e.currentTarget, () => fetch('/api/files/' + fid + '/share-private', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'edit' }) }));
        showToast('Edit link revoked');
        await loadAll();
        shareCurrentFile(fid);
      });
    }

    // Generate private
    if ($('#btn-gen-private')) {
      $('#btn-gen-private').addEventListener('click', async (e) => {
        const viewPw = $('#share-view-pw')?.value;
        const editPw = $('#share-edit-pw')?.value;
        if (!viewPw && !editPw) { showToast('Enter at least one password'); return; }
        await withLoading(e.currentTarget, () => fetch('/api/files/' + fid + '/share-private', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ view_password: viewPw, edit_password: editPw })
        }));
        showToast('Private links generated');
        await loadAll();
        shareCurrentFile(fid);
      });
    }
  }

  // ===== Shared/Private view =====
  let privateEditToken = null;
  let privateEditPassword = null;
  let privateEditSaveTimer = null;

  async function checkSharedView() {
    const p = location.pathname;

    // Public: /s/{id}
    const pubMatch = p.match(/^\/s\/(.+)$/);
    if (pubMatch) {
      const file = await api.getShared(pubMatch[1]);
      if (!file) { showToast('Shared file not found'); return false; }
      setupSharedBanner('public', file);
      return true;
    }

    // Private view: /p/{token}
    const viewMatch = p.match(/^\/p\/(.+)$/);
    if (viewMatch) {
      return await handlePrivateAccess(viewMatch[1], 'view');
    }

    // Private edit: /e/{token}
    const editMatch = p.match(/^\/e\/(.+)$/);
    if (editMatch) {
      return await handlePrivateAccess(editMatch[1], 'edit');
    }

    return false;
  }

  async function handlePrivateAccess(token, mode) {
    const endpoint = mode === 'edit' ? '/api/private-edit/' : '/api/private/';
    const checkRes = await fetch(endpoint + token + '/check');
    if (!checkRes.ok) { showToast('Link not found or revoked'); return false; }
    const checkData = await checkRes.json();

    if (checkData.needs_password) {
      return new Promise(resolve => {
        showPasswordPrompt(checkData.name || 'Private document', async (password) => {
          const authRes = await fetch(endpoint + token + '/auth', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password })
          });
          if (!authRes.ok) { showToast('Wrong password'); resolve(await handlePrivateAccess(token, mode)); return; }
          const file = await authRes.json();
          if (mode === 'edit') { privateEditToken = token; privateEditPassword = password; }
          setupSharedBanner(mode === 'edit' ? 'private-edit' : 'private-view', file);
          resolve(true);
        });
      });
    } else {
      const authRes = await fetch(endpoint + token + '/auth', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: '' })
      });
      const file = await authRes.json();
      if (mode === 'edit') { privateEditToken = token; privateEditPassword = ''; }
      setupSharedBanner(mode === 'edit' ? 'private-edit' : 'private-view', file);
      return true;
    }
  }

  function showPasswordPrompt(docName, onSubmit) {
    modalTitle.textContent = 'Password required';
    modalBody.innerHTML = `
      <p style="margin-bottom:12px;color:var(--text-2);font-size:13px">"${escapeHtml(docName)}" is password protected.</p>
      <div class="share-url-box">
        <input type="password" id="pw-prompt-input" placeholder="Enter password..." autofocus>
        <button id="pw-prompt-submit">Unlock</button>
      </div>
    `;
    modalOverlay.classList.add('show');
    const input = $('#pw-prompt-input');
    const submit = () => { modalOverlay.classList.remove('show'); onSubmit(input.value); };
    $('#pw-prompt-submit').addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    input.focus();
  }

  function setupSharedBanner(mode, file) {
    isSharedView = true;
    cm.setValue(file.content);
    fileNameInput.value = file.name;

    const banner = $('#shared-banner');
    const bannerText = banner.querySelector('span');
    const forkBtn = $('#btn-fork');

    if (mode === 'private-edit') {
      cm.setOption('readOnly', false);
      fileNameInput.readOnly = false;
      bannerText.textContent = 'Private edit mode - changes are saved';
      forkBtn.style.display = 'none';

      cm.on('changes', () => {
        clearTimeout(privateEditSaveTimer);
        privateEditSaveTimer = setTimeout(async () => {
          await fetch('/api/private-edit/' + privateEditToken, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: privateEditPassword, content: cm.getValue() })
          });
          showSaveStatus('Saved');
        }, 500);
      });

      fileNameInput.addEventListener('input', () => {
        clearTimeout(privateEditSaveTimer);
        privateEditSaveTimer = setTimeout(async () => {
          await fetch('/api/private-edit/' + privateEditToken, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: privateEditPassword, name: fileNameInput.value })
          });
          showSaveStatus('Saved');
        }, 400);
      });
    } else {
      cm.setOption('readOnly', true);
      fileNameInput.readOnly = true;
      bannerText.textContent = mode === 'private-view'
        ? 'Private read-only view'
        : 'Public shared document';
      forkBtn.addEventListener('click', async () => {
        const match = location.pathname.match(/^\/s\/(.+)$/);
        if (match) { await api.forkShared(match[1]); location.href = '/'; }
        else { showToast('Fork is only available for public shares'); }
      });
    }

    render();
    banner.style.display = 'block';
    $('.main').style.marginTop = '38px';
    sidebar.classList.add('collapsed');
    $('#btn-open-sidebar').style.display = 'none';
    $('#btn-close-banner').addEventListener('click', () => { banner.style.display = 'none'; $('.main').style.marginTop = '0'; });
  }

  // ===== Toolbar insert helpers =====
  function insertText(text) { cm.replaceSelection(text); cm.focus(); scheduleRender(); scheduleSave(); }
  function buildMarkdownTable(cols, rows) {
    cols = Math.max(1, Math.min(20, cols || 2));
    rows = Math.max(1, Math.min(50, rows || 1));
    const header = '| ' + Array.from({ length: cols }, (_, i) => 'Column ' + (i + 1)).join(' | ') + ' |';
    const divider = '| ' + Array.from({ length: cols }, () => '--------').join(' | ') + ' |';
    const bodyRows = Array.from({ length: rows }, (_, r) =>
      '| ' + Array.from({ length: cols }, (_, c) => 'Cell ' + (r + 1) + '.' + (c + 1)).join(' | ') + ' |'
    );
    return '\n' + [header, divider, ...bodyRows].join('\n') + '\n';
  }
  function insertAround(before, after) {
    const sel = cm.getSelection() || 'text';
    cm.replaceSelection(before + sel + after);
    if (sel === 'text') { const cur = cm.getCursor(); cm.setSelection({ line: cur.line, ch: cur.ch - after.length - sel.length }, { line: cur.line, ch: cur.ch - after.length }); }
    cm.focus(); scheduleRender(); scheduleSave();
  }
  function insertAtLine(prefix) {
    const cur = cm.getCursor();
    cm.replaceRange(prefix, { line: cur.line, ch: 0 });
    cm.focus(); scheduleRender(); scheduleSave();
  }

  // ===== Export PDF =====
  function exportPDF() {
    const w = window.open('', '_blank');
    w.document.write(`<!DOCTYPE html><html><head><title>${escapeHtml(fileNameInput.value || 'Markdown')}</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;padding:40px;max-width:800px;margin:0 auto;line-height:1.7;color:#1a1d21}h1,h2{border-bottom:1px solid #e5e7eb;padding-bottom:.25em}h1{font-size:2em}h2{font-size:1.5em}h3{font-size:1.25em}code{background:#f4f5f7;padding:.15em .4em;border-radius:4px;font-family:Consolas,monospace;font-size:.9em}pre{background:#f4f5f7;padding:16px;border-radius:8px;overflow-x:auto}pre code{background:none;padding:0}blockquote{border-left:3px solid #d1d5db;padding:2px 0 2px 16px;color:#5f6672;margin:0 0 14px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #e5e7eb;padding:8px 12px;text-align:left}thead th{background:#f8f9fb}img{max-width:100%}a{color:#3b82f6}@media print{body{padding:0}}</style></head><body>${preview.innerHTML}</body></html>`);
    w.document.close(); setTimeout(() => w.print(), 500);
  }

  // ===== Utilities =====
  function showToast(msg) { toast.textContent = msg; toast.classList.add('show'); setTimeout(() => toast.classList.remove('show'), 2500); }
  function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  // ===== Init =====
  async function init() {
    // Auth check
    try {
      const authRes = await fetch('/api/auth/status');
      const authData = await authRes.json();
      if (!authData.setup_done) { location.href = '/setup.html'; return; }
      if (!authData.logged_in && !location.pathname.match(/^\/(s|p|e)\//)) { location.href = '/login.html'; return; }
      if (authData.user) { const el = $('#sidebar-username'); if (el) el.textContent = authData.user.username; }
    } catch (e) {}

    if (await checkSharedView()) return;

    await loadAll();
    if (!files.length) { const file = await api.createFile('Welcome', DEFAULT_MD); files = [file]; renderSidebar(); }

    const savedFileId = localStorage.getItem('md-active-file');
    activeFileId = (savedFileId && files.find(f => f.id === savedFileId)) ? savedFileId : files[0].id;
    await switchFile(activeFileId);

    const darkPref = localStorage.getItem('md-dark');
    if (darkPref === '1') applyDark(true);
    else if (darkPref === null && window.matchMedia('(prefers-color-scheme: dark)').matches) applyDark(true);

    setupSyncScroll();
    setupDivider();
    setupImageUpload();

    cm.on('changes', (instance, changes) => {
      // setValue() (switchFile loading a file, cached or fresh) fires this
      // same event. Autosaving on that would write the just-loaded content
      // straight back to the server - clobbering anything newer there with
      // whatever we happened to have loaded (e.g. a stale cache entry).
      if (changes.some((c) => c.origin === 'setValue')) return;
      scheduleRender(); scheduleSave();
    });
    cm.on('cursorActivity', updateCursor);

    fileNameInput.addEventListener('input', () => {
      if (!activeFileId) return;
      clearTimeout(saveTimer); showSaveStatus('Saving...');
      pendingSaveFileId = activeFileId;
      pendingName = fileNameInput.value;
      saveTimer = setTimeout(flushPendingSave, 400);
    });

    $('#stale-reload').addEventListener('click', async (e) => {
      await withLoading(e.currentTarget, () => switchFile(activeFileId, true));
      showToast('Reloaded');
    });
    $('#stale-dismiss').addEventListener('click', hideStaleBanner);
    startStaleCheck();

    $('#btn-new-file').addEventListener('click', showNewFileMenu);
    $('#btn-save-template').addEventListener('click', () => {
      modalTitle.textContent = 'Save as template';
      modalBody.innerHTML = `
        <div style="margin-bottom:16px">
          <label style="display:block;font-size:12px;color:var(--text-2);margin-bottom:6px">Template name</label>
          <input type="text" id="template-name-input" class="file-name-input" style="width:100%" value="${escapeHtml(fileNameInput.value || 'Untitled')}" spellcheck="false">
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button class="btn-new-folder" id="template-cancel" style="margin:0;width:auto">Cancel</button>
          <button class="btn-new-file" id="template-save" style="margin:0;width:auto">Save</button>
        </div>
      `;
      modalOverlay.classList.add('show');
      const input = $('#template-name-input');
      input.focus(); input.select();
      $('#template-cancel').addEventListener('click', () => modalOverlay.classList.remove('show'));
      $('#template-save').addEventListener('click', async (e) => {
        await withLoading(e.currentTarget, () => api.createTemplate(input.value.trim() || 'Untitled', cm.getValue()));
        modalOverlay.classList.remove('show');
        showToast('Saved as template');
      });
    });
    $('#btn-new-folder').addEventListener('click', createNewFolder);
    $('#btn-toggle-sidebar').addEventListener('click', () => { sidebar.classList.add('collapsed'); $('#btn-open-sidebar').style.display = 'flex'; });
    $('#btn-open-sidebar').addEventListener('click', () => { sidebar.classList.remove('collapsed'); $('#btn-open-sidebar').style.display = 'none'; });
    $('#btn-apikeys').addEventListener('click', openApiKeysManager);
    $('#btn-about').addEventListener('click', () => {
      modalTitle.textContent = 'About';
      modalBody.innerHTML = `
        <div style="text-align:center;padding:8px 0">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" style="margin-bottom:8px"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          <h3 style="font-size:16px;font-weight:700;margin-bottom:2px">Markdown Preview Studio</h3>
          <p style="color:var(--text-3);font-size:12px;margin-bottom:12px">Community Edition</p>
          <p style="font-size:20px;font-weight:600;color:var(--accent);margin-bottom:16px">v1.0.0</p>
          <div style="font-size:12px;color:var(--text-2);line-height:1.8;text-align:left;border-top:1px solid var(--border);padding-top:12px">
            <p>Self-hosted Markdown editor with live preview, PostgreSQL storage, folder management, and sharing.</p>
            <p style="margin-top:8px"><a href="/docs.html" target="_blank" rel="noopener noreferrer" style="color:var(--accent)">API documentation</a> - for integrating with third-party tools</p>
            <p style="margin-top:8px">MIT License &copy; 2026 <a href="https://github.com/c2at3" target="_blank" rel="noopener noreferrer" style="color:var(--accent)">c2at3</a></p>
          </div>
        </div>
      `;
      modalOverlay.classList.add('show');
    });

    $('#btn-logout').addEventListener('click', () => {
      modalTitle.textContent = 'Logout';
      modalBody.innerHTML = '<p style="color:var(--text-2);font-size:14px;margin-bottom:16px">Are you sure you want to log out?</p><div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn-new-folder" id="logout-cancel" style="margin:0;width:auto">Cancel</button><button class="btn-new-file" id="logout-confirm" style="margin:0;width:auto;background:var(--danger)">Logout</button></div>';
      modalOverlay.classList.add('show');
      $('#logout-cancel').addEventListener('click', () => modalOverlay.classList.remove('show'));
      $('#logout-confirm').addEventListener('click', async () => {
        await fetch('/api/auth/logout', { method: 'POST' });
        document.cookie = 'session=;path=/;max-age=0';
        location.href = '/login.html';
      });
    });

    $('#btn-bold').addEventListener('click', () => insertAround('**', '**'));
    $('#btn-italic').addEventListener('click', () => insertAround('*', '*'));
    $('#btn-heading').addEventListener('click', () => insertAtLine('## '));
    $('#btn-link').addEventListener('click', () => insertAround('[', '](url)'));
    $('#btn-code').addEventListener('click', () => insertAround('```\n', '\n```'));
    $('#btn-table').addEventListener('click', () => {
      modalTitle.textContent = 'Insert table';
      modalBody.innerHTML = `
        <div style="display:flex;gap:12px;margin-bottom:16px">
          <div style="flex:1">
            <label style="display:block;font-size:12px;color:var(--text-2);margin-bottom:6px">Columns</label>
            <input type="number" id="table-cols-input" class="file-name-input" style="width:100%" min="1" max="20" value="2">
          </div>
          <div style="flex:1">
            <label style="display:block;font-size:12px;color:var(--text-2);margin-bottom:6px">Rows</label>
            <input type="number" id="table-rows-input" class="file-name-input" style="width:100%" min="1" max="50" value="1">
          </div>
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button class="btn-new-folder" id="table-cancel" style="margin:0;width:auto">Cancel</button>
          <button class="btn-new-file" id="table-insert" style="margin:0;width:auto">Insert</button>
        </div>
      `;
      modalOverlay.classList.add('show');
      const colsInput = $('#table-cols-input'), rowsInput = $('#table-rows-input');
      colsInput.focus(); colsInput.select();
      const doInsert = () => {
        insertText(buildMarkdownTable(parseInt(colsInput.value, 10), parseInt(rowsInput.value, 10)));
        modalOverlay.classList.remove('show');
      };
      $('#table-cancel').addEventListener('click', () => modalOverlay.classList.remove('show'));
      $('#table-insert').addEventListener('click', doInsert);
      [colsInput, rowsInput].forEach(inp => inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') doInsert(); }));
    });

    $('#btn-copy-md').addEventListener('click', () => navigator.clipboard.writeText(cm.getValue()).then(() => showToast('Markdown copied')));
    $('#btn-copy-html').addEventListener('click', () => navigator.clipboard.writeText(preview.innerHTML).then(() => showToast('HTML copied')));
    $('#btn-find').addEventListener('click', () => toggleFindPanel());
    $('#btn-share').addEventListener('click', shareCurrentFile);
    $('#btn-export').addEventListener('click', exportPDF);
    $('#toggle-dark').addEventListener('change', () => applyDark($('#toggle-dark').checked));

    $('#modal-close').addEventListener('click', () => modalOverlay.classList.remove('show'));
    modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) modalOverlay.classList.remove('show'); });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { modalOverlay.classList.remove('show'); if (findPanel.style.display !== 'none') toggleFindPanel(false); }
    });
  }

  init();
})();
