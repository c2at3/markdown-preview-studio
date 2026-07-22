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
    preview.innerHTML = marked.parse(cm.getValue());
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
  let lbIsSvg = false, lbSvgBaseW = 0, lbSvgBaseH = 0;
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
    lbTransform.innerHTML = ''; lbZoom = 1; lbPanX = 0; lbPanY = 0; lbIsSvg = false;
    if (typeof content === 'string') {
      const img = document.createElement('img');
      img.className = 'lightbox-content'; img.src = content; img.alt = caption || ''; img.draggable = false;
      lbTransform.appendChild(img);
    } else {
      lbIsSvg = true;
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
    header.innerHTML = `<svg class="folder-chevron ${folder.collapsed ? 'collapsed' : ''}" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg><svg class="folder-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg><span class="folder-name">${escapeHtml(folder.name)}</span><div class="folder-actions"><button data-action="add-file" title="New file here"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg></button><button class="btn-delete-folder" data-action="delete-folder" title="Delete folder"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg></button></div>`;
    header.addEventListener('click', async (e) => {
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action === 'delete-folder') { e.stopPropagation(); if (confirm('Delete folder "' + folder.name + '"?')) { await api.deleteFolder(folder.id); await loadAll(); } return; }
      if (action === 'add-file') { e.stopPropagation(); const file = await api.createFile('Untitled', '', folder.id); await loadAll(); await switchFile(file.id); fileNameInput.focus(); fileNameInput.select(); return; }
      folder.collapsed = !folder.collapsed; await api.updateFolder(folder.id, { collapsed: !folder.collapsed }); renderSidebar();
    });
    header.addEventListener('dblclick', (e) => {
      e.stopPropagation(); const nameSpan = header.querySelector('.folder-name');
      const input = document.createElement('input'); input.className = 'folder-name-input'; input.value = folder.name; nameSpan.replaceWith(input); input.focus(); input.select();
      const finish = async () => { await api.updateFolder(folder.id, { name: input.value.trim() || folder.name }); folder.name = input.value.trim() || folder.name; renderSidebar(); };
      input.addEventListener('blur', finish); input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') input.blur(); if (ev.key === 'Escape') { input.value = folder.name; input.blur(); } });
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
    el.innerHTML = `<svg class="file-item-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg><span class="file-item-name">${escapeHtml(f.name || 'Untitled')}</span><span class="file-item-pin ${f.is_pinned ? 'pinned' : ''}" data-action="pin" title="Pin"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg></span><div class="file-item-actions"><button data-action="delete" title="Delete"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg></button></div>`;
    el.addEventListener('click', (e) => { const action = e.target.closest('[data-action]')?.dataset.action; if (action === 'delete') { deleteFile(f.id); e.stopPropagation(); return; } if (action === 'pin') { togglePin(f.id, !f.is_pinned); e.stopPropagation(); return; } switchFile(f.id); });
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
  async function switchFile(id) {
    activeFileId = id;
    localStorage.setItem('md-active-file', id);
    const file = await api.getFile(id);
    cm.setValue(file.content);
    fileNameInput.value = file.name;
    renderSidebar(); render(); showSaveStatus('Loaded');
  }

  async function createNewFile(folderId) {
    const file = await api.createFile('Untitled', '', folderId || null);
    await loadAll(); await switchFile(file.id); fileNameInput.focus(); fileNameInput.select();
  }

  async function deleteFile(id) {
    if (files.length <= 1) { showToast('Cannot delete the last file'); return; }
    const f = files.find(x => x.id === id);
    if (!confirm('Delete "' + (f?.name || 'Untitled') + '"?')) return;
    await api.deleteFile(id); files = files.filter(x => x.id !== id);
    if (id === activeFileId) await switchFile(files[0].id);
    renderSidebar(); showToast('File deleted');
  }

  async function togglePin(id, pinned) { await api.updateFile(id, { is_pinned: pinned }); await loadAll(); }
  async function createNewFolder() { const folder = await api.createFolder('New Folder'); await loadAll(); const el = fileList.querySelector(`[data-folder-id="${folder.id}"] .folder-header`); if (el) el.dispatchEvent(new MouseEvent('dblclick')); }

  // ===== Auto-save =====
  function scheduleSave() {
    clearTimeout(saveTimer); showSaveStatus('Saving...');
    saveTimer = setTimeout(async () => { if (!activeFileId) return; await api.updateFile(activeFileId, { content: cm.getValue() }); showSaveStatus('Saved'); }, 500);
  }
  function showSaveStatus(text) { saveStatus.textContent = text; if (text === 'Saved') setTimeout(() => { if (saveStatus.textContent === 'Saved') saveStatus.textContent = ''; }, 2000); }

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
    if (cm.getValue()) render();
  }

  // ===== Share =====
  async function shareCurrentFile() {
    if (!activeFileId) return;
    const { share_id } = await api.shareFile(activeFileId);
    const url = location.origin + '/s/' + share_id;
    modalTitle.textContent = 'Share Link';
    modalBody.innerHTML = `<div class="share-url-box"><input type="text" id="share-url" value="${url}" readonly><button id="btn-copy-share">Copy</button></div><p class="share-info">Anyone with this link can view and fork a copy of this document.</p>`;
    modalOverlay.classList.add('show');
    $('#btn-copy-share').addEventListener('click', () => { navigator.clipboard.writeText(url).then(() => { $('#btn-copy-share').textContent = 'Copied!'; setTimeout(() => { $('#btn-copy-share').textContent = 'Copy'; }, 2000); }); });
  }

  // ===== Shared view =====
  async function checkSharedView() {
    const match = location.pathname.match(/^\/s\/(.+)$/); if (!match) return false;
    const file = await api.getShared(match[1]); if (!file) { showToast('Shared file not found'); return false; }
    isSharedView = true; cm.setValue(file.content); fileNameInput.value = file.name;
    fileNameInput.readOnly = true; cm.setOption('readOnly', true);
    render();
    $('#shared-banner').style.display = 'block'; $('.main').style.marginTop = '38px';
    sidebar.classList.add('collapsed'); $('#btn-open-sidebar').style.display = 'none';
    $('#btn-fork').addEventListener('click', async () => { await api.forkShared(match[1]); location.href = '/'; });
    $('#btn-close-banner').addEventListener('click', () => { $('#shared-banner').style.display = 'none'; $('.main').style.marginTop = '0'; });
    return true;
  }

  // ===== Toolbar insert helpers =====
  function insertText(text) { cm.replaceSelection(text); cm.focus(); scheduleRender(); scheduleSave(); }
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

    cm.on('changes', () => { scheduleRender(); scheduleSave(); });
    cm.on('cursorActivity', updateCursor);

    fileNameInput.addEventListener('input', () => {
      if (!activeFileId) return; clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => { await api.updateFile(activeFileId, { name: fileNameInput.value }); const f = files.find(x => x.id === activeFileId); if (f) f.name = fileNameInput.value; renderSidebar(); showSaveStatus('Saved'); }, 400);
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
