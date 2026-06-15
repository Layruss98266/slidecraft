/* SlideCraft — feature additions (loaded after app.js).
   Hooks into existing globals: overlays, selectedIdx, currentSlide, NUM_SLIDES,
   canvas, ctx, container, slideImg, gotoSlide, renderOverlays, pushUndo,
   markDirty, showToast, presMode, presSlide, presNavigate, exitPresentation. */
(function () {
'use strict';

// ── Util ───────────────────────────────────────────────────────────────────
function $(id) { return document.getElementById(id); }
function el(tag, attrs, ...children) {
  const e = document.createElement(tag);
  for (const k in (attrs || {})) {
    if (k === 'style' && typeof attrs[k] === 'object') Object.assign(e.style, attrs[k]);
    else if (k.startsWith('on') && typeof attrs[k] === 'function') e.addEventListener(k.slice(2), attrs[k]);
    else if (k === 'class') e.className = attrs[k];
    else if (k === 'html') e.innerHTML = attrs[k];
    else e.setAttribute(k, attrs[k]);
  }
  for (const c of children) {
    if (c == null) continue;
    e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return e;
}
function toast(msg, type) {
  if (typeof showToast === 'function') return showToast(msg, type || 'success');
  console.log('[' + (type || 'info') + ']', msg);
}
async function jpost(url, body) {
  const r = await fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json'},
                              body: body == null ? null : JSON.stringify(body)});
  const text = await r.text();
  try { return {ok: r.ok, status: r.status, data: JSON.parse(text)}; }
  catch (_) { return {ok: r.ok, status: r.status, data: {raw: text}}; }
}
async function jget(url) {
  const r = await fetch(url);
  const text = await r.text();
  try { return {ok: r.ok, status: r.status, data: JSON.parse(text)}; }
  catch (_) { return {ok: r.ok, status: r.status, data: {raw: text}}; }
}

// ── 1. High-contrast theme toggle ──────────────────────────────────────────
const THEME_KEY = 'slidecraft.theme';
function applyTheme(t) {
  document.body.classList.toggle('theme-hc', t === 'hc');
  localStorage.setItem(THEME_KEY, t);
  const btn = $('theme-toggle-btn');
  if (btn) btn.textContent = (t === 'hc') ? '◐ Dark' : '◑ High Contrast';
}
window.toggleHighContrast = function () {
  const cur = localStorage.getItem(THEME_KEY) || 'dark';
  applyTheme(cur === 'hc' ? 'dark' : 'hc');
};
applyTheme(localStorage.getItem(THEME_KEY) || 'dark');

// ── 2. Multi-select + group ops ─────────────────────────────────────────────
window.multiSel = new Set();   // indices of multi-selected overlays
window.toggleMultiSel = function (idx) {
  if (window.multiSel.has(idx)) window.multiSel.delete(idx);
  else window.multiSel.add(idx);
  if (typeof renderOverlays === 'function') renderOverlays();
};

// Wire shift-click on canvas: extend the existing onMouseDown by listening
// in capture phase and forwarding to toggleMultiSel when shift is held.
(function wireShiftClick() {
  const cv = $('overlay-canvas');
  if (!cv) return;
  cv.addEventListener('mousedown', function (e) {
    if (!e.shiftKey) return;
    if (typeof hitTest !== 'function' || typeof normX !== 'function') return;
    const nx = normX(e.clientX), ny = normY(e.clientY);
    const hit = hitTest(nx, ny);
    if (hit < 0) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    window.toggleMultiSel(hit);
  }, true);
})();

window.alignSelected = function (mode) {
  if (typeof overlays === 'undefined' || !overlays.length) return;
  const sel = window.multiSel.size ? [...window.multiSel]
            : (selectedIdx >= 0 ? [selectedIdx] : []);
  if (sel.length < 2 && (mode === 'distribute-h' || mode === 'distribute-v')) {
    return toast('Select 3+ overlays to distribute', 'error');
  }
  if (!sel.length) return toast('Nothing selected', 'error');
  if (typeof pushUndo === 'function') pushUndo();
  const items = sel.map(i => overlays[i]).filter(Boolean);
  const xs = items.map(o => o.x), ys = items.map(o => o.y);
  const rs = items.map(o => o.x + o.w), bs = items.map(o => o.y + o.h);
  const minX = Math.min(...xs), maxR = Math.max(...rs);
  const minY = Math.min(...ys), maxB = Math.max(...bs);
  switch (mode) {
    case 'left':    items.forEach(o => o.x = minX); break;
    case 'right':   items.forEach(o => o.x = maxR - o.w); break;
    case 'center-h':{const cx = (minX + maxR) / 2;
                     items.forEach(o => o.x = cx - o.w / 2); break;}
    case 'top':     items.forEach(o => o.y = minY); break;
    case 'bottom':  items.forEach(o => o.y = maxB - o.h); break;
    case 'center-v':{const cy = (minY + maxB) / 2;
                     items.forEach(o => o.y = cy - o.h / 2); break;}
    case 'distribute-h': {
      const sorted = [...items].sort((a, b) => a.x - b.x);
      const span = (sorted[sorted.length - 1].x + sorted[sorted.length - 1].w) - sorted[0].x;
      const totalW = sorted.reduce((s, o) => s + o.w, 0);
      const gap = (span - totalW) / (sorted.length - 1);
      let cur = sorted[0].x;
      sorted.forEach(o => { o.x = cur; cur += o.w + gap; });
      break;
    }
    case 'distribute-v': {
      const sorted = [...items].sort((a, b) => a.y - b.y);
      const span = (sorted[sorted.length - 1].y + sorted[sorted.length - 1].h) - sorted[0].y;
      const totalH = sorted.reduce((s, o) => s + o.h, 0);
      const gap = (span - totalH) / (sorted.length - 1);
      let cur = sorted[0].y;
      sorted.forEach(o => { o.y = cur; cur += o.h + gap; });
      break;
    }
  }
  if (typeof renderOverlays === 'function') renderOverlays();
  if (typeof markDirty === 'function') markDirty();
};

window.deleteMultiSel = function () {
  if (!window.multiSel.size) return;
  if (typeof pushUndo === 'function') pushUndo();
  const sorted = [...window.multiSel].sort((a, b) => b - a);
  sorted.forEach(i => overlays.splice(i, 1));
  window.multiSel.clear();
  if (typeof deselectOverlay === 'function') deselectOverlay();
  if (typeof renderOverlays === 'function') renderOverlays();
  if (typeof markDirty === 'function') markDirty();
};

// ── 3. Guides / rulers overlay (toggle) ─────────────────────────────────────
window.guidesEnabled = false;
window.toggleGuides = function () {
  window.guidesEnabled = !window.guidesEnabled;
  document.body.classList.toggle('guides-on', window.guidesEnabled);
  toast(window.guidesEnabled ? 'Guides on' : 'Guides off');
  if (typeof renderOverlays === 'function') renderOverlays();
};

// Hook into canvas render after main app draws — re-draw rulers/guides.
(function wireGuides() {
  const _origRender = window.renderOverlays;
  if (typeof _origRender !== 'function') return;
  window.renderOverlays = function () {
    _origRender.apply(this, arguments);
    if (!window.guidesEnabled) return;
    const cv = $('overlay-canvas');
    if (!cv) return;
    const c = cv.getContext('2d');
    c.save();
    c.strokeStyle = 'rgba(167, 139, 250, 0.4)';
    c.lineWidth = 1;
    // Center cross + thirds
    [0.5].forEach(f => {
      c.beginPath(); c.moveTo(cv.width * f, 0); c.lineTo(cv.width * f, cv.height); c.stroke();
      c.beginPath(); c.moveTo(0, cv.height * f); c.lineTo(cv.width, cv.height * f); c.stroke();
    });
    c.strokeStyle = 'rgba(99, 102, 241, 0.25)';
    [1/3, 2/3].forEach(f => {
      c.beginPath(); c.moveTo(cv.width * f, 0); c.lineTo(cv.width * f, cv.height); c.stroke();
      c.beginPath(); c.moveTo(0, cv.height * f); c.lineTo(cv.width, cv.height * f); c.stroke();
    });
    // Highlight multi-selected with dashed box
    if (window.multiSel && window.multiSel.size && typeof overlays !== 'undefined') {
      c.setLineDash([6, 4]);
      c.strokeStyle = '#A78BFA';
      c.lineWidth = 2;
      window.multiSel.forEach(i => {
        const o = overlays[i]; if (!o) return;
        c.strokeRect(o.x * cv.width, o.y * cv.height, o.w * cv.width, o.h * cv.height);
      });
      c.setLineDash([]);
    }
    c.restore();
  };
})();

// ── 4. Auto-save heartbeat (every 8s if dirty) ─────────────────────────────
let _autoSaveTimer = null;
function startAutoSave() {
  if (_autoSaveTimer) clearInterval(_autoSaveTimer);
  _autoSaveTimer = setInterval(async () => {
    if (typeof dirty === 'undefined' || !dirty) return;
    try {
      await jpost('/api/autosave', {
        slide: typeof currentSlide !== 'undefined' ? currentSlide : 1,
        overlays: typeof overlays !== 'undefined' ? overlays : [],
        ts: Date.now(),
      });
    } catch (_) { /* swallow */ }
  }, 8000);
}
window.addEventListener('load', startAutoSave);

// ── 5. Slide transitions in presentation mode ──────────────────────────────
window.presTransition = localStorage.getItem('slidecraft.transition') || 'fade';
window.setPresTransition = function (t) {
  window.presTransition = t;
  localStorage.setItem('slidecraft.transition', t);
  toast('Transition: ' + t);
};

// Override presNavigate to inject CSS animation, if present.
(function wireTransitions() {
  const orig = window.presNavigate;
  if (typeof orig !== 'function') return;
  window.presNavigate = function (dir) {
    const node = $('pres-canvas');
    if (node) {
      const t = window.presTransition || 'fade';
      node.classList.remove('pres-fade', 'pres-slide', 'pres-zoom');
      void node.offsetWidth;  // reflow
      node.classList.add('pres-' + t);
    }
    return orig.apply(this, arguments);
  };
})();

// ── 6. Laser pointer in presentation mode ──────────────────────────────────
(function wireLaser() {
  const stage = $('presentation-mode');
  if (!stage) return;
  let laser = null;
  let laserOn = false;
  function ensureLaser() {
    if (laser) return laser;
    laser = el('div', {id: 'laser-dot'});
    stage.appendChild(laser);
    return laser;
  }
  document.addEventListener('keydown', e => {
    if (typeof presMode === 'undefined' || !presMode) return;
    if (e.key === 'l' || e.key === 'L') {
      laserOn = !laserOn;
      ensureLaser().style.display = laserOn ? 'block' : 'none';
      toast(laserOn ? 'Laser on (L to toggle, move mouse)' : 'Laser off');
    }
  });
  stage.addEventListener('mousemove', e => {
    if (!laserOn || !laser) return;
    laser.style.left = e.clientX + 'px';
    laser.style.top  = e.clientY + 'px';
  });
})();

// ── 7. Speaker notes pane (lives in right panel) ───────────────────────────
function _notesEl() { return $('feat-notes-textarea') || $('notes-text'); }
window.loadSpeakerNotes = async function () {
  const ta = _notesEl();
  if (!ta || typeof currentSlide === 'undefined') return;
  const r = await jget('/api/notes/' + currentSlide);
  if (r.ok) ta.value = r.data.notes || '';
};
window.saveSpeakerNotes = async function () {
  const ta = _notesEl();
  if (!ta || typeof currentSlide === 'undefined') return;
  await jpost('/api/notes/' + currentSlide, {notes: ta.value});
  toast('Notes saved');
};
document.addEventListener('blur', e => {
  if (e.target && (e.target.id === 'feat-notes-textarea' || e.target.id === 'notes-text')) {
    window.saveSpeakerNotes();
  }
}, true);

// Reload notes when slide changes — wrap gotoSlide
(function wireNotesReload() {
  const orig = window.gotoSlide;
  if (typeof orig !== 'function') return;
  window.gotoSlide = function () {
    const r = orig.apply(this, arguments);
    setTimeout(window.loadSpeakerNotes, 100);
    setTimeout(window.loadSlidePalette, 100);
    return r;
  };
})();

// ── 8. Palette extraction display ──────────────────────────────────────────
window.loadSlidePalette = async function () {
  const box = $('feat-palette');
  if (!box || typeof currentSlide === 'undefined') return;
  box.innerHTML = '<span style="color:var(--text3);font-size:11px">Loading…</span>';
  const r = await jget('/api/palette/' + currentSlide);
  if (!r.ok) { box.innerHTML = ''; return; }
  box.innerHTML = '';
  (r.data.colors || []).forEach(c => {
    const s = el('button', {
      class: 'palette-swatch', title: c + ' (click to copy)',
      style: {background: c},
      onclick: () => { navigator.clipboard.writeText(c); toast('Copied ' + c); },
    });
    box.appendChild(s);
  });
};
window.loadDeckPalette = async function () {
  const r = await jget('/api/palette/deck');
  if (r.ok) {
    alert('Deck palette:\n' + (r.data.colors || []).join('\n'));
  }
};

// ── 9. Master slide / theme ────────────────────────────────────────────────
window.openMasterSlide = async function () {
  const modal = $('master-modal');
  if (!modal) return;
  const r = await jget('/api/master');
  const m = r.data || {};
  $('master-header').value         = m.header || '';
  $('master-footer').value         = m.footer || '';
  $('master-pagenum').checked      = !!m.showPageNumbers;
  $('master-primary').value        = m.primaryColor || '#2563EB';
  $('master-accent').value         = m.accentColor || '#A78BFA';
  modal.classList.add('show');
};
window.saveMasterSlide = async function () {
  const body = {
    header:          $('master-header').value,
    footer:          $('master-footer').value,
    showPageNumbers: $('master-pagenum').checked,
    primaryColor:    $('master-primary').value,
    accentColor:     $('master-accent').value,
    fontFamily:      'Inter',
    logoDataUrl:     '',
  };
  const r = await jpost('/api/master', body);
  if (r.ok) {
    document.documentElement.style.setProperty('--accent', body.primaryColor);
    document.documentElement.style.setProperty('--accent2', body.accentColor);
    $('master-modal').classList.remove('show');
    toast('Master saved — apply via "Apply Master" to bake into all slides');
  }
};
window.applyMasterToAllSlides = async function () {
  // Add header/footer/page-number as text overlays to every slide.
  const r = await jget('/api/master');
  const m = r.data || {};
  if (!m.header && !m.footer && !m.showPageNumbers) {
    return toast('Master is empty', 'error');
  }
  if (!confirm('Apply master to ALL ' + (typeof NUM_SLIDES !== 'undefined' ? NUM_SLIDES : '') + ' slides?')) return;
  let count = 0;
  for (let i = 1; i <= (typeof NUM_SLIDES !== 'undefined' ? NUM_SLIDES : 0); i++) {
    const existing = (await jget('/api/slide/' + i)).data;
    const ovs = (existing.overlays || []).filter(o => !o._master);
    if (m.header) ovs.push({type: 'text', x: 0.04, y: 0.02, w: 0.92, h: 0.06,
                            text: m.header, color: m.primaryColor || '#2563EB',
                            fontSize: 14, fontFamily: 'Inter', bgColor: 'transparent', _master: true});
    if (m.footer) ovs.push({type: 'text', x: 0.04, y: 0.93, w: 0.6, h: 0.06,
                            text: m.footer, color: m.primaryColor || '#2563EB',
                            fontSize: 12, fontFamily: 'Inter', bgColor: 'transparent', _master: true});
    if (m.showPageNumbers) ovs.push({type: 'text', x: 0.88, y: 0.93, w: 0.1, h: 0.06,
                            text: i + ' / ' + NUM_SLIDES, color: m.primaryColor || '#2563EB',
                            fontSize: 12, fontFamily: 'Inter', bgColor: 'transparent', _master: true});
    await jpost('/api/slide/' + i, {overlays: ovs, notes: existing.notes || ''});
    count++;
  }
  toast('Applied master to ' + count + ' slides');
  if (typeof gotoSlide === 'function') gotoSlide(currentSlide);
};

// ── 10. Background remover ─────────────────────────────────────────────────
window.removeBgFromSelected = async function () {
  if (typeof selectedIdx === 'undefined' || selectedIdx < 0) return toast('Select an image overlay', 'error');
  const ov = overlays[selectedIdx];
  if (!ov || ov.type !== 'image' || !ov.src) return toast('Select an image overlay', 'error');
  toast('Removing background…');
  const r = await jpost('/api/image/remove-bg', {dataUrl: ov.src});
  if (!r.ok) return toast(r.data.error || 'Failed', 'error');
  if (typeof pushUndo === 'function') pushUndo();
  ov.src = r.data.dataUrl;
  if (typeof preloadSingleImage === 'function') preloadSingleImage(selectedIdx);
  setTimeout(() => {
    if (typeof renderOverlays === 'function') renderOverlays();
    if (typeof markDirty === 'function') markDirty();
  }, 250);
  toast('Background removed');
};

// ── 11. YouTube/Vimeo/Loom embed overlay ───────────────────────────────────
window.addEmbedOverlay = async function () {
  const url = prompt('Paste a YouTube, Vimeo, or Loom URL:');
  if (!url) return;
  const r = await jpost('/api/embed/validate', {url: url});
  if (!r.ok) return toast(r.data.error || 'Bad URL', 'error');
  if (typeof pushUndo === 'function') pushUndo();
  overlays.push({
    type: 'embed', kind: r.data.kind, embedUrl: r.data.embedUrl,
    x: 0.2, y: 0.2, w: 0.6, h: 0.5, opacity: 1,
  });
  if (typeof selectOverlay === 'function') selectOverlay(overlays.length - 1);
  if (typeof markDirty === 'function') markDirty();
  toast('Embed added — visible in presentation mode');
};

// ── 12. Audio narration per slide ──────────────────────────────────────────
window.uploadSlideAudio = function () {
  const inp = el('input', {type: 'file', accept: 'audio/*'});
  inp.onchange = async () => {
    if (!inp.files[0]) return;
    const fd = new FormData();
    fd.append('file', inp.files[0]);
    const r = await fetch('/api/audio/' + currentSlide, {method: 'POST', body: fd});
    if (r.ok) toast('Audio added to slide ' + currentSlide);
    else toast('Upload failed', 'error');
  };
  inp.click();
};
window.deleteSlideAudio = async function () {
  await fetch('/api/audio/' + currentSlide, {method: 'DELETE'});
  toast('Audio removed');
};

// In presentation mode, auto-play audio if present (re-wrap presNavigate)
(function wirePresAudio() {
  let audio = null;
  const orig = window.presNavigate;
  if (typeof orig !== 'function') return;
  window.presNavigate = function () {
    const r = orig.apply(this, arguments);
    if (audio) { try { audio.pause(); } catch (_) {} audio = null; }
    if (typeof presMode !== 'undefined' && presMode && typeof presSlide !== 'undefined') {
      audio = new Audio('/api/audio/' + presSlide);
      audio.play().catch(() => { /* no audio for this slide */ });
    }
    return r;
  };
})();

// ── 13. Video → slides ──────────────────────────────────────────────────────
window.videoToSlides = function () {
  const inp = el('input', {type: 'file', accept: 'video/*'});
  inp.onchange = async () => {
    if (!inp.files[0]) return;
    if (!confirm('Replace current deck with scenes extracted from this video?')) return;
    const fd = new FormData();
    fd.append('file', inp.files[0]);
    fd.append('threshold', '30');
    fd.append('maxSlides', '50');
    toast('Extracting scenes — may take a minute…');
    const r = await fetch('/api/video-to-slides', {method: 'POST', body: fd});
    const d = await r.json();
    if (r.ok) {
      toast('Got ' + d.num_slides + ' slides — reloading');
      setTimeout(() => location.reload(), 800);
    } else {
      toast(d.error || 'Failed', 'error');
    }
  };
  inp.click();
};

// ── 14. Thumbnail virtualization for huge decks (>50 slides) ───────────────
window.virtualizeThumbs = function () {
  const strip = document.querySelector('.thumb-strip');
  if (!strip) return;
  if (strip.children.length < 50) return;
  const io = new IntersectionObserver(entries => {
    entries.forEach(e => {
      const img = e.target.querySelector('img');
      if (!img) return;
      if (e.isIntersecting && img.dataset.src && !img.src) {
        img.src = img.dataset.src;
      }
    });
  }, {root: strip, rootMargin: '600px'});
  Array.from(strip.children).forEach(thumb => {
    const img = thumb.querySelector('img');
    if (img && img.src) {
      img.dataset.src = img.src;
      img.removeAttribute('src');
    }
    io.observe(thumb);
  });
  toast('Virtualized ' + strip.children.length + ' thumbnails');
};

// ── 15. AI: rewrite / alt-text / slide-from-prompt ─────────────────────────
window.aiRewrite = async function (mode) {
  if (typeof selectedIdx === 'undefined' || selectedIdx < 0) return toast('Select a text overlay', 'error');
  const ov = overlays[selectedIdx];
  if (!ov || ov.type !== 'text') return toast('Select a text overlay', 'error');
  let lang = '';
  if (mode === 'translate') {
    lang = prompt('Translate to which language? (e.g. Spanish, Hindi, Japanese)') || '';
    if (!lang) return;
  }
  toast('Asking local LLM…');
  const r = await jpost('/api/ai/rewrite', {text: ov.text || '', mode: mode, targetLang: lang});
  if (!r.ok) return toast(r.data.error || r.data.hint || 'Failed (is Ollama running?)', 'error');
  if (typeof pushUndo === 'function') pushUndo();
  ov.text = r.data.text;
  if (typeof renderOverlays === 'function') renderOverlays();
  if (typeof markDirty === 'function') markDirty();
  if (typeof updatePropsForm === 'function') updatePropsForm();
};
window.aiAltText = async function () {
  toast('Generating alt-text via vision LLM…');
  const r = await jpost('/api/ai/alt-text', {slide: currentSlide});
  if (!r.ok) return toast(r.data.error || 'Failed', 'error');
  alert('Alt-text for slide ' + currentSlide + ':\n\n' + r.data.altText);
};
window.aiSlideFromPrompt = async function () {
  const topic = prompt('Topic for new slides:');
  if (!topic) return;
  const count = parseInt(prompt('How many slides? (1-10)', '5'), 10) || 5;
  toast('Generating ' + count + ' slides via local LLM…');
  const r = await jpost('/api/ai/slide-from-prompt', {topic: topic, count: count});
  if (!r.ok) return toast(r.data.error || 'Failed', 'error');
  // Show results as text — user can copy into slides
  const txt = (r.data.slides || []).map((s, i) =>
    '── Slide ' + (i + 1) + ' ──\n' + (s.title || '') + '\n\n' +
    (s.bullets || []).map(b => ' • ' + b).join('\n')
  ).join('\n\n');
  const w = window.open('', '_blank');
  if (w) {
    w.document.write('<pre style="font:14px monospace;padding:20px;background:#0f172a;color:#e2e8f0;min-height:100vh">' +
                     txt.replace(/[<>&]/g, m => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[m])) + '</pre>');
  } else {
    alert(txt);
  }
};

