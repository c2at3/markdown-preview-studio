(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  const editor = $('#editor');
  const preview = $('#preview');
  const fileNameInput = $('#file-name');
  const fileList = $('#file-list');
  const saveStatus = $('#save-status');
  const toast = $('#toast');
  const modalOverlay = $('#modal-overlay');
  const modalTitle = $('#modal-title');
  const modalBody = $('#modal-body');
  const sidebar = $('#sidebar');

  let files = [];
  let folders = [];
  let activeFileId = null;
  let saveTimer = null;
  let isSharedView = false;
  let dragItem = null;
  let dragType = null;

  const DEFAULT_MD = `# Welcome to Markdown Live Preview

Write your markdown on the left, see the result on the right — in real time.

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
> — Alan Kay

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

  async function renderMermaidBlocks() {
    const els = preview.querySelectorAll('.mermaid-placeholder');
    for (const el of els) {
      const code = decodeURIComponent(el.getAttribute('data-mermaid'));
      try {
        const id = 'mmd-' + Date.now() + '-' + Math.random().toString(36).slice(2, 5);
        const { svg } = await mermaid.render(id, code);
        el.innerHTML = svg;
        el.classList.replace('mermaid-placeholder', 'mermaid-rendered');
      } catch (e) {
        cleanupMermaidErrors();
        const msg = (e.message || 'Invalid syntax').replace(/<[^>]*>/g, '').substring(0, 200);
        el.innerHTML = '<div class="mermaid-error-box"><span class="mermaid-error-icon">⚠</span><div><strong>Mermaid syntax error</strong><pre class="mermaid-error-detail">' + msg + '</pre></div></div>';
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
    preview.innerHTML = marked.parse(editor.value);
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

  let lbZoom = 1;
  let lbPanX = 0, lbPanY = 0;
  let lbDragging = false;
  let lbDragStart = { x: 0, y: 0 };
  let lbIsSvg = false;
  let lbSvgBaseW = 0, lbSvgBaseH = 0;
  const LB_MIN_ZOOM = 0.25;
  const LB_MAX_ZOOM = 5;
  const LB_ZOOM_STEP = 0.25;

  function lbApplyTransform(animate) {
    if (animate) lbTransform.classList.add('animate');
    else lbTransform.classList.remove('animate');

    if (lbIsSvg) {
      const svg = lbTransform.querySelector('svg');
      if (svg) {
        svg.setAttribute('width', Math.round(lbSvgBaseW * lbZoom));
        svg.setAttribute('height', Math.round(lbSvgBaseH * lbZoom));
      }
      lbTransform.style.transform = `translate(${lbPanX}px, ${lbPanY}px)`;
    } else {
      lbTransform.style.transform = `translate(${lbPanX}px, ${lbPanY}px) scale(${lbZoom})`;
    }
    lbZoomLevel.textContent = Math.round(lbZoom * 100) + '%';
  }

  function lbSetZoom(newZoom, centerX, centerY) {
    const clamped = Math.max(LB_MIN_ZOOM, Math.min(LB_MAX_ZOOM, newZoom));
    if (centerX !== undefined && centerY !== undefined) {
      const ratio = clamped / lbZoom;
      lbPanX = centerX - (centerX - lbPanX) * ratio;
      lbPanY = centerY - (centerY - lbPanY) * ratio;
    }
    lbZoom = clamped;
    lbApplyTransform(false);
  }

  function lbReset() {
    lbZoom = 1; lbPanX = 0; lbPanY = 0;
    lbApplyTransform(true);
  }

  function openLightbox(content, caption) {
    lbTransform.innerHTML = '';
    lbZoom = 1; lbPanX = 0; lbPanY = 0;
    lbIsSvg = false;

    if (typeof content === 'string') {
      const img = document.createElement('img');
      img.className = 'lightbox-content';
      img.src = content;
      img.alt = caption || '';
      img.draggable = false;
      lbTransform.appendChild(img);
    } else {
      lbIsSvg = true;
      const svgClone = content.cloneNode(true);

      // Get natural size from viewBox (mermaid sets width="100%" so ignore attr)
      const vb = svgClone.getAttribute('viewBox');
      const vbParts = vb ? vb.split(/[\s,]+/).map(Number) : null;
      const naturalW = vbParts ? vbParts[2] : 800;
      const naturalH = vbParts ? vbParts[3] : 600;

      if (!vb) svgClone.setAttribute('viewBox', '0 0 ' + naturalW + ' ' + naturalH);

      // Fit to screen while keeping viewBox scaling (text stays sharp)
      const maxW = window.innerWidth * 0.85;
      const maxH = window.innerHeight * 0.8;
      const fitScale = Math.min(1, maxW / naturalW, maxH / naturalH);
      lbSvgBaseW = naturalW * fitScale;
      lbSvgBaseH = naturalH * fitScale;

      svgClone.removeAttribute('style');
      svgClone.removeAttribute('width');
      svgClone.removeAttribute('height');
      svgClone.setAttribute('width', Math.round(lbSvgBaseW));
      svgClone.setAttribute('height', Math.round(lbSvgBaseH));
      svgClone.setAttribute('overflow', 'hidden');
      svgClone.style.cssText = 'display:block;background:var(--surface);border-radius:var(--radius);padding:16px;box-sizing:content-box;box-shadow:0 4px 40px rgba(0,0,0,0.5);';
      svgClone.setAttribute('shape-rendering', 'geometricPrecision');
      svgClone.setAttribute('text-rendering', 'optimizeLegibility');
      lbTransform.appendChild(svgClone);
    }

    lbCaption.textContent = caption || '';
    lbCaption.style.display = caption ? '' : 'none';
    lbApplyTransform(false);
    lightbox.classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  function closeLightbox() {
    lightbox.classList.remove('open');
    lbTransform.innerHTML = '';
    document.body.style.overflow = '';
  }

  // Toolbar buttons
  $('#lb-zoom-in').addEventListener('click', () => { lbSetZoom(lbZoom + LB_ZOOM_STEP); lbApplyTransform(true); });
  $('#lb-zoom-out').addEventListener('click', () => { lbSetZoom(lbZoom - LB_ZOOM_STEP); lbApplyTransform(true); });
  $('#lb-reset').addEventListener('click', lbReset);
  $('#lb-close').addEventListener('click', closeLightbox);

  // Scroll wheel zoom
  lbViewport.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = lbViewport.getBoundingClientRect();
    const cx = e.clientX - rect.left - rect.width / 2;
    const cy = e.clientY - rect.top - rect.height / 2;
    const delta = e.deltaY > 0 ? -LB_ZOOM_STEP : LB_ZOOM_STEP;
    lbSetZoom(lbZoom + delta, cx, cy);
  }, { passive: false });

  // Pan with mouse drag
  lbViewport.addEventListener('mousedown', (e) => {
    if (e.target.closest('.lightbox-toolbar')) return;
    lbDragging = true;
    lbDragStart = { x: e.clientX - lbPanX, y: e.clientY - lbPanY };
    lbViewport.classList.add('dragging');
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!lbDragging) return;
    lbPanX = e.clientX - lbDragStart.x;
    lbPanY = e.clientY - lbDragStart.y;
    lbApplyTransform(false);
  });
  document.addEventListener('mouseup', () => {
    if (!lbDragging) return;
    lbDragging = false;
    lbViewport.classList.remove('dragging');
  });

  // Double-click to toggle zoom
  lbViewport.addEventListener('dblclick', (e) => {
    if (e.target.closest('.lightbox-toolbar')) return;
    if (lbZoom > 1.1) { lbReset(); }
    else {
      const rect = lbViewport.getBoundingClientRect();
      lbSetZoom(2.5, e.clientX - rect.left - rect.width / 2, e.clientY - rect.top - rect.height / 2);
      lbApplyTransform(true);
    }
  });

  // Click backdrop to close (only if not panned)
  lbViewport.addEventListener('click', (e) => {
    if (e.target === lbViewport && lbZoom <= 1 && Math.abs(lbPanX) < 5 && Math.abs(lbPanY) < 5) closeLightbox();
  });

  // Keyboard
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
      const wrapper = document.createElement('div');
      wrapper.className = 'media-wrapper';
      img.parentNode.insertBefore(wrapper, img);
      wrapper.appendChild(img);
      const btn = document.createElement('button');
      btn.className = 'media-zoom-btn';
      btn.innerHTML = ZOOM_SVG;
      btn.title = 'Zoom';
      wrapper.appendChild(btn);
    });

    preview.querySelectorAll('.mermaid-rendered:not(.wrapped-zoom)').forEach(el => {
      const svg = el.querySelector('svg');
      if (!svg) return;
      el.classList.add('wrapped-zoom');
      const wrapper = document.createElement('div');
      wrapper.className = 'media-wrapper';
      wrapper.style.display = 'block';
      el.parentNode.insertBefore(wrapper, el);
      wrapper.appendChild(el);
      const btn = document.createElement('button');
      btn.className = 'media-zoom-btn';
      btn.innerHTML = ZOOM_SVG;
      btn.title = 'Zoom diagram';
      wrapper.appendChild(btn);
    });
  }

  // Event delegation: only zoom button opens lightbox
  preview.addEventListener('click', (e) => {
    const btn = e.target.closest('.media-zoom-btn');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
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
    editor.style.fontSize = editorFontSize + 'px';
    editor.style.fontWeight = editorFontWeight;
    $('#font-size-val').textContent = editorFontSize;
    $('#weight-val').textContent = editorFontWeight;
    localStorage.setItem('md-font-size', editorFontSize);
    localStorage.setItem('md-font-weight', editorFontWeight);
  }

  $('#font-up').addEventListener('click', () => { editorFontSize = Math.min(24, editorFontSize + 1); applyFont(); });
  $('#font-down').addEventListener('click', () => { editorFontSize = Math.max(10, editorFontSize - 1); applyFont(); });
  $('#weight-up').addEventListener('click', () => { editorFontWeight = Math.min(700, editorFontWeight + 100); applyFont(); });
  $('#weight-down').addEventListener('click', () => { editorFontWeight = Math.max(100, editorFontWeight - 100); applyFont(); });

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

  function toggleFindPanel(show) {
    const visible = show !== undefined ? show : findPanel.style.display === 'none';
    findPanel.style.display = visible ? '' : 'none';
    if (visible) { findInput.focus(); findInput.select(); doFind(); }
    else { findMatches = []; findCurrentIdx = -1; findCount.textContent = ''; findResults.style.display = 'none'; }
  }

  function buildRegex(query) {
    if (!query) return null;
    let pattern = findUseRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    try { return new RegExp(pattern, findMatchCase ? 'g' : 'gi'); }
    catch (e) { return null; }
  }

  function doFind() {
    const query = findInput.value;
    findMatches = [];
    findCurrentIdx = -1;
    findResults.style.display = 'none';
    findResults.innerHTML = '';

    if (!query) { findCount.textContent = ''; return; }

    if (findScope === 'file') {
      findInText(editor.value, query);
      findCount.textContent = findMatches.length ? `${findMatches.length} found` : 'No results';
      if (findMatches.length) { findCurrentIdx = 0; highlightMatch(); }
    } else {
      findAcrossFiles(query);
    }
  }

  function findInText(text, query) {
    const re = buildRegex(query);
    if (!re) return [];
    const matches = [];
    let m;
    while ((m = re.exec(text)) !== null) {
      matches.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
      if (!re.global) break;
    }
    findMatches = matches;
    return matches;
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
        if (re.test(line)) {
          re.lastIndex = 0;
          fileMatches.push({ lineNum: idx + 1, line, fileId: f.id, fileName: f.name });
          totalMatches++;
        }
      });
      if (fileMatches.length) results.push({ file: f, matches: fileMatches });
    }

    findCount.textContent = totalMatches ? `${totalMatches} in ${results.length} files` : 'No results';
    findResults.innerHTML = '';

    if (results.length) {
      findResults.style.display = '';
      results.forEach(r => {
        const fileEl = document.createElement('div');
        fileEl.className = 'find-result-file';
        fileEl.textContent = r.file.name + ' (' + r.matches.length + ')';
        fileEl.addEventListener('click', () => switchFile(r.file.id));
        findResults.appendChild(fileEl);

        r.matches.forEach(m => {
          const lineEl = document.createElement('div');
          lineEl.className = 'find-result-line';
          const highlighted = escapeHtml(m.line).replace(
            buildRegex(query),
            match => '<mark>' + match + '</mark>'
          );
          lineEl.innerHTML = '<span style="color:var(--text-3);margin-right:6px">' + m.lineNum + ':</span>' + highlighted;
          lineEl.addEventListener('click', async () => {
            await switchFile(m.fileId);
            const lines = editor.value.split('\n');
            let pos = 0;
            for (let i = 0; i < m.lineNum - 1; i++) pos += lines[i].length + 1;
            editor.focus();
            editor.selectionStart = pos;
            editor.selectionEnd = pos + m.line.length;
            editor.scrollTop = editor.scrollHeight * (pos / editor.value.length);
          });
          findResults.appendChild(lineEl);
        });
      });
    }
  }

  function highlightMatch() {
    if (!findMatches.length) return;
    const m = findMatches[findCurrentIdx];
    editor.focus();
    editor.selectionStart = m.start;
    editor.selectionEnd = m.end;

    const before = editor.value.substring(0, m.start);
    const lineRatio = before.split('\n').length / editor.value.split('\n').length;
    editor.scrollTop = (editor.scrollHeight - editor.clientHeight) * lineRatio;

    findCount.textContent = `${findCurrentIdx + 1} / ${findMatches.length}`;
  }

  function findNext() {
    if (!findMatches.length) return;
    findCurrentIdx = (findCurrentIdx + 1) % findMatches.length;
    highlightMatch();
  }

  function findPrev() {
    if (!findMatches.length) return;
    findCurrentIdx = (findCurrentIdx - 1 + findMatches.length) % findMatches.length;
    highlightMatch();
  }

  function replaceOne() {
    if (findScope !== 'file' || !findMatches.length || findCurrentIdx < 0) return;
    const m = findMatches[findCurrentIdx];
    editor.focus();
    editor.selectionStart = m.start;
    editor.selectionEnd = m.end;
    document.execCommand('insertText', false, replaceInput.value);
    scheduleSave();
    scheduleRender();
    doFind();
  }

  function replaceAll() {
    if (findScope !== 'file') {
      replaceAllFiles();
      return;
    }
    const query = findInput.value;
    const re = buildRegex(query);
    if (!re || !query) return;
    const replaced = editor.value.replace(re, replaceInput.value);
    if (replaced === editor.value) return;
    editor.focus();
    editor.selectionStart = 0;
    editor.selectionEnd = editor.value.length;
    document.execCommand('insertText', false, replaced);
    scheduleSave();
    scheduleRender();
    doFind();
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
      if (replaced !== file.content) {
        await api.updateFile(f.id, { content: replaced });
        re.lastIndex = 0;
        count++;
      }
    }
    if (activeFileId) {
      const cur = await api.getFile(activeFileId);
      editor.value = cur.content;
      scheduleRender();
    }
    showToast(count + ' files updated');
    doFind();
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
    tab.addEventListener('click', () => {
      $$('.find-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      findScope = tab.dataset.scope;
      doFind();
    });
  });

  // ===== Stats =====
  function updateStats() {
    const text = editor.value;
    const lines = text.split('\n').length;
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    $('#stat-lines').textContent = lines + ' lines';
    $('#stat-words').textContent = words + ' words';
    $('#stat-chars').textContent = text.length + ' chars';
  }

  function updateCursor() {
    const pos = editor.selectionStart;
    const before = editor.value.substring(0, pos);
    $('#stat-cursor').textContent = 'Ln ' + before.split('\n').length + ', Col ' + (pos - before.lastIndexOf('\n'));
  }

  // ===== Sidebar: file list with folders =====
  async function loadAll() {
    [files, folders] = await Promise.all([api.getFiles(), api.getFolders()]);
    renderSidebar();
  }

  function renderSidebar() {
    fileList.innerHTML = '';
    const rootFolders = folders.filter(f => !f.parent_id).sort((a, b) => a.sort_order - b.sort_order);
    const rootFiles = files.filter(f => !f.folder_id).sort((a, b) => (b.is_pinned || 0) - (a.is_pinned || 0) || a.sort_order - b.sort_order);

    rootFolders.forEach(folder => fileList.appendChild(buildFolderEl(folder)));
    rootFiles.forEach(f => fileList.appendChild(buildFileEl(f)));

    // Drop zone for root
    fileList.addEventListener('dragover', (e) => {
      if (!dragItem) return;
      e.preventDefault();
      const afterEl = getDragAfterElement(fileList, e.clientY);
      if (!afterEl) fileList.classList.add('drag-over-root');
    });
    fileList.addEventListener('dragleave', () => fileList.classList.remove('drag-over-root'));
    fileList.addEventListener('drop', async (e) => {
      e.preventDefault();
      fileList.classList.remove('drag-over-root');
      if (dragType === 'file' && dragItem) {
        await api.updateFile(dragItem, { folder_id: null });
        await loadAll();
      }
    });
  }

  function buildFolderEl(folder) {
    const childFolders = folders.filter(f => f.parent_id === folder.id).sort((a, b) => a.sort_order - b.sort_order);
    const childFiles = files.filter(f => f.folder_id === folder.id).sort((a, b) => a.sort_order - b.sort_order);
    const isCollapsed = folder.collapsed;

    const el = document.createElement('div');
    el.className = 'folder-item';
    el.dataset.folderId = folder.id;

    const header = document.createElement('div');
    header.className = 'folder-header';
    header.draggable = true;
    header.innerHTML = `
      <svg class="folder-chevron ${isCollapsed ? 'collapsed' : ''}" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
      <svg class="folder-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
      <span class="folder-name">${escapeHtml(folder.name)}</span>
      <div class="folder-actions">
        <button data-action="add-file" title="New file here">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
        </button>
        <button class="btn-delete-folder" data-action="delete-folder" title="Delete folder">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>
    `;

    // Click to toggle
    header.addEventListener('click', async (e) => {
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action === 'delete-folder') {
        e.stopPropagation();
        if (confirm('Delete folder "' + folder.name + '"? Files will be moved to root.')) {
          await api.deleteFolder(folder.id);
          await loadAll();
        }
        return;
      }
      if (action === 'add-file') {
        e.stopPropagation();
        const file = await api.createFile('Untitled', '', folder.id);
        await loadAll();
        await switchFile(file.id);
        fileNameInput.focus();
        fileNameInput.select();
        return;
      }
      folder.collapsed = !folder.collapsed;
      await api.updateFolder(folder.id, { collapsed: !isCollapsed });
      renderSidebar();
    });

    // Double-click to rename
    header.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      const nameSpan = header.querySelector('.folder-name');
      const input = document.createElement('input');
      input.className = 'folder-name-input';
      input.value = folder.name;
      nameSpan.replaceWith(input);
      input.focus();
      input.select();
      const finish = async () => {
        const newName = input.value.trim() || folder.name;
        await api.updateFolder(folder.id, { name: newName });
        folder.name = newName;
        renderSidebar();
      };
      input.addEventListener('blur', finish);
      input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') input.blur(); if (ev.key === 'Escape') { input.value = folder.name; input.blur(); } });
    });

    // Drag folder
    header.addEventListener('dragstart', (e) => {
      dragItem = folder.id;
      dragType = 'folder';
      header.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    header.addEventListener('dragend', () => { header.classList.remove('dragging'); dragItem = null; dragType = null; });

    // Drop onto folder
    header.addEventListener('dragover', (e) => {
      if (!dragItem || (dragType === 'folder' && dragItem === folder.id)) return;
      e.preventDefault();
      header.classList.add('drag-over');
    });
    header.addEventListener('dragleave', () => header.classList.remove('drag-over'));
    header.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      header.classList.remove('drag-over');
      if (dragType === 'file' && dragItem) {
        await api.updateFile(dragItem, { folder_id: folder.id });
        await loadAll();
      } else if (dragType === 'folder' && dragItem && dragItem !== folder.id) {
        await api.updateFolder(dragItem, { parent_id: folder.id });
        await loadAll();
      }
    });

    el.appendChild(header);

    const children = document.createElement('div');
    children.className = 'folder-children' + (isCollapsed ? ' hidden' : '');
    childFolders.forEach(cf => children.appendChild(buildFolderEl(cf)));
    childFiles.forEach(f => children.appendChild(buildFileEl(f)));
    el.appendChild(children);

    return el;
  }

  function buildFileEl(f) {
    const el = document.createElement('div');
    el.className = 'file-item' + (f.id === activeFileId ? ' active' : '');
    el.draggable = true;
    el.dataset.fileId = f.id;
    el.innerHTML = `
      <svg class="file-item-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
      <span class="file-item-name">${escapeHtml(f.name || 'Untitled')}</span>
      <span class="file-item-pin ${f.is_pinned ? 'pinned' : ''}" data-action="pin" title="Pin"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg></span>
      <div class="file-item-actions">
        <button data-action="delete" title="Delete">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
        </button>
      </div>
    `;

    el.addEventListener('click', (e) => {
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action === 'delete') { deleteFile(f.id); e.stopPropagation(); return; }
      if (action === 'pin') { togglePin(f.id, !f.is_pinned); e.stopPropagation(); return; }
      switchFile(f.id);
    });

    // Drag file
    el.addEventListener('dragstart', (e) => {
      dragItem = f.id;
      dragType = 'file';
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('dragend', () => { el.classList.remove('dragging'); dragItem = null; dragType = null; });

    // Drop reorder
    el.addEventListener('dragover', (e) => {
      if (!dragItem || dragType !== 'file' || dragItem === f.id) return;
      e.preventDefault();
      el.classList.add('drag-over');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
    el.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.classList.remove('drag-over');
      if (dragType === 'file' && dragItem && dragItem !== f.id) {
        await api.updateFile(dragItem, { folder_id: f.folder_id || null, sort_order: f.sort_order });
        await loadAll();
      }
    });

    return el;
  }

  function getDragAfterElement(container, y) {
    const items = [...container.querySelectorAll('.file-item:not(.dragging), .folder-item:not(.dragging)')];
    return items.reduce((closest, child) => {
      const box = child.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) return { offset, element: child };
      return closest;
    }, { offset: Number.NEGATIVE_INFINITY }).element;
  }

  // ===== File management =====
  async function switchFile(id) {
    activeFileId = id;
    const file = await api.getFile(id);
    editor.value = file.content;
    fileNameInput.value = file.name;
    renderSidebar();
    render();
    showSaveStatus('Loaded');
  }

  async function createNewFile(folderId) {
    const file = await api.createFile('Untitled', '', folderId || null);
    await loadAll();
    await switchFile(file.id);
    fileNameInput.focus();
    fileNameInput.select();
  }

  async function deleteFile(id) {
    if (files.length <= 1) { showToast('Cannot delete the last file'); return; }
    const f = files.find(x => x.id === id);
    if (!confirm('Delete "' + (f?.name || 'Untitled') + '"?')) return;
    await api.deleteFile(id);
    files = files.filter(x => x.id !== id);
    if (id === activeFileId) await switchFile(files[0].id);
    renderSidebar();
    showToast('File deleted');
  }

  async function togglePin(id, pinned) {
    await api.updateFile(id, { is_pinned: pinned });
    await loadAll();
  }

  async function createNewFolder() {
    const folder = await api.createFolder('New Folder');
    await loadAll();
    // Auto-focus rename
    const el = fileList.querySelector(`[data-folder-id="${folder.id}"] .folder-header`);
    if (el) el.dispatchEvent(new MouseEvent('dblclick'));
  }

  // ===== Auto-save =====
  function scheduleSave() {
    clearTimeout(saveTimer);
    showSaveStatus('Saving...');
    saveTimer = setTimeout(async () => {
      if (!activeFileId) return;
      await api.updateFile(activeFileId, { content: editor.value });
      showSaveStatus('Saved');
    }, 500);
  }

  function showSaveStatus(text) {
    saveStatus.textContent = text;
    if (text === 'Saved') setTimeout(() => { if (saveStatus.textContent === 'Saved') saveStatus.textContent = ''; }, 2000);
  }

  // ===== Image upload =====
  function setupImageUpload() {
    const fileInput = $('#image-upload');

    $('#btn-image').addEventListener('click', () => {
      modalTitle.textContent = 'Insert Image';
      modalBody.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:12px">
          <button class="btn-new-file" id="btn-upload-file" style="margin:0">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>
            Upload from computer
          </button>
          <div style="text-align:center;color:var(--text-3);font-size:12px">or</div>
          <div class="share-url-box">
            <input type="text" id="image-url-input" placeholder="Paste image URL..." style="font-family:var(--font-sans)">
            <button id="btn-insert-url">Insert</button>
          </div>
        </div>
      `;
      modalOverlay.classList.add('show');

      $('#btn-upload-file').addEventListener('click', () => {
        fileInput.click();
      });

      $('#btn-insert-url').addEventListener('click', () => {
        const url = $('#image-url-input').value.trim();
        if (url) {
          insertText('\n![image](' + url + ')\n');
          modalOverlay.classList.remove('show');
        }
      });

      $('#image-url-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') $('#btn-insert-url').click();
      });
    });

    fileInput.addEventListener('change', async () => {
      const file = fileInput.files[0];
      if (!file) return;
      const allowedTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
      if (!allowedTypes.includes(file.type)) { showToast('Only PNG, JPG, GIF, WebP allowed'); return; }
      if (file.size > 5 * 1024 * 1024) { showToast('Image too large (max 5MB)'); return; }

      showToast('Uploading...');
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const { url } = await api.uploadImage(reader.result, file.name);
          insertText('\n![' + file.name + '](' + url + ')\n');
          modalOverlay.classList.remove('show');
          showToast('Image uploaded');
        } catch (e) {
          showToast('Upload failed');
        }
      };
      reader.readAsDataURL(file);
      fileInput.value = '';
    });

    // Paste image in editor
    editor.addEventListener('paste', async (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const file = item.getAsFile();
          showToast('Uploading pasted image...');
          const reader = new FileReader();
          reader.onload = async () => {
            try {
              const { url } = await api.uploadImage(reader.result, 'pasted-image');
              insertText('![image](' + url + ')');
              showToast('Image uploaded');
            } catch (err) {
              showToast('Upload failed');
            }
          };
          reader.readAsDataURL(file);
          break;
        }
      }
    });
  }

  // ===== Sync scroll =====
  let programmaticScroll = false;
  let activeScroller = null;
  let scrollLockTimer = null;

  function syncPreviewToEditor() {
    if (!$('#toggle-sync').checked) return;
    const maxEd = editor.scrollHeight - editor.clientHeight;
    const maxPr = preview.scrollHeight - preview.clientHeight;
    if (maxEd <= 0 || maxPr <= 0) return;
    programmaticScroll = true;
    preview.scrollTop = (editor.scrollTop / maxEd) * maxPr;
    requestAnimationFrame(() => { programmaticScroll = false; });
  }

  function setupSyncScroll() {
    editor.addEventListener('scroll', () => {
      if (!$('#toggle-sync').checked || isRendering) return;
      if (activeScroller === 'preview') return;
      activeScroller = 'editor';
      clearTimeout(scrollLockTimer);
      syncPreviewToEditor();
      scrollLockTimer = setTimeout(() => { activeScroller = null; }, 100);
    });
    preview.addEventListener('scroll', () => {
      if (!$('#toggle-sync').checked || programmaticScroll || isRendering) return;
      if (activeScroller === 'editor') return;
      activeScroller = 'preview';
      clearTimeout(scrollLockTimer);
      const maxPr = preview.scrollHeight - preview.clientHeight;
      const maxEd = editor.scrollHeight - editor.clientHeight;
      if (maxPr > 0 && maxEd > 0) {
        programmaticScroll = true;
        editor.scrollTop = (preview.scrollTop / maxPr) * maxEd;
        requestAnimationFrame(() => { programmaticScroll = false; });
      }
      scrollLockTimer = setTimeout(() => { activeScroller = null; }, 100);
    });
  }

  // ===== Divider drag =====
  function setupDivider() {
    const divider = $('#divider');
    const container = $('.editor-container');
    const editorPane = $('#editor-pane');
    const previewPane = $('#preview-pane');
    let dragging = false;

    divider.addEventListener('mousedown', (e) => {
      dragging = true; divider.classList.add('dragging');
      document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none';
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const rect = container.getBoundingClientRect();
      const pct = Math.max(20, Math.min(80, ((e.clientX - rect.left) / rect.width) * 100));
      editorPane.style.flex = 'none'; previewPane.style.flex = 'none';
      editorPane.style.width = pct + '%'; previewPane.style.width = (100 - pct) + '%';
    });
    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false; divider.classList.remove('dragging');
      document.body.style.cursor = ''; document.body.style.userSelect = '';
    });
  }

  // ===== Dark mode =====
  function applyDark(dark) {
    document.body.classList.toggle('dark', dark);
    $('#toggle-dark').checked = dark;
    localStorage.setItem('md-dark', dark ? '1' : '0');
    $('#hljs-light').disabled = dark;
    $('#hljs-dark').disabled = !dark;
    initMermaid();
    if (editor.value) render();
  }

  // ===== Share =====
  async function shareCurrentFile() {
    if (!activeFileId) return;
    const { share_id } = await api.shareFile(activeFileId);
    const url = location.origin + '/s/' + share_id;
    modalTitle.textContent = 'Share Link';
    modalBody.innerHTML = `
      <div class="share-url-box">
        <input type="text" id="share-url" value="${url}" readonly>
        <button id="btn-copy-share">Copy</button>
      </div>
      <p class="share-info">Anyone with this link can view and fork a copy of this document.</p>
    `;
    modalOverlay.classList.add('show');
    $('#btn-copy-share').addEventListener('click', () => {
      navigator.clipboard.writeText(url).then(() => {
        $('#btn-copy-share').textContent = 'Copied!';
        setTimeout(() => { $('#btn-copy-share').textContent = 'Copy'; }, 2000);
      });
    });
  }

  // ===== Shared view =====
  async function checkSharedView() {
    const match = location.pathname.match(/^\/s\/(.+)$/);
    if (!match) return false;
    const file = await api.getShared(match[1]);
    if (!file) { showToast('Shared file not found'); return false; }
    isSharedView = true;
    editor.value = file.content; fileNameInput.value = file.name;
    fileNameInput.readOnly = true; editor.readOnly = true;
    render();
    $('#shared-banner').style.display = 'block';
    $('.main').style.marginTop = '38px';
    sidebar.classList.add('collapsed');
    $('#btn-open-sidebar').style.display = 'none';
    $('#btn-fork').addEventListener('click', async () => { await api.forkShared(match[1]); location.href = '/'; });
    $('#btn-close-banner').addEventListener('click', () => { $('#shared-banner').style.display = 'none'; $('.main').style.marginTop = '0'; });
    return true;
  }

  // ===== Toolbar insert helpers (undo-friendly) =====
  function insertText(text) {
    editor.focus();
    document.execCommand('insertText', false, text);
    scheduleRender(); scheduleSave();
  }

  function insertAround(before, after) {
    editor.focus();
    const start = editor.selectionStart, end = editor.selectionEnd;
    const selected = editor.value.substring(start, end);
    document.execCommand('insertText', false, before + (selected || 'text') + after);
    editor.selectionStart = start + before.length;
    editor.selectionEnd = start + before.length + (selected || 'text').length;
    scheduleRender(); scheduleSave();
  }

  function insertAtLine(prefix) {
    editor.focus();
    const start = editor.selectionStart;
    const lineStart = editor.value.lastIndexOf('\n', start - 1) + 1;
    editor.selectionStart = lineStart; editor.selectionEnd = lineStart;
    document.execCommand('insertText', false, prefix);
    scheduleRender(); scheduleSave();
  }

  // ===== Export PDF =====
  function exportPDF() {
    const w = window.open('', '_blank');
    w.document.write(`<!DOCTYPE html><html><head><title>${escapeHtml(fileNameInput.value || 'Markdown')}</title>
      <style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;padding:40px;max-width:800px;margin:0 auto;line-height:1.7;color:#1a1d21}h1,h2{border-bottom:1px solid #e5e7eb;padding-bottom:.25em}h1{font-size:2em}h2{font-size:1.5em}h3{font-size:1.25em}code{background:#f4f5f7;padding:.15em .4em;border-radius:4px;font-family:Consolas,monospace;font-size:.9em}pre{background:#f4f5f7;padding:16px;border-radius:8px;overflow-x:auto}pre code{background:none;padding:0}blockquote{border-left:3px solid #d1d5db;padding:2px 0 2px 16px;color:#5f6672;margin:0 0 14px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #e5e7eb;padding:8px 12px;text-align:left}thead th{background:#f8f9fb}img{max-width:100%}a{color:#3b82f6}@media print{body{padding:0}}</style>
    </head><body>${preview.innerHTML}</body></html>`);
    w.document.close();
    setTimeout(() => w.print(), 500);
  }

  // ===== Utilities =====
  function showToast(msg) { toast.textContent = msg; toast.classList.add('show'); setTimeout(() => toast.classList.remove('show'), 2500); }
  function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  // ===== Init =====
  async function init() {
    if (await checkSharedView()) return;

    await loadAll();

    if (!files.length) {
      const file = await api.createFile('Welcome', DEFAULT_MD);
      files = [file];
      renderSidebar();
    }

    activeFileId = files[0].id;
    await switchFile(activeFileId);

    const darkPref = localStorage.getItem('md-dark');
    if (darkPref === '1') applyDark(true);
    else if (darkPref === null && window.matchMedia('(prefers-color-scheme: dark)').matches) applyDark(true);

    setupSyncScroll();
    setupDivider();
    setupImageUpload();

    editor.addEventListener('input', () => { scheduleRender(); scheduleSave(); });
    editor.addEventListener('click', updateCursor);
    editor.addEventListener('keyup', updateCursor);
    editor.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') { e.preventDefault(); document.execCommand('insertText', false, '  '); scheduleRender(); scheduleSave(); }
    });

    fileNameInput.addEventListener('input', () => {
      if (!activeFileId) return;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        await api.updateFile(activeFileId, { name: fileNameInput.value });
        const f = files.find(x => x.id === activeFileId);
        if (f) f.name = fileNameInput.value;
        renderSidebar();
        showSaveStatus('Saved');
      }, 400);
    });

    $('#btn-new-file').addEventListener('click', () => createNewFile());
    $('#btn-new-folder').addEventListener('click', createNewFolder);
    $('#btn-toggle-sidebar').addEventListener('click', () => { sidebar.classList.add('collapsed'); $('#btn-open-sidebar').style.display = 'flex'; });
    $('#btn-open-sidebar').addEventListener('click', () => { sidebar.classList.remove('collapsed'); $('#btn-open-sidebar').style.display = 'none'; });

    $('#btn-bold').addEventListener('click', () => insertAround('**', '**'));
    $('#btn-italic').addEventListener('click', () => insertAround('*', '*'));
    $('#btn-heading').addEventListener('click', () => insertAtLine('## '));
    $('#btn-link').addEventListener('click', () => insertAround('[', '](url)'));
    $('#btn-code').addEventListener('click', () => insertAround('```\n', '\n```'));
    $('#btn-table').addEventListener('click', () => insertText('\n| Column 1 | Column 2 |\n| -------- | -------- |\n| Cell 1   | Cell 2   |\n'));

    $('#btn-copy-md').addEventListener('click', () => navigator.clipboard.writeText(editor.value).then(() => showToast('Markdown copied')));
    $('#btn-copy-html').addEventListener('click', () => navigator.clipboard.writeText(preview.innerHTML).then(() => showToast('HTML copied')));
    $('#btn-share').addEventListener('click', shareCurrentFile);
    $('#btn-export').addEventListener('click', exportPDF);
    $('#toggle-dark').addEventListener('change', () => applyDark($('#toggle-dark').checked));

    $('#modal-close').addEventListener('click', () => modalOverlay.classList.remove('show'));
    modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) modalOverlay.classList.remove('show'); });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') modalOverlay.classList.remove('show');
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); showToast('All changes saved automatically'); }
      if ((e.ctrlKey || e.metaKey) && e.key === 'b') { e.preventDefault(); insertAround('**', '**'); }
      if ((e.ctrlKey || e.metaKey) && e.key === 'i') { e.preventDefault(); insertAround('*', '*'); }
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') { e.preventDefault(); toggleFindPanel(true); }
      if ((e.ctrlKey || e.metaKey) && e.key === 'h') { e.preventDefault(); toggleFindPanel(true); replaceInput.focus(); }
    });
  }

  init();
})();