// ── 16. Portable .slidecraft import/export ─────────────────────────────────
window.exportSlidecraft = async function () {
  const r = await fetch('/api/deck/export-portable', {method: 'POST'});
  if (!r.ok) return toast('Export failed', 'error');
  const blob = await r.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'deck.slidecraft';
  a.click(); URL.revokeObjectURL(url);
};
window.importSlidecraft = function () {
  const inp = el('input', {type: 'file', accept: '.slidecraft'});
  inp.onchange = async () => {
    if (!inp.files[0]) return;
    if (!confirm('Replace current deck with the imported archive?')) return;
    const fd = new FormData();
    fd.append('file', inp.files[0]);
    const r = await fetch('/api/deck/import-portable', {method: 'POST', body: fd});
    const d = await r.json();
    if (r.ok) { toast('Imported ' + d.num_slides + ' slides'); setTimeout(() => location.reload(), 800); }
    else toast(d.error || 'Failed', 'error');
  };
  inp.click();
};

// ── 17. Google Slides export ───────────────────────────────────────────────
window.exportToGoogleSlides = async function () {
  toast('Uploading to Google Slides…');
  const r = await jpost('/api/export/gslides', {});
  if (!r.ok) return toast(r.data.error || r.data.hint || 'Not configured — see app_gslides.py', 'error');
  const url = r.data.url;
  if (confirm('Done! Open in Google Slides?\n\n' + url)) window.open(url, '_blank');
};

// ── 18. Keyboard shortcuts for new features ────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' ||
      e.target.isContentEditable) return;
  // Ctrl+Shift+H — high contrast
  if (e.ctrlKey && e.shiftKey && (e.key === 'h' || e.key === 'H')) {
    e.preventDefault(); window.toggleHighContrast();
  }
  // Ctrl+G — guides
  if (e.ctrlKey && !e.shiftKey && (e.key === "'" || e.key === ';')) {
    e.preventDefault(); window.toggleGuides();
  }
  // Align shortcuts: only if multi-selected
  if (window.multiSel && window.multiSel.size >= 2 && e.altKey) {
    const map = {ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'top', ArrowDown: 'bottom'};
    if (map[e.key]) { e.preventDefault(); window.alignSelected(map[e.key]); }
  }
});

// ── 19. Auth status badge in header (if enabled) ───────────────────────────
(async function showAuthBadge() {
  try {
    const r = await jget('/auth/status');
    if (!r.ok || !r.data.enabled) return;
    const badge = $('auth-badge');
    if (!badge) return;
    if (r.data.user) {
      badge.style.display = 'flex';
      badge.innerHTML = '<span>' + (r.data.user.email || '') + '</span>' +
                        '<a href="/auth/logout" style="margin-left:8px;color:var(--accent2)">Logout</a>';
    }
  } catch (_) { /* not enabled */ }
})();

// Initial loads
window.addEventListener('load', () => {
  setTimeout(() => {
    window.loadSpeakerNotes && window.loadSpeakerNotes();
    window.loadSlidePalette && window.loadSlidePalette();
    if (typeof NUM_SLIDES !== 'undefined' && NUM_SLIDES > 50) window.virtualizeThumbs();
  }, 300);
});

})();
