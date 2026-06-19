// ══════════════════════════════════════════════════════════════════════════
// HTML escaping (XSS prevention for innerHTML interpolation)
// ══════════════════════════════════════════════════════════════════════════
function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function escapeAttr(s) { return escapeHtml(s); }
function escapeJs(s) {
  return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/</g, '\\x3c');
}

// ══════════════════════════════════════════════════════════════════════════
// STATE
// ══════════════════════════════════════════════════════════════════════════
const NUM_SLIDES = window.NUM_SLIDES || 0;
let currentSlide = 1;
let overlays = [];
let selectedIdx = -1;
let selectedIdxSet = new Set();
let currentTool = 'select';
let isDragging = false;
let isDrawing = false;
let drawStart = null;
let dragOffset = { x: 0, y: 0 };
let dirty = false;
let zoom = 70;

// Undo/Redo stacks (per slide, reset on nav)
let undoStack = [];
let redoStack = [];
const MAX_UNDO = 50;

// Resize handles
let resizing = null; // {handle:'nw'|'n'|'ne'|'e'|'se'|'s'|'sw'|'w', startX, startY, origOverlay}

// Snap grid
let gridEnabled = false;

// OCR regions
let ocrRegions = [];

// Clipboard for copy/paste
let clipboardOverlay = null;

// Presentation mode
let presMode = false;
let presSlide = 1;

// Image cache for overlay images
const imageCache = {};

// Context menu
let ctxTarget = -1;

const canvas  = document.getElementById('overlay-canvas');
const ctx     = canvas.getContext('2d');
const slideImg = document.getElementById('slide-img');
const container = document.getElementById('slide-container');

// ══════════════════════════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════════════════════════
window.addEventListener('load', () => {
  let startSlide = 1;
  try {
    const saved = parseInt(sessionStorage.getItem('current_slide') || '1', 10);
    if (saved >= 1) startSlide = saved;
    sessionStorage.removeItem('current_slide');
  } catch (e) {}
  const total = parseInt(document.getElementById('slide-total')?.textContent || '1', 10);
  if (startSlide > total) startSlide = total;
  gotoSlide(startSlide);
  setZoom(70);
  initThumbDrag();
  refreshDeckInfo();
  adaptToScreen();
});

window.addEventListener('beforeunload', e => {
  if (dirty) { e.preventDefault(); e.returnValue = ''; }
});

// Keep the overlay canvas aligned to the slide as the window resizes,
// so overlays don't drift when the user shrinks/expands the browser.
let _resizeRaf = null;
window.addEventListener('resize', () => {
  if (_resizeRaf) cancelAnimationFrame(_resizeRaf);
  _resizeRaf = requestAnimationFrame(() => {
    _resizeRaf = null;
    resizeCanvas();
    renderOverlays();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// UNDO / REDO
// ══════════════════════════════════════════════════════════════════════════
// Server-side undo/redo state (refreshed from /api/ops/state)
let _serverUndoState = { can_undo: false, can_redo: false,
                         undo_label: null, redo_label: null };

function pushUndo() {
  undoStack.push(JSON.stringify(overlays));
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack = [];
  updateUndoButtons();
}

async function undo() {
  // Prefer client-side overlay undo if available — it's instant and the
  // user's most recent action is most likely a canvas edit.
  if (undoStack.length > 0) {
    redoStack.push(JSON.stringify(overlays));
    overlays = JSON.parse(undoStack.pop());
    selectedIdx = -1;
    renderOverlayList(); renderOverlays(); hidePropsForm(); markDirty();
    updateUndoButtons();
    return;
  }
  // Refresh server state in case actions happened that didn't touch the badge
  await refreshServerUndoState();
  // Fall back to server-op undo (filters, watermarks, crop, bake, etc.)
  if (!_serverUndoState.can_undo) return;
  showLoading('Undoing...');
  try {
    const resp = await fetch('/api/ops/undo', { method: 'POST' });
    const data = await resp.json();
    hideLoading();
    if (data.ok) {
      reloadAllSlides();
      // Refresh per-slide overlay state from server (data.json was rewritten)
      gotoSlide(currentSlide);
      refreshAppliedBadge();
      await refreshServerUndoState();
      // Reset filter sliders to neutral — server image has reverted
      if (typeof _fxWrite === 'function' && typeof FX_DEFAULTS !== 'undefined') {
        _fxWrite(FX_DEFAULTS); updateFxLive();
      }
      showToast('Undid: ' + (data.text || data.kind || 'last action'), 'success');
    } else if (data.reason) {
      showToast(data.reason, 'info');
    } else {
      showToast(data.error || 'Undo failed', 'error');
    }
  } catch (e) {
    hideLoading();
    showToast('Undo error: ' + e.message, 'error');
  }
}

async function redo() {
  if (redoStack.length > 0) {
    undoStack.push(JSON.stringify(overlays));
    overlays = JSON.parse(redoStack.pop());
    selectedIdx = -1;
    renderOverlayList(); renderOverlays(); hidePropsForm(); markDirty();
    updateUndoButtons();
    return;
  }
  await refreshServerUndoState();
  if (!_serverUndoState.can_redo) return;
  showLoading('Redoing...');
  try {
    const resp = await fetch('/api/ops/redo', { method: 'POST' });
    const data = await resp.json();
    hideLoading();
    if (data.ok) {
      reloadAllSlides();
      gotoSlide(currentSlide);
      refreshAppliedBadge();
      refreshServerUndoState();
      showToast('Redid: ' + (data.text || data.kind || 'action'), 'success');
    } else if (data.reason) {
      showToast(data.reason, 'info');
    } else {
      showToast(data.error || 'Redo failed', 'error');
    }
  } catch (e) {
    hideLoading();
    showToast('Redo error: ' + e.message, 'error');
  }
}

async function refreshServerUndoState() {
  try {
    const resp = await fetch('/api/ops/state');
    _serverUndoState = await resp.json();
  } catch (e) {
    _serverUndoState = { can_undo: false, can_redo: false };
  }
  updateUndoButtons();
}

function updateUndoButtons() {
  const canUndo = undoStack.length > 0 || _serverUndoState.can_undo;
  const canRedo = redoStack.length > 0 || _serverUndoState.can_redo;
  const undoBtn = document.getElementById('btn-undo');
  const redoBtn = document.getElementById('btn-redo');
  if (undoBtn) {
    undoBtn.classList.toggle('disabled', !canUndo);
    // Tooltip shows next action label so users know what Undo will do
    const lbl = undoStack.length > 0 ? 'Undo overlay edit'
              : (_serverUndoState.undo_label
                  ? 'Undo: ' + _serverUndoState.undo_label
                  : 'Undo (Ctrl+Z)');
    undoBtn.setAttribute('title', lbl);
  }
  if (redoBtn) {
    redoBtn.classList.toggle('disabled', !canRedo);
    const lbl = redoStack.length > 0 ? 'Redo overlay edit'
              : (_serverUndoState.redo_label
                  ? 'Redo: ' + _serverUndoState.redo_label
                  : 'Redo (Ctrl+Y)');
    redoBtn.setAttribute('title', lbl);
  }
}

// Keep the server-side undo/redo state fresh after each destructive action.
window.addEventListener('load', refreshServerUndoState);

// ══════════════════════════════════════════════════════════════════════════
// SLIDE NAVIGATION
// ══════════════════════════════════════════════════════════════════════════
async function gotoSlide(n) {
  if (n < 1 || n > NUM_SLIDES) return;
  if (dirty) await saveCurrentSlide(true);

  // Clear filter CSS preview from the previous slide
  if (typeof clearFxPreviewOnNav === 'function') clearFxPreviewOnNav();

  currentSlide = n;
  const pad = String(n).padStart(2, '0');

  slideImg.style.opacity = '0.5';
  slideImg.src = `/static/slides/slide-${pad}.jpg`;
  slideImg.onload = () => {
    slideImg.style.opacity = '1';
    resizeCanvas();
    renderOverlays();
  };

  document.getElementById('slide-num').textContent = n;
  document.getElementById('slide-nav-label').textContent = `${n} / ${NUM_SLIDES}`;

  document.querySelectorAll('.thumb-item').forEach(t => t.classList.remove('active'));
  document.getElementById(`thumb-${n}`)?.classList.add('active');
  document.getElementById(`thumb-${n}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

  const resp = await fetch(`/api/slide/${n}`);
  const data = await resp.json();
  overlays = data.overlays || [];
  document.getElementById('notes-text').value = data.notes || '';
  selectedIdx = -1;
  dirty = false;
  undoStack = [];
  redoStack = [];
  ocrRegions = [];
  document.getElementById('btn-clear-ocr').style.display = 'none';
  updateUndoButtons();
  updateSaveIndicator();
  renderOverlayList();
  renderOverlays();
  hidePropsForm();
  preloadOverlayImages();
}

// ══════════════════════════════════════════════════════════════════════════
// CANVAS SIZING & ZOOM
// ══════════════════════════════════════════════════════════════════════════
function resizeCanvas() {
  canvas.width  = slideImg.offsetWidth;
  canvas.height = slideImg.offsetHeight;
  canvas.style.width  = slideImg.offsetWidth + 'px';
  canvas.style.height = slideImg.offsetHeight + 'px';
}

function setZoom(val) {
  zoom = +val;
  document.getElementById('zoom-val').textContent = val + '%';
  document.getElementById('zoom-range').value = val;
  const w = Math.round(9.33 * zoom * 1.5);
  container.style.width = w + 'px';
  setTimeout(() => { resizeCanvas(); renderOverlays(); }, 50);
}

function fitToScreen() {
  const vp = document.getElementById('viewport');
  const vpW = vp.clientWidth - 48;
  const vpH = vp.clientHeight - 48;
  const slideAspect = 16 / 9;
  const fitW = vpW;
  const fitH = vpW / slideAspect;
  let targetW;
  if (fitH > vpH) {
    targetW = vpH * slideAspect;
  } else {
    targetW = fitW;
  }
  const newZoom = Math.round(targetW / (9.33 * 1.5));
  setZoom(Math.min(120, Math.max(30, newZoom)));
}

// ══════════════════════════════════════════════════════════════════════════
// TOOL MANAGEMENT
// ══════════════════════════════════════════════════════════════════════════
function setTool(t) {
  currentTool = t;
  ['select','text','rect','cover','circle','line','callout','draw','comment'].forEach(id => {
    document.getElementById('tool-' + id)?.classList.toggle('active', id === t);
  });
  canvas.style.cursor = (t === 'select') ? 'default' : (t === 'draw') ? 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'6\' height=\'6\'%3E%3Ccircle cx=\'3\' cy=\'3\' r=\'3\' fill=\'%2360a5fa\'/%3E%3C/svg%3E") 3 3, crosshair' : (t === 'comment') ? 'cell' : 'crosshair';
}

// ══════════════════════════════════════════════════════════════════════════
// SNAP GRID
// ══════════════════════════════════════════════════════════════════════════
function toggleGrid() {
  gridEnabled = !gridEnabled;
  document.getElementById('btn-grid').classList.toggle('active', gridEnabled);
  renderOverlays();
}

function snapVal(v) {
  if (!gridEnabled) return v;
  return Math.round(v * 20) / 20; // snap to 5%
}

// ══════════════════════════════════════════════════════════════════════════
// CANVAS EVENTS
// ══════════════════════════════════════════════════════════════════════════
canvas.addEventListener('mousedown', onMouseDown);
canvas.addEventListener('mousemove', onMouseMove);
canvas.addEventListener('mouseup',   onMouseUp);
canvas.addEventListener('dblclick',  onDblClick);
canvas.addEventListener('contextmenu', onContextMenu);

function normX(clientX) { const r = canvas.getBoundingClientRect(); return (clientX - r.left) / canvas.width; }
function normY(clientY) { const r = canvas.getBoundingClientRect(); return (clientY - r.top)  / canvas.height; }

function hitTest(nx, ny) {
  for (let i = overlays.length - 1; i >= 0; i--) {
    const o = overlays[i];
    if (nx >= o.x && nx <= o.x + o.w && ny >= o.y && ny <= o.y + o.h) return i;
  }
  return -1;
}

// Resize handle hit test - returns handle name or null
function hitHandle(nx, ny) {
  if (selectedIdx < 0) return null;
  const o = overlays[selectedIdx];
  const hSize = 8 / canvas.width; // handle radius in normalized coords
  const hSizeY = 8 / canvas.height;
  const handles = {
    'nw': [o.x, o.y],
    'n':  [o.x + o.w/2, o.y],
    'ne': [o.x + o.w, o.y],
    'e':  [o.x + o.w, o.y + o.h/2],
    'se': [o.x + o.w, o.y + o.h],
    's':  [o.x + o.w/2, o.y + o.h],
    'sw': [o.x, o.y + o.h],
    'w':  [o.x, o.y + o.h/2],
  };
  for (const [name, [hx, hy]] of Object.entries(handles)) {
    if (Math.abs(nx - hx) < hSize && Math.abs(ny - hy) < hSizeY) return name;
  }
  return null;
}

// Freehand drawing state
let freehandPoints = [];
let isFreehandDrawing = false;

// Comment placement state
let pendingCommentPos = null;

function onMouseDown(e) {
  if (e.button === 2) return; // right-click handled separately
  hideContextMenu();
  const nx = normX(e.clientX), ny = normY(e.clientY);

  if (currentTool === 'comment') {
    // Place comment pin
    pendingCommentPos = { x: nx, y: ny };
    const popup = document.getElementById('comment-popup');
    popup.style.left = e.clientX + 'px';
    popup.style.top = e.clientY + 'px';
    popup.style.display = 'block';
    document.getElementById('comment-input').value = '';
    document.getElementById('comment-input').focus();
    return;
  }

  if (currentTool === 'draw') {
    isFreehandDrawing = true;
    freehandPoints = [{ x: nx, y: ny }];
    return;
  }

  if (currentTool === 'select') {
    // Check resize handles first
    const handle = hitHandle(nx, ny);
    if (handle && selectedIdx >= 0) {
      pushUndo();
      const o = overlays[selectedIdx];
      resizing = { handle, startX: nx, startY: ny, orig: { x: o.x, y: o.y, w: o.w, h: o.h } };
      return;
    }
    const hit = hitTest(nx, ny);
    if (hit >= 0) {
      if (hit !== selectedIdx) pushUndo();
      selectOverlay(hit, e.shiftKey);
      isDragging = true;
      dragOffset = { x: nx - overlays[hit].x, y: ny - overlays[hit].y };
    } else {
      deselectOverlay();
    }
  } else {
    isDrawing = true;
    drawStart = { x: nx, y: ny };
  }
}

function onMouseMove(e) {
  const nx = normX(e.clientX), ny = normY(e.clientY);

  // Freehand drawing
  if (isFreehandDrawing && currentTool === 'draw') {
    freehandPoints.push({ x: nx, y: ny });
    renderOverlays();
    // Draw current freehand path
    ctx.beginPath();
    ctx.moveTo(freehandPoints[0].x * canvas.width, freehandPoints[0].y * canvas.height);
    for (let p = 1; p < freehandPoints.length; p++) {
      ctx.lineTo(freehandPoints[p].x * canvas.width, freehandPoints[p].y * canvas.height);
    }
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
    return;
  }

  // Resize
  if (resizing && selectedIdx >= 0) {
    const o = overlays[selectedIdx];
    const orig = resizing.orig;
    const dx = nx - resizing.startX;
    const dy = ny - resizing.startY;
    const shift = e.shiftKey;
    let newX = orig.x, newY = orig.y, newW = orig.w, newH = orig.h;

    const h = resizing.handle;
    if (h.includes('e')) newW = Math.max(0.02, orig.w + dx);
    if (h.includes('w')) { newW = Math.max(0.02, orig.w - dx); newX = orig.x + dx; }
    if (h.includes('s')) newH = Math.max(0.01, orig.h + dy);
    if (h.includes('n')) { newH = Math.max(0.01, orig.h - dy); newY = orig.y + dy; }

    if (shift && (h === 'nw' || h === 'ne' || h === 'se' || h === 'sw')) {
      const aspect = orig.w / orig.h;
      if (Math.abs(dx) > Math.abs(dy)) {
        newH = newW / aspect;
        if (h.includes('n')) newY = orig.y + orig.h - newH;
      } else {
        newW = newH * aspect;
        if (h.includes('w')) newX = orig.x + orig.w - newW;
      }
    }

    o.x = snapVal(Math.max(0, newX));
    o.y = snapVal(Math.max(0, newY));
    o.w = snapVal(newW);
    o.h = snapVal(newH);
    renderOverlays();
    updatePropsForm();
    markDirty();
    return;
  }

  if (isDragging && selectedIdx >= 0) {
    overlays[selectedIdx].x = snapVal(Math.max(0, nx - dragOffset.x));
    overlays[selectedIdx].y = snapVal(Math.max(0, ny - dragOffset.y));
    renderOverlays();
    updatePropsForm();
    markDirty();
  } else if (isDrawing && drawStart) {
    renderOverlays();
    const x = Math.min(drawStart.x, nx), y = Math.min(drawStart.y, ny);
    const w = Math.abs(nx - drawStart.x), h = Math.abs(ny - drawStart.y);
    ctx.save();
    ctx.strokeStyle = currentTool === 'text' ? '#60a5fa' : currentTool === 'cover' ? '#f87171' : '#fbbf24';
    ctx.lineWidth = 2;
    ctx.setLineDash([6,4]);
    ctx.strokeRect(x * canvas.width, y * canvas.height, w * canvas.width, h * canvas.height);
    ctx.restore();
  } else if (currentTool === 'select') {
    // Change cursor for handles
    const handle = hitHandle(nx, ny);
    if (handle) {
      const cursors = { nw:'nw-resize', n:'n-resize', ne:'ne-resize', e:'e-resize', se:'se-resize', s:'s-resize', sw:'sw-resize', w:'w-resize' };
      canvas.style.cursor = cursors[handle] || 'default';
    } else {
      const hit = hitTest(nx, ny);
      canvas.style.cursor = hit >= 0 ? 'move' : 'default';
    }
  }
}

function onMouseUp(e) {
  // Freehand drawing end
  if (isFreehandDrawing && currentTool === 'draw') {
    isFreehandDrawing = false;
    if (freehandPoints.length > 2) {
      pushUndo();
      // Calculate bounding box for the freehand overlay
      let minX = 1, minY = 1, maxX = 0, maxY = 0;
      freehandPoints.forEach(p => {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      });
      overlays.push({
        type: 'freehand',
        x: minX, y: minY, w: maxX - minX || 0.01, h: maxY - minY || 0.01,
        points: [...freehandPoints],
        color: '#ef4444',
        lineWidth: 3,
        opacity: 1
      });
      selectOverlay(overlays.length - 1);
      renderOverlayList();
      markDirty();
    }
    freehandPoints = [];
    renderOverlays();
    return;
  }

  if (resizing) {
    resizing = null;
    return;
  }

  if (isDragging && selectedIdx >= 0) {
    // drag completed
  }

  if (isDrawing && drawStart) {
    const nx = normX(e.clientX), ny = normY(e.clientY);
    let x = snapVal(Math.min(drawStart.x, nx)), y = snapVal(Math.min(drawStart.y, ny));
    let w = snapVal(Math.abs(nx - drawStart.x)), h = snapVal(Math.abs(ny - drawStart.y));
    if (w > 0.02 && h > 0.01) {
      if (currentTool === 'cover') {
        doCoverTool(x, y, w, h);
      } else {
        pushUndo();
        const ov = createOverlay(currentTool, x, y, w, h);
        overlays.push(ov);
        selectOverlay(overlays.length - 1);
        setTool('select');
        renderOverlayList();
        markDirty();
        if (currentTool === 'text') switchTab('props');
      }
    }
  }
  isDragging = false;
  isDrawing  = false;
  drawStart  = null;
}

function onDblClick(e) {
  const nx = normX(e.clientX), ny = normY(e.clientY);
  const hit = hitTest(nx, ny);
  if (hit >= 0 && overlays[hit].type === 'text') {
    selectOverlay(hit);
    switchTab('props');
    startInlineEdit(hit);
  }
}

function startInlineEdit(idx) {
  const ov = overlays[idx];
  if (!ov || ov.type !== 'text') return;
  // Remove any existing inline editor
  const existing = document.getElementById('inline-editor');
  if (existing) existing.remove();

  const rect = canvas.getBoundingClientRect();
  const x = rect.left + ov.x * canvas.width;
  const y = rect.top + ov.y * canvas.height;
  const w = ov.w * canvas.width;
  const h = ov.h * canvas.height;
  const fs = Math.max(8, Math.round((ov.fontSize || 18) * (canvas.width / 933)));

  const div = document.createElement('div');
  div.id = 'inline-editor';
  div.contentEditable = true;
  div.style.cssText = `
    position:fixed; left:${x}px; top:${y}px; width:${w}px; min-height:${h}px;
    font-size:${fs}px; font-family:'${ov.fontFamily || 'Segoe UI'}', sans-serif;
    font-weight:${ov.bold ? 'bold' : 'normal'}; font-style:${ov.italic ? 'italic' : 'normal'};
    color:${ov.color || '#fff'}; text-align:${ov.align || 'left'};
    background:${ov.bgColor && ov.bgColor !== 'transparent' ? ov.bgColor : 'rgba(0,0,0,0.5)'};
    border:2px solid var(--accent); border-radius:4px;
    padding:8px; outline:none; z-index:100; overflow:auto;
    box-sizing:border-box; white-space:pre-wrap; word-wrap:break-word;
    line-height:${ov.lineHeight || 1.3};
  `;
  div.innerText = ov.text || '';
  document.body.appendChild(div);
  div.focus();

  // Select all text
  const range = document.createRange();
  range.selectNodeContents(div);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  function finishEdit() {
    const newText = div.innerText;
    if (newText !== ov.text) {
      pushUndo();
      overlays[idx].text = newText;
      renderOverlays();
      renderOverlayList();
      markDirty();
      // Update props textarea if visible
      const propText = document.getElementById('prop-text');
      if (propText) propText.value = newText;
    }
    div.remove();
  }

  div.addEventListener('blur', finishEdit);
  div.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      div.removeEventListener('blur', finishEdit);
      div.remove();
    } else if (e.key === 'Enter' && !e.shiftKey) {
      // Allow Shift+Enter for newlines, plain Enter to confirm
    }
    e.stopPropagation(); // Prevent keyboard shortcuts while editing
  });
}

// ══════════════════════════════════════════════════════════════════════════
// OCR CLICK -> check if clicking on an OCR region
// ══════════════════════════════════════════════════════════════════════════
canvas.addEventListener('click', (e) => {
  if (ocrRegions.length === 0 || currentTool !== 'select') return;
  const nx = normX(e.clientX), ny = normY(e.clientY);
  // Check if we clicked on an OCR region (and NOT on an existing overlay)
  if (hitTest(nx, ny) >= 0) return;
  for (const r of ocrRegions) {
    if (nx >= r.x && nx <= r.x + r.w && ny >= r.y && ny <= r.y + r.h) {
      createCoverFromOCR(r);
      break;
    }
  }
});

// Pick the px font-size that, when rendered with the given CSS font, produces
// glyphs roughly matching target_cap_height_px. Uses an offscreen canvas's
// measureText (actualBoundingBoxAscent/Descent if available, else fall back to a
// linear estimate of cap-height ≈ 0.7 × font-size).
function _calibrateFontSizePx(family, bold, italic, target_cap_px) {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  const weight = bold ? '700' : '400';
  const style  = italic ? 'italic' : 'normal';
  let lo = 6, hi = 200, best = Math.max(10, Math.round(target_cap_px / 0.7));
  for (let iter = 0; iter < 12 && lo <= hi; iter++) {
    const mid = (lo + hi) >> 1;
    ctx.font = `${style} ${weight} ${mid}px "${family}", sans-serif`;
    const m = ctx.measureText('Hg');
    let renderedCap;
    if (m.actualBoundingBoxAscent != null && m.actualBoundingBoxDescent != null) {
      renderedCap = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
    } else {
      renderedCap = mid * 0.72;
    }
    if (Math.abs(renderedCap - target_cap_px) < 1) { best = mid; break; }
    if (renderedCap < target_cap_px) { lo = mid + 1; best = mid; }
    else { hi = mid - 1; best = mid; }
  }
  return Math.max(8, Math.min(200, best));
}

const _OCR_FONT_CANDIDATES = ['Inter','Segoe UI','Calibri','Roboto','Arial','Helvetica'];

// Pick the candidate font whose average glyph width (per the OCR region's
// text + width) best matches what the original drew. Falls back to Arial.
function _guessFontFamily(text, target_total_width_px, target_cap_px, bold, italic) {
  if (!text || target_total_width_px <= 0) return 'Arial';
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  const weight = bold ? '700' : '400';
  const style  = italic ? 'italic' : 'normal';
  // Use a size that approximates the original cap height
  const probeSize = Math.max(12, Math.round(target_cap_px / 0.7));
  let best = 'Arial';
  let bestDiff = Infinity;
  for (const fam of _OCR_FONT_CANDIDATES) {
    ctx.font = `${style} ${weight} ${probeSize}px "${fam}", sans-serif`;
    const m = ctx.measureText(text);
    const diff = Math.abs(m.width - target_total_width_px);
    if (diff < bestDiff) { bestDiff = diff; best = fam; }
  }
  return best;
}

async function createCoverFromOCR(region) {
  pushUndo();
  const body = {
    x: Math.round(region.x * 1000) / 1000,
    y: Math.round(region.y * 1000) / 1000,
    w: Math.round(region.w * 1000) / 1000,
    h: Math.round(region.h * 1000) / 1000
  };

  // 1. Sample background/text colour, alignment, cap-height, italic-ness.
  let bgColor = '#ffffff';
  let textColor = '#000000';
  let fontWeight = 'normal';
  let align = 'left';
  let capHeightPx = Math.max(10, Math.round(region.h * 1200 * 0.7));
  let isItalic = false;
  try {
    const resp = await fetch(`/api/sample-color/${currentSlide}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
    if (data.color) bgColor = data.color;
    if (data.textColor) textColor = data.textColor;
    if (data.fontWeight) fontWeight = data.fontWeight;
    if (data.align) align = data.align;
    if (typeof data.cap_height_px === 'number') capHeightPx = data.cap_height_px;
    if (typeof data.is_italic === 'boolean') isItalic = data.is_italic;
  } catch (e) {
    // Non-fatal — we have sane defaults. Warn the user so they know the
    // style match may be off rather than failing silently.
    showToast('Could not sample original style (' + e.message + ') — using defaults', 'info', 3000);
  }

  const isBold = (fontWeight === 'bold' || fontWeight === 'extrabold' || fontWeight === 'semibold');

  // 2. Inpaint the original text region so the background is preserved (no
  //    flat-coloured cover rectangle). Then reload the slide image.
  showLoading('Erasing original text...');
  let inpaintOk = false;
  try {
    const resp = await fetch(`/api/slide/${currentSlide}/inpaint-region`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await resp.json();
    if (!resp.ok || data.error) {
      throw new Error(data.error || `HTTP ${resp.status}`);
    }
    inpaintOk = data.ok === true;
  } catch (e) {
    showToast('Inpaint failed (' + e.message + ') — overlay will sit on top of original text', 'error');
  }
  hideLoading();
  const pad2 = String(currentSlide).padStart(2, '0');
  const newSrc = `/static/slides/slide-${pad2}.jpg?t=${Date.now()}`;
  slideImg.src = newSrc;
  const thumb = document.querySelector(`#thumb-${currentSlide} img`);
  if (thumb) thumb.src = newSrc;

  // 3. Pick a font family by matching glyph widths against the original.
  // region.w is normalised; convert to source-image pixels (slide is 2134px wide
  // by convention). Use the canvas-side equivalent (≈ canvas width × region.w).
  const targetTotalWidthPx = (region.w * (canvas.width || 1280));
  const family = _guessFontFamily(region.text, targetTotalWidthPx,
                                  capHeightPx * (canvas.height || 720) / 1200,
                                  isBold, isItalic);

  // 4. Calibrate fontSize against rendered cap height in the canvas-side scale.
  // The bake step rescales by w/933, so fontSize stored = pixelCap / (w/933).
  // We use canvas.width/933 as the approximate scale factor.
  const canvasScale = (canvas.width || 1280) / 933;
  const canvasSideCapPx = capHeightPx * (canvas.height || 720) / 1200;
  const calibratedPx = _calibrateFontSizePx(family, isBold, isItalic, canvasSideCapPx);
  const fontSize = Math.max(8, Math.min(120, Math.round(calibratedPx / canvasScale)));

  // 5. Position the text overlay exactly at the OCR bbox (no cover rect).
  overlays.push({
    type: 'text',
    x: region.x, y: region.y, w: region.w, h: region.h,
    text: region.text || '',
    fontFamily: family, fontSize,
    color: textColor, bold: isBold, italic: isItalic, underline: false,
    align, verticalAlign: 'center',
    bgColor: 'transparent', opacity: 1,
    letterSpacing: 0, lineHeight: 1.1, textTransform: 'none',
    shadow: false, shadowColor: '#000000', shadowBlur: 4,
    outline: false, outlineColor: '#000000', outlineWidth: 1,
    autoFit: true, listStyle: 'none',
  });
  selectOverlay(overlays.length - 1);
  setTool('select');
  switchTab('props');
  renderOverlayList();
  renderOverlays();
  markDirty();
}

// ══════════════════════════════════════════════════════════════════════════
// COVER & TYPE TOOL
// ══════════════════════════════════════════════════════════════════════════
async function doCoverTool(x, y, w, h) {
  pushUndo();
  const body = { x, y, w, h };
  let bgColor = '#333333';
  let textColor = '#ffffff';
  let fontWeight = 'normal';
  try {
    const resp = await fetch(`/api/sample-color/${currentSlide}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await resp.json();
    if (data.color) bgColor = data.color;
    if (data.textColor) textColor = data.textColor;
    if (data.fontWeight) fontWeight = data.fontWeight;
  } catch (e) {}

  const isBold = (fontWeight === 'bold' || fontWeight === 'extrabold' || fontWeight === 'semibold');

  overlays.push({ type: 'rect', x, y, w, h, fillColor: bgColor, opacity: 1 });
  overlays.push({ type: 'text', x, y, w, h, text: '', fontFamily: 'Arial', fontSize: 18, color: textColor, bold: isBold, italic: false, underline: false, align: 'left', bgColor: 'transparent', opacity: 1, letterSpacing: 0, lineHeight: 1.1, textTransform: 'none', shadow: false, shadowColor: '#000000', shadowBlur: 4, outline: false, outlineColor: '#000000', outlineWidth: 1, autoFit: true, listStyle: 'none' });
  selectOverlay(overlays.length - 1);
  setTool('select');
  switchTab('props');
  renderOverlayList();
  renderOverlays();
  markDirty();
  document.getElementById('prop-text').focus();
}

// ══════════════════════════════════════════════════════════════════════════
// CONTEXT MENU
// ══════════════════════════════════════════════════════════════════════════
function onContextMenu(e) {
  e.preventDefault();
  const nx = normX(e.clientX), ny = normY(e.clientY);
  const hit = hitTest(nx, ny);
  if (hit >= 0) {
    selectOverlay(hit);
    ctxTarget = hit;
  } else {
    ctxTarget = -1;
  }
  const menu = document.getElementById('context-menu');
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';
  menu.classList.add('show');
}

function hideContextMenu() {
  document.getElementById('context-menu').classList.remove('show');
}

function ctxEdit() {
  hideContextMenu();
  if (ctxTarget >= 0 && overlays[ctxTarget]?.type === 'text') {
    selectOverlay(ctxTarget);
    switchTab('props');
    document.getElementById('prop-text').focus();
  }
}

function bringToFront() {
  hideContextMenu();
  if (selectedIdx < 0) return;
  pushUndo();
  const ov = overlays.splice(selectedIdx, 1)[0];
  overlays.push(ov);
  selectedIdx = overlays.length - 1;
  renderOverlayList(); renderOverlays(); markDirty();
}

function sendToBack() {
  hideContextMenu();
  if (selectedIdx < 0) return;
  pushUndo();
  const ov = overlays.splice(selectedIdx, 1)[0];
  overlays.unshift(ov);
  selectedIdx = 0;
  renderOverlayList(); renderOverlays(); markDirty();
}

document.addEventListener('click', (e) => {
  if (!document.getElementById('context-menu').contains(e.target)) {
    hideContextMenu();
  }
});

// ══════════════════════════════════════════════════════════════════════════
// OVERLAY FACTORY
// ══════════════════════════════════════════════════════════════════════════
function createOverlay(type, x, y, w, h) {
  if (type === 'text') return { type:'text', x, y, w, h, text:'New Text', fontFamily:'Segoe UI', fontSize:22, color:'#FFFFFF', bold:true, italic:false, underline:false, align:'left', bgColor:'transparent', opacity:1, letterSpacing:0, lineHeight:1.3, textTransform:'none', shadow:false, shadowColor:'#000000', shadowBlur:4, outline:false, outlineColor:'#000000', outlineWidth:1, autoFit:false, listStyle:'none' };
  if (type === 'rect') return { type:'rect', x, y, w, h, fillColor:'#2563EB', opacity:0.7 };
  if (type === 'circle') return { type:'circle', x, y, w, h, fillColor:'#8b5cf6', strokeColor:'#a78bfa', strokeWidth:2, opacity:0.7 };
  if (type === 'line') return { type:'line', x, y, w, h, strokeColor:'#f59e0b', strokeWidth:3, opacity:1 };
  if (type === 'callout') return { type:'callout', x, y, w, h, text:'Callout', fillColor:'#fbbf24', color:'#000000', fontSize:16, opacity:0.9 };
  return { type, x, y, w, h };
}

function addOverlay(type) {
  pushUndo();
  const ov = createOverlay(type, 0.05, 0.05, 0.4, 0.12);
  overlays.push(ov);
  selectOverlay(overlays.length - 1);
  renderOverlayList();
  renderOverlays();
  switchTab('props');
  markDirty();
}

// ══════════════════════════════════════════════════════════════════════════
// IMAGE OVERLAY
// ══════════════════════════════════════════════════════════════════════════
function addImageOverlay() {
  document.getElementById('image-upload-input').click();
}

function replaceImageOverlay() {
  if (selectedIdx < 0 || overlays[selectedIdx]?.type !== 'image') return;
  document.getElementById('image-upload-input').click();
}

async function handleImageUpload(input) {
  const file = input.files[0];
  if (!file) return;
  const form = new FormData();
  form.append('file', file);
  try {
    const resp = await fetch('/api/upload-image', { method: 'POST', body: form });
    const data = await resp.json();
    if (data.src) {
      // If replacing existing image overlay
      if (selectedIdx >= 0 && overlays[selectedIdx]?.type === 'image') {
        pushUndo();
        overlays[selectedIdx].src = data.src;
        delete imageCache[selectedIdx];
        preloadSingleImage(selectedIdx);
      } else {
        pushUndo();
        // Calculate aspect-correct size
        const aspect = data.w / data.h;
        const ovW = 0.3;
        const ovH = ovW / aspect;
        overlays.push({ type: 'image', x: 0.05, y: 0.05, w: ovW, h: ovH, src: data.src, opacity: 1 });
        preloadSingleImage(overlays.length - 1);
        selectOverlay(overlays.length - 1);
      }
      renderOverlayList();
      renderOverlays();
      markDirty();
    }
  } catch (e) {
    showToast('Image upload failed: ' + e.message, 'error');
  }
  input.value = '';
}

async function removeBgFromSelected() {
  if (selectedIdx < 0 || overlays[selectedIdx]?.type !== 'image') {
    showToast('Select an image overlay first', 'error'); return;
  }
  const ov = overlays[selectedIdx];
  if (!ov.src) { showToast('No image source found', 'error'); return; }
  showToast('Removing background…', 'info');
  try {
    const resp = await fetch('/api/remove-background', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ src: ov.src })
    });
    const data = await resp.json();
    if (data.error) { showToast(data.error, 'error'); return; }
    pushUndo();
    ov.src = data.src;
    delete imageCache[selectedIdx];
    preloadSingleImage(selectedIdx);
    renderOverlays();
    markDirty();
    showToast('Background removed', 'success');
  } catch (e) {
    showToast('Remove BG failed: ' + e.message, 'error');
  }
}

function preloadOverlayImages() {
  overlays.forEach((ov, i) => {
    if (ov.type === 'image' && ov.src) preloadSingleImage(i);
  });
}

function preloadSingleImage(idx) {
  const ov = overlays[idx];
  if (!ov || ov.type !== 'image' || !ov.src) return;
  const img = new Image();
  img.onload = () => { imageCache[idx] = img; renderOverlays(); };
  img.src = ov.src;
}

// ══════════════════════════════════════════════════════════════════════════
// SELECTION
// ══════════════════════════════════════════════════════════════════════════
function selectOverlay(idx, addToSelection) {
  if (addToSelection && selectedIdx >= 0) {
    selectedIdxSet.add(selectedIdx);
    selectedIdxSet.add(idx);
    selectedIdx = idx;
    document.querySelectorAll('.ov-item').forEach((el,i) =>
      el.classList.toggle('selected', selectedIdxSet.has(i) || i === idx));
    showPropsForm(overlays[idx]);
    renderOverlays();
    return;
  }
  selectedIdxSet.clear();
  selectedIdx = idx;
  document.querySelectorAll('.ov-item').forEach((el,i) => el.classList.toggle('selected', i===idx));
  showPropsForm(overlays[idx]);
  renderOverlays();
}

function deselectOverlay() {
  selectedIdx = -1;
  selectedIdxSet.clear();
  document.querySelectorAll('.ov-item').forEach(el => el.classList.remove('selected'));
  hidePropsForm();
  renderOverlays();
}

function deleteSelected() {
  hideContextMenu();
  if (selectedIdx < 0) return;
  pushUndo();
  if (selectedIdxSet.size > 1) {
    const toDelete = new Set(selectedIdxSet);
    overlays = overlays.filter((_, i) => !toDelete.has(i));
    selectedIdxSet.clear();
    selectedIdx = -1;
  } else {
    overlays.splice(selectedIdx, 1);
    selectedIdx = -1;
  }
  renderOverlayList(); renderOverlays(); hidePropsForm(); markDirty();
}

function duplicateSelected() {
  hideContextMenu();
  if (selectedIdx < 0) return;
  pushUndo();
  const clone = JSON.parse(JSON.stringify(overlays[selectedIdx]));
  clone.x += 0.02; clone.y += 0.02;
  overlays.push(clone);
  if (clone.type === 'image') preloadSingleImage(overlays.length - 1);
  selectOverlay(overlays.length - 1);
  renderOverlayList(); renderOverlays(); markDirty();
}

// ══════════════════════════════════════════════════════════════════════════
// RENDERING
// ══════════════════════════════════════════════════════════════════════════
function renderOverlays() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Draw grid if enabled
  if (gridEnabled) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    for (let i = 1; i < 10; i++) {
      const xp = (i / 10) * canvas.width;
      const yp = (i / 10) * canvas.height;
      ctx.beginPath(); ctx.moveTo(xp, 0); ctx.lineTo(xp, canvas.height); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, yp); ctx.lineTo(canvas.width, yp); ctx.stroke();
    }
    ctx.restore();
  }

  // Draw OCR regions
  if (ocrRegions.length > 0) {
    ctx.save();
    ctx.strokeStyle = '#60a5fa';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 3]);
    ocrRegions.forEach(r => {
      ctx.strokeRect(r.x * canvas.width, r.y * canvas.height, r.w * canvas.width, r.h * canvas.height);
    });
    ctx.restore();
  }

  overlays.forEach((ov, i) => {
    const x = ov.x * canvas.width, y = ov.y * canvas.height;
    const w = ov.w * canvas.width, h = ov.h * canvas.height;
    const opacity = ov.opacity ?? 1;
    ctx.globalAlpha = opacity;

    if (ov.type === 'text') {
      if (ov.bgColor && ov.bgColor !== 'transparent') {
        ctx.fillStyle = ov.bgColor;
        ctx.fillRect(x, y, w, h);
      }
      ctx.globalAlpha = opacity;
      let fs = Math.max(8, Math.round((ov.fontSize || 18) * (canvas.width / 933)));
      const weight = ov.bold ? 'bold' : 'normal';
      const style  = ov.italic ? 'italic' : 'normal';
      const ff = ov.fontFamily || 'Segoe UI';
      const lh = ov.lineHeight || 1.3;
      const ls = ov.letterSpacing || 0;
      const scaleRatio = canvas.width / 933;

      // Apply textTransform
      let displayText = ov.text || '';
      const tt = ov.textTransform || 'none';
      if (tt === 'uppercase') displayText = displayText.toUpperCase();
      else if (tt === 'lowercase') displayText = displayText.toLowerCase();
      else if (tt === 'capitalize') displayText = displayText.replace(/\b\w/g, c => c.toUpperCase());

      // Apply listStyle
      const listStyle = ov.listStyle || 'none';
      if (listStyle !== 'none') {
        const rawLines = displayText.split('\n');
        displayText = rawLines.map((ln, idx) => {
          if (listStyle === 'bullet') return '\u2022 ' + ln;
          if (listStyle === 'number') return (idx + 1) + '. ' + ln;
          return ln;
        }).join('\n');
      }

      // AutoFit: reduce font size until text fits box height
      if (ov.autoFit) {
        let testFs = fs;
        while (testFs > 8) {
          ctx.font = `${style} ${weight} ${testFs}px '${ff}', 'Segoe UI', Arial, sans-serif`;
          const testLines = _countWrapLines(ctx, displayText, w - 16, ls * scaleRatio);
          const totalH = testLines * (testFs * lh) + testFs + 16;
          if (totalH <= h) break;
          testFs--;
        }
        fs = testFs;
      }

      ctx.font = `${style} ${weight} ${fs}px '${ff}', 'Segoe UI', Arial, sans-serif`;
      ctx.fillStyle = ov.color || '#fff';
      ctx.textAlign = ov.align || 'left';
      const tx = ov.align === 'center' ? x + w/2 : ov.align === 'right' ? x + w - 8 : x + 8;

      // Vertical alignment within the bbox
      const vAlign = ov.verticalAlign || 'top';
      const totalLines = _countWrapLines(ctx, displayText, w - 16, ls * scaleRatio);
      const blockH = Math.max(0, totalLines * (fs * lh));
      let startTy;
      if (vAlign === 'center')      startTy = y + Math.max(0, (h - blockH) / 2) + fs;
      else if (vAlign === 'bottom') startTy = y + Math.max(0, h - blockH - 8) + fs;
      else                          startTy = y + fs + 8;

      // Shadow
      if (ov.shadow) {
        ctx.shadowColor = ov.shadowColor || '#000000';
        ctx.shadowBlur = ov.shadowBlur || 4;
        ctx.shadowOffsetX = 2;
        ctx.shadowOffsetY = 2;
      }

      // Outline: strokeText before fillText
      if (ov.outline) {
        ctx.lineWidth = ov.outlineWidth || 1;
        ctx.strokeStyle = ov.outlineColor || '#000';
        // We need to stroke each line — done inside wrapText-like loop
        const savedFill = ctx.fillStyle;
        const outlineLines = _getWrapLines(ctx, displayText, w - 16, ls * scaleRatio);
        let oy = startTy;
        for (const ln of outlineLines) {
          if (ls !== 0) {
            _strokeTextWithSpacing(ctx, ln, tx, oy, ls * scaleRatio);
          } else {
            ctx.strokeText(ln, tx, oy);
          }
          oy += fs * lh;
        }
        ctx.fillStyle = savedFill;
      }

      const drawnLines = wrapText(ctx, displayText, tx, startTy, w - 16, fs * lh, { letterSpacing: ls, scale: scaleRatio });

      // Reset shadow
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;

      // Underline
      if (ov.underline && drawnLines) {
        ctx.save();
        ctx.strokeStyle = ov.color || '#fff';
        ctx.lineWidth = Math.max(1, fs / 14);
        for (const dl of drawnLines) {
          const ulY = dl.y + fs * 0.15;
          let ulX = dl.x;
          let ulW = dl.width;
          if (ctx.textAlign === 'center') { ulX = dl.x - ulW / 2; }
          else if (ctx.textAlign === 'right') { ulX = dl.x - ulW; }
          ctx.beginPath();
          ctx.moveTo(ulX, ulY);
          ctx.lineTo(ulX + ulW, ulY);
          ctx.stroke();
        }
        ctx.restore();
      }
    } else if (ov.type === 'rect') {
      ctx.fillStyle = ov.fillColor || '#2563EB';
      ctx.fillRect(x, y, w, h);
    } else if (ov.type === 'image') {
      const cached = imageCache[i];
      if (cached) {
        ctx.drawImage(cached, x, y, w, h);
      } else {
        // Draw placeholder
        ctx.fillStyle = 'rgba(100,100,100,0.3)';
        ctx.fillRect(x, y, w, h);
        ctx.fillStyle = '#aaa';
        ctx.font = '12px Inter';
        ctx.textAlign = 'center';
        ctx.fillText('Loading...', x + w/2, y + h/2);
      }
    } else if (ov.type === 'circle') {
      const rx = w / 2, ry = h / 2;
      ctx.beginPath();
      ctx.ellipse(x + rx, y + ry, rx, ry, 0, 0, Math.PI * 2);
      ctx.fillStyle = ov.fillColor || '#8b5cf6';
      ctx.fill();
      if (ov.strokeColor) {
        ctx.strokeStyle = ov.strokeColor;
        ctx.lineWidth = ov.strokeWidth || 2;
        ctx.stroke();
      }
    } else if (ov.type === 'line') {
      ctx.beginPath();
      ctx.moveTo(x, y + h / 2);
      ctx.lineTo(x + w, y + h / 2);
      ctx.strokeStyle = ov.strokeColor || '#f59e0b';
      ctx.lineWidth = ov.strokeWidth || 3;
      ctx.setLineDash([]);
      ctx.stroke();
      // Arrowhead
      const arrSize = Math.min(12, w * 0.15);
      ctx.beginPath();
      ctx.moveTo(x + w, y + h / 2);
      ctx.lineTo(x + w - arrSize, y + h / 2 - arrSize / 2);
      ctx.lineTo(x + w - arrSize, y + h / 2 + arrSize / 2);
      ctx.closePath();
      ctx.fillStyle = ov.strokeColor || '#f59e0b';
      ctx.fill();
    } else if (ov.type === 'callout') {
      // Rounded rect body
      const r = Math.min(10, w * 0.05, h * 0.1);
      const pointerH = Math.min(15, h * 0.2);
      const bodyH = h - pointerH;
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + w - r, y);
      ctx.quadraticCurveTo(x + w, y, x + w, y + r);
      ctx.lineTo(x + w, y + bodyH - r);
      ctx.quadraticCurveTo(x + w, y + bodyH, x + w - r, y + bodyH);
      // Pointer
      ctx.lineTo(x + w * 0.35, y + bodyH);
      ctx.lineTo(x + w * 0.2, y + h);
      ctx.lineTo(x + w * 0.25, y + bodyH);
      ctx.lineTo(x + r, y + bodyH);
      ctx.quadraticCurveTo(x, y + bodyH, x, y + bodyH - r);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.closePath();
      ctx.fillStyle = ov.fillColor || '#fbbf24';
      ctx.fill();
      // Callout text
      if (ov.text) {
        const cfs = Math.max(8, Math.round((ov.fontSize || 16) * (canvas.width / 933)));
        ctx.font = `600 ${cfs}px 'Inter', sans-serif`;
        ctx.fillStyle = ov.color || '#000';
        ctx.textAlign = 'center';
        ctx.fillText(ov.text, x + w / 2, y + bodyH / 2 + cfs / 3, w - 16);
      }
    } else if (ov.type === 'freehand') {
      if (ov.points && ov.points.length > 1) {
        ctx.beginPath();
        ctx.moveTo(ov.points[0].x * canvas.width, ov.points[0].y * canvas.height);
        for (let p = 1; p < ov.points.length; p++) {
          ctx.lineTo(ov.points[p].x * canvas.width, ov.points[p].y * canvas.height);
        }
        ctx.strokeStyle = ov.color || '#ef4444';
        ctx.lineWidth = ov.lineWidth || 3;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.setLineDash([]);
        ctx.stroke();
      }
    }

    ctx.globalAlpha = 1;

    // Selection handles (8 handles: 4 corners + 4 edges)
    if (i === selectedIdx) {
      ctx.strokeStyle = '#60a5fa';
      ctx.lineWidth = 2;
      ctx.setLineDash([]);
      ctx.strokeRect(x, y, w, h);
      const handles = [
        [x, y], [x + w/2, y], [x + w, y],
        [x + w, y + h/2],
        [x + w, y + h], [x + w/2, y + h], [x, y + h],
        [x, y + h/2]
      ];
      handles.forEach(([hx, hy]) => {
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = '#3b82f6';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(hx, hy, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      });
    }
  });
}

function wrapText(ctx, text, x, y, maxW, lineH, opts) {
  opts = opts || {};
  const letterSpacing = opts.letterSpacing || 0;
  const scale = opts.scale || 1;
  const lsOffset = letterSpacing * scale;

  const words = (text || '').split(' ');
  let line = '';
  const lines = [];
  for (let n = 0; n < words.length; n++) {
    const testLine = line + words[n] + ' ';
    const tw = _measureWithSpacing(ctx, testLine, lsOffset);
    if (tw > maxW && n > 0) {
      lines.push(line);
      line = words[n] + ' ';
    } else { line = testLine; }
  }
  if (line) lines.push(line);

  const drawnLines = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const tw = _measureWithSpacing(ctx, ln, lsOffset);
    if (lsOffset !== 0) {
      _drawTextWithSpacing(ctx, ln, x, y, lsOffset);
    } else {
      ctx.fillText(ln, x, y);
    }
    drawnLines.push({ text: ln, x, y, width: tw });
    y += lineH;
  }
  return drawnLines;
}

function _measureWithSpacing(ctx, text, lsOffset) {
  if (!lsOffset) return ctx.measureText(text).width;
  let w = 0;
  for (let i = 0; i < text.length; i++) {
    w += ctx.measureText(text[i]).width + lsOffset;
  }
  return w;
}

function _drawTextWithSpacing(ctx, text, x, y, lsOffset) {
  let cx = x;
  const align = ctx.textAlign;
  if (align === 'center' || align === 'right') {
    const tw = _measureWithSpacing(ctx, text, lsOffset);
    if (align === 'center') cx = x - tw / 2;
    else cx = x - tw;
    ctx.save(); ctx.textAlign = 'left';
    for (let i = 0; i < text.length; i++) {
      ctx.fillText(text[i], cx, y);
      cx += ctx.measureText(text[i]).width + lsOffset;
    }
    ctx.restore();
  } else {
    for (let i = 0; i < text.length; i++) {
      ctx.fillText(text[i], cx, y);
      cx += ctx.measureText(text[i]).width + lsOffset;
    }
  }
}

function _getWrapLines(ctx, text, maxW, lsOffset) {
  lsOffset = lsOffset || 0;
  const words = (text || '').split(' ');
  let line = '';
  const lines = [];
  for (let n = 0; n < words.length; n++) {
    const testLine = line + words[n] + ' ';
    const tw = _measureWithSpacing(ctx, testLine, lsOffset);
    if (tw > maxW && n > 0) {
      lines.push(line);
      line = words[n] + ' ';
    } else { line = testLine; }
  }
  if (line) lines.push(line);
  return lines;
}

function _countWrapLines(ctx, text, maxW, lsOffset) {
  return _getWrapLines(ctx, text, maxW, lsOffset).length;
}

function _strokeTextWithSpacing(ctx, text, x, y, lsOffset) {
  let cx = x;
  const align = ctx.textAlign;
  if (align === 'center' || align === 'right') {
    const tw = _measureWithSpacing(ctx, text, lsOffset);
    if (align === 'center') cx = x - tw / 2;
    else cx = x - tw;
    ctx.save(); ctx.textAlign = 'left';
    for (let i = 0; i < text.length; i++) {
      ctx.strokeText(text[i], cx, y);
      cx += ctx.measureText(text[i]).width + lsOffset;
    }
    ctx.restore();
  } else {
    for (let i = 0; i < text.length; i++) {
      ctx.strokeText(text[i], cx, y);
      cx += ctx.measureText(text[i]).width + lsOffset;
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════
// OVERLAY LIST (SIDEBAR)
// ══════════════════════════════════════════════════════════════════════════
function renderOverlayList() {
  const list = document.getElementById('ov-list');
  if (overlays.length === 0) {
    list.innerHTML = `<div class="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width:32px;height:32px;opacity:0.3"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
      <div>No overlays yet</div>
      <div style="font-size:11px;margin-top:4px">Use the toolbar to add text or shapes</div>
    </div>`;
    document.getElementById(`thumb-${currentSlide}`)?.classList.remove('has-edits');
    return;
  }
  document.getElementById(`thumb-${currentSlide}`)?.classList.add('has-edits');
  list.innerHTML = overlays.map((ov, i) => {
    const isText = ov.type === 'text';
    const isImage = ov.type === 'image';
    const typeNames = { text:'Text', image:'Image', rect:'Rectangle', circle:'Circle', line:'Arrow/Line', callout:'Callout', freehand:'Freehand' };
    const dotColors = { text: ov.color||'#fff', image:'#a78bfa', rect: ov.fillColor||'#2563EB', circle: ov.fillColor||'#8b5cf6', line: ov.strokeColor||'#f59e0b', callout: ov.fillColor||'#fbbf24', freehand: ov.color||'#ef4444' };
    const dotColor = dotColors[ov.type] || '#888';
    const typeName = typeNames[ov.type] || ov.type;
    const previewRaw = isText ? (ov.text || '--') : isImage ? 'Image overlay' : ov.type === 'callout' ? (ov.text||'Callout') : ov.type === 'freehand' ? `${(ov.points||[]).length} points` : `Fill: ${ov.fillColor || ov.strokeColor || '#2563EB'}`;
    return `
    <div class="ov-item ${i === selectedIdx ? 'selected' : ''}" onclick="selectOverlay(${i})">
      <div class="ov-header">
        <div class="ov-dot" style="background:${escapeAttr(dotColor)}"></div>
        <div class="ov-type">${escapeHtml(typeName)}</div>
      </div>
      <div class="ov-preview">${escapeHtml(previewRaw)}</div>
      <div class="ov-actions">
        <button class="btn btn-glass btn-sm" onclick="event.stopPropagation();selectOverlay(${i});switchTab('props')">Edit</button>
        <button class="btn btn-danger btn-sm" onclick="event.stopPropagation();removeOverlay(${i})">Remove</button>
      </div>
    </div>`;
  }).join('');
}

function removeOverlay(i) {
  pushUndo();
  overlays.splice(i, 1);
  if (selectedIdx === i) { selectedIdx = -1; hidePropsForm(); }
  else if (selectedIdx > i) selectedIdx--;
  renderOverlayList(); renderOverlays(); markDirty();
}

// ══════════════════════════════════════════════════════════════════════════
// PROPS FORM
// ══════════════════════════════════════════════════════════════════════════
function showPropsForm(ov) {
  document.getElementById('props-empty').style.display = 'none';
  document.getElementById('props-form').style.display  = 'block';
  const isText = ov.type === 'text';
  const isImage = ov.type === 'image';
  document.getElementById('field-text').style.display    = isText ? '' : 'none';
  const isShape = ['rect','circle','line','callout','freehand'].includes(ov.type);
  document.getElementById('field-bgcolor').style.display = isText ? '' : 'none';
  document.getElementById('field-fillcolor').style.display = (isShape && !isText && !isImage) ? '' : 'none';
  document.getElementById('field-imgsrc').style.display = isImage ? '' : 'none';

  if (isText) {
    document.getElementById('prop-text').value    = ov.text || '';
    document.getElementById('prop-fontfamily').value = ov.fontFamily || 'Segoe UI';
    document.getElementById('prop-fontsize').value = ov.fontSize || 18;
    document.getElementById('prop-color').value   = ov.color || '#FFFFFF';
    document.getElementById('prop-align').value   = ov.align || 'left';
    const valignEl = document.getElementById('prop-valign');
    if (valignEl) valignEl.value = ov.verticalAlign || 'top';
    document.getElementById('prop-bold').checked  = ov.bold || false;
    document.getElementById('prop-italic').checked = ov.italic || false;
    const noBg = !ov.bgColor || ov.bgColor === 'transparent';
    document.getElementById('prop-nobg').checked  = noBg;
    document.getElementById('prop-bgcolor').value = noBg ? '#1a1d27' : ov.bgColor;
    document.getElementById('prop-underline').checked = ov.underline || false;
    document.getElementById('prop-letterspacing').value = ov.letterSpacing || 0;
    document.getElementById('ls-val').textContent = (ov.letterSpacing || 0) + 'px';
    document.getElementById('prop-lineheight').value = ov.lineHeight || 1.3;
    document.getElementById('lh-val').textContent = (ov.lineHeight || 1.3) + 'x';
    document.getElementById('prop-texttransform').value = ov.textTransform || 'none';
    document.getElementById('prop-liststyle').value = ov.listStyle || 'none';
    document.getElementById('prop-shadow').checked = ov.shadow || false;
    document.getElementById('prop-shadowcolor').value = ov.shadowColor || '#000000';
    document.getElementById('prop-outline').checked = ov.outline || false;
    document.getElementById('prop-outlinecolor').value = ov.outlineColor || '#000000';
    document.getElementById('prop-autofit').checked = ov.autoFit || false;
  } else if (!isImage) {
    document.getElementById('prop-fillcolor').value = ov.fillColor || ov.strokeColor || ov.color || '#2563EB';
  }
  document.getElementById('prop-opacity').value = ov.opacity ?? 1;
  document.getElementById('opacity-val').textContent = Math.round((ov.opacity ?? 1) * 100) + '%';
  document.getElementById('prop-x').value = (ov.x * 100).toFixed(1);
  document.getElementById('prop-y').value = (ov.y * 100).toFixed(1);
  document.getElementById('prop-w').value = (ov.w * 100).toFixed(1);
  document.getElementById('prop-h').value = (ov.h * 100).toFixed(1);
}

function hidePropsForm() {
  document.getElementById('props-empty').style.display = '';
  document.getElementById('props-form').style.display  = 'none';
}

function updateSelectedProp(key, val) {
  if (selectedIdx < 0) return;
  pushUndo();
  overlays[selectedIdx][key] = val;
  renderOverlays(); renderOverlayList(); markDirty();
}

function updateSelectedPos() {
  if (selectedIdx < 0) return;
  pushUndo();
  overlays[selectedIdx].x = parseFloat(document.getElementById('prop-x').value) / 100 || 0;
  overlays[selectedIdx].y = parseFloat(document.getElementById('prop-y').value) / 100 || 0;
  overlays[selectedIdx].w = parseFloat(document.getElementById('prop-w').value) / 100 || 0.1;
  overlays[selectedIdx].h = parseFloat(document.getElementById('prop-h').value) / 100 || 0.05;
  renderOverlays(); markDirty();
}

function toggleNoBg(checked) {
  if (selectedIdx < 0) return;
  pushUndo();
  overlays[selectedIdx].bgColor = checked ? 'transparent' : '#1a1d27';
  renderOverlays(); markDirty();
}

function updatePropsForm() {
  if (selectedIdx < 0) return;
  const ov = overlays[selectedIdx];
  document.getElementById('prop-x').value = (ov.x * 100).toFixed(1);
  document.getElementById('prop-y').value = (ov.y * 100).toFixed(1);
  document.getElementById('prop-w').value = (ov.w * 100).toFixed(1);
  document.getElementById('prop-h').value = (ov.h * 100).toFixed(1);
}

// ══════════════════════════════════════════════════════════════════════════
// TABS
// ══════════════════════════════════════════════════════════════════════════
function switchTab(name) {
  ['overlays','props','notes','filters','comments'].forEach(t => {
    document.getElementById(`panel-${t}`).style.display = t === name ? '' : 'none';
    document.getElementById(`tab-${t}`)?.classList.toggle('active', t === name);
  });
  if (name === 'comments') loadComments();
}

// ══════════════════════════════════════════════════════════════════════════
// PERSISTENCE + AUTO-SAVE INDICATOR
// ══════════════════════════════════════════════════════════════════════════
function markDirty() {
  dirty = true;
  updateSaveIndicator();
}

function updateSaveIndicator() {
  const dot = document.getElementById('save-dot');
  const check = document.getElementById('save-check');
  if (dirty) {
    dot.className = 'save-dot dirty';
    check.className = 'save-check';
  } else {
    dot.className = 'save-dot';
  }
}

function flashSaveCheck() {
  const dot = document.getElementById('save-dot');
  const check = document.getElementById('save-check');
  dot.className = 'save-dot saved';
  check.className = 'save-check show';
  setTimeout(() => {
    dot.className = 'save-dot';
    check.className = 'save-check';
  }, 1500);
}

async function saveCurrentSlide(silent = false) {
  const payload = {
    overlays,
    notes: document.getElementById('notes-text').value
  };
  await fetch(`/api/slide/${currentSlide}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  dirty = false;
  updateSaveIndicator();
  flashSaveCheck();
  if (!silent) showToast('Slide saved!', 'success');
}

async function bakeOverlays() {
  if (overlays.length === 0) {
    showToast('No overlays to apply', 'info');
    return;
  }
  // Save current state first
  await saveCurrentSlide(true);
  showLoading('Applying changes to slide...');
  try {
    const resp = await fetch(`/api/slide/${currentSlide}/bake`, { method: 'POST' });
    const data = await resp.json();
    hideLoading();
    if (data.ok) {
      // Reload the slide image (cache bust) and clear overlays
      overlays = [];
      selectedIdx = -1;
      const pad = String(currentSlide).padStart(2, '0');
      slideImg.src = `/static/slides/slide-${pad}.jpg?t=${Date.now()}`;
      // Also update thumbnail
      const thumb = document.querySelector(`#thumb-${currentSlide} img`);
      if (thumb) thumb.src = slideImg.src;
      renderOverlayList();
      renderOverlays();
      hidePropsForm();
      dirty = false;
      showToast('Changes applied to slide!', 'success');
    } else {
      showToast(data.error || 'Failed to apply', 'error');
    }
  } catch (e) {
    hideLoading();
    showToast('Error: ' + e.message, 'error');
  }
}

async function exportPPTX() {
  await saveCurrentSlide(true);
  showLoading('Exporting PPTX...');
  const resp = await fetch('/api/export', { method: 'POST' });
  hideLoading();
  if (resp.ok) {
    const blob = await resp.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    const basePptx = currentDeckName ? currentDeckName.replace(/\.pptx$/i, '') : 'SlideCraft_Export';
    a.download = basePptx + '_Edited.pptx';
    a.click();
    URL.revokeObjectURL(url);
    showToast('PPTX downloaded!', 'success');
  } else {
    showToast('Export failed', 'error');
  }
}

async function resetAndExport() {
  const msg = 'Reset to the original uploaded PPTX?\n\n' +
    'This will:\n' +
    '  • Restore every slide image to the version uploaded\n' +
    '  • Remove all overlays, notes, comments, and watermarks\n' +
    '  • Then download a clean PPTX of the original\n\n' +
    'A history snapshot is taken first so you can recover the current state from the History modal.';
  if (!confirm(msg)) return;

  showLoading('Restoring originals...');
  let snapshot = null;
  try {
    const resp = await fetch('/api/reset-all', { method: 'POST' });
    const data = await resp.json();
    if (!data.ok) {
      hideLoading();
      showToast(data.error || 'Reset failed', 'error');
      return;
    }
    snapshot = data.snapshot;
  } catch (e) {
    hideLoading();
    showToast('Reset error: ' + e.message, 'error');
    return;
  }

  // Refresh UI to the restored state (no overlays anywhere)
  overlays = [];
  undoStack = []; redoStack = []; updateUndoButtons();
  document.getElementById('notes-text').value = '';
  renderOverlayList();
  renderOverlays();
  reloadAllSlides();
  refreshAppliedBadge();

  // Now download a clean PPTX
  try {
    const expResp = await fetch('/api/export', { method: 'POST' });
    hideLoading();
    if (!expResp.ok) {
      showToast('Reset OK, but export failed — try Export → PowerPoint manually', 'error');
      return;
    }
    const blob = await expResp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'SlideCraft_Original.pptx';
    a.click();
    URL.revokeObjectURL(url);
    showToast('Reset complete — clean PPTX downloaded.', 'success', 6000);
    if (snapshot) {
      const toast = document.getElementById('toast');
      const span = toast && toast.querySelector('span');
      if (span) span.innerHTML += _undoToastAction(snapshot);
    }
  } catch (e) {
    hideLoading();
    showToast('Reset OK, but export failed: ' + e.message, 'error');
  }
}

async function exportPDF() {
  await saveCurrentSlide(true);
  showLoading('Exporting PDF...');
  try {
    const resp = await fetch('/api/export-pdf', { method: 'POST' });
    hideLoading();
    if (resp.ok) {
      const blob = await resp.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      const basePdf = currentDeckName ? currentDeckName.replace(/\.pptx$/i, '') : 'SlideCraft_Export';
    a.download = basePdf + '_Edited.pdf';
      a.click();
      URL.revokeObjectURL(url);
      showToast('PDF downloaded!', 'success');
    } else {
      showToast('PDF export failed', 'error');
    }
  } catch (e) {
    hideLoading();
    showToast('PDF export error: ' + e.message, 'error');
  }
}

// ══════════════════════════════════════════════════════════════════════════
// OCR TEXT DETECTION
// ══════════════════════════════════════════════════════════════════════════
async function detectText() {
  showLoading('Detecting text...');
  try {
    const resp = await fetch(`/api/ocr/${currentSlide}`, { method: 'POST' });
    const data = await resp.json();
    hideLoading();
    if (data.error) {
      showToast(data.error, 'error');
      return;
    }
    if (data.regions && data.regions.length > 0) {
      ocrRegions = data.regions.map(r => ({
        text: r.text,
        x: r.x, y: r.y, w: r.w, h: r.h,
        conf: r.conf
      }));
      document.getElementById('btn-clear-ocr').style.display = '';
      renderOverlays();
      showToast(`Detected ${data.regions.length} text regions`, 'info');
    } else {
      showToast('No text detected', 'info');
    }
  } catch (e) {
    hideLoading();
    showToast('OCR failed: ' + e.message, 'error');
  }
}

function clearOCR() {
  ocrRegions = [];
  document.getElementById('btn-clear-ocr').style.display = 'none';
  renderOverlays();
}

// ══════════════════════════════════════════════════════════════════════════
// TOAST
// ══════════════════════════════════════════════════════════════════════════
function showToast(msg, type = 'success', duration = 2500) {
  const t = document.getElementById('toast');
  const icons = {
    success: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22,4 12,14.01 9,11.01"/></svg>',
    error: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
    info: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'
  };
  t.innerHTML = (icons[type] || icons.info) + `<span>${escapeHtml(msg)}</span>`;
  t.className = `show ${type}`;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.className = '', duration);
}

// ══════════════════════════════════════════════════════════════════════════
// LOADING OVERLAY
// ══════════════════════════════════════════════════════════════════════════
function showLoading(msg = 'Processing...') {
  document.getElementById('loading-text').textContent = msg;
  document.getElementById('loading-overlay').classList.add('active');
}
function hideLoading() {
  document.getElementById('loading-overlay').classList.remove('active');
}

// ══════════════════════════════════════════════════════════════════════════
// KEYBOARD
// ══════════════════════════════════════════════════════════════════════════
document.addEventListener('keydown', e => {
  // Shortcuts modal
  if (e.key === 'Escape') {
    if (presMode) { exitPresentation(); return; }
    document.getElementById('shortcuts-modal').classList.remove('show');
    hideContextMenu();
    return;
  }
  if (document.getElementById('shortcuts-modal').classList.contains('show')) {
    if (e.key === 'Escape') document.getElementById('shortcuts-modal').classList.remove('show');
    return;
  }
  if (presMode) {
    if (e.key === 'ArrowRight' || e.key === ' ') { presNavigate(1); return; }
    if (e.key === 'ArrowLeft') { presNavigate(-1); return; }
    return;
  }

  const inInput = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA';

  // Ctrl combos work even in inputs
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key === 'y') { e.preventDefault(); redo(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveCurrentSlide(); return; }
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'A') { e.preventDefault(); bakeOverlays(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key === 'c' && !inInput) { e.preventDefault(); copyOverlay(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key === 'v' && !inInput) { e.preventDefault(); pasteOverlay(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key === 'd' && !inInput) {
    e.preventDefault();
    if (selectedIdx >= 0) duplicateSelected();
    else duplicateSlide();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'p' || e.key === 'P') && !inInput) {
    e.preventDefault(); printDeck(); return;
  }

  if (inInput) return;

  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (selectedIdx >= 0) deleteSelected();
    else if (e.key === 'Delete') deleteSlide();
  }
  if (e.key === 'ArrowRight') gotoSlide(currentSlide + 1);
  if (e.key === 'ArrowLeft')  gotoSlide(currentSlide - 1);
  if (e.key === 't' || e.key === 'T') setTool('text');
  if (e.key === 'r' || e.key === 'R') setTool('rect');
  if (e.key === 's' || e.key === 'S') setTool('select');
  if (e.key === 'c' && !e.ctrlKey && !e.metaKey) setTool('cover');
  if (e.key === 'g' || e.key === 'G') toggleGrid();
  if (e.key === '?') document.getElementById('shortcuts-modal').classList.add('show');
  if (e.key === 'F5') { e.preventDefault(); enterPresentation(); }
});

document.getElementById('shortcuts-modal').addEventListener('click', function(e) {
  if (e.target === this) this.classList.remove('show');
});

window.addEventListener('resize', () => { resizeCanvas(); renderOverlays(); });

// ══════════════════════════════════════════════════════════════════════════
// COPY / PASTE
// ══════════════════════════════════════════════════════════════════════════
function copyOverlay() {
  if (selectedIdx < 0) return;
  clipboardOverlay = JSON.parse(JSON.stringify(overlays[selectedIdx]));
  showToast('Overlay copied', 'info', 1200);
}

function pasteOverlay() {
  if (!clipboardOverlay) return;
  pushUndo();
  const clone = JSON.parse(JSON.stringify(clipboardOverlay));
  clone.x += 0.02;
  clone.y += 0.02;
  overlays.push(clone);
  if (clone.type === 'image') preloadSingleImage(overlays.length - 1);
  selectOverlay(overlays.length - 1);
  renderOverlayList(); renderOverlays(); markDirty();
  showToast('Overlay pasted', 'info', 1200);
}

// ══════════════════════════════════════════════════════════════════════════
// PRESENTATION MODE
// ══════════════════════════════════════════════════════════════════════════
function enterPresentation() {
  presMode = true;
  presSlide = currentSlide;
  const el = document.getElementById('presentation-mode');
  el.classList.add('active');
  renderPresSlide();
  if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
}

function exitPresentation() {
  presMode = false;
  document.getElementById('presentation-mode').classList.remove('active');
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

function presNavigate(dir) {
  presSlide += dir;
  if (presSlide < 1) presSlide = 1;
  if (presSlide > NUM_SLIDES) { exitPresentation(); return; }
  renderPresSlide();
}

async function renderPresSlide() {
  const pad = String(presSlide).padStart(2, '0');
  const presCanvas = document.getElementById('pres-canvas');
  const pCtx = presCanvas.getContext('2d');

  const img = new Image();
  img.onload = async () => {
    presCanvas.width = img.naturalWidth;
    presCanvas.height = img.naturalHeight;
    pCtx.drawImage(img, 0, 0);

    // Load overlays for this slide
    try {
      const resp = await fetch(`/api/slide/${presSlide}`);
      const data = await resp.json();
      const ovs = data.overlays || [];
      // Render overlays baked on top
      for (const ov of ovs) {
        const x = ov.x * presCanvas.width, y = ov.y * presCanvas.height;
        const w = ov.w * presCanvas.width, h = ov.h * presCanvas.height;
        pCtx.globalAlpha = ov.opacity ?? 1;
        if (ov.type === 'text') {
          if (ov.bgColor && ov.bgColor !== 'transparent') {
            pCtx.fillStyle = ov.bgColor;
            pCtx.fillRect(x, y, w, h);
          }
          const fs = Math.max(8, Math.round((ov.fontSize || 18) * (presCanvas.width / 933)));
          const weight = ov.bold ? 'bold' : 'normal';
          const style = ov.italic ? 'italic' : 'normal';
          pCtx.font = `${style} ${weight} ${fs}px 'Inter', sans-serif`;
          pCtx.fillStyle = ov.color || '#fff';
          pCtx.textAlign = ov.align || 'left';
          const tx = ov.align === 'center' ? x + w/2 : ov.align === 'right' ? x + w - 8 : x + 8;
          wrapText(pCtx, ov.text || '', tx, y + fs + 8, w - 16, fs * 1.3);
        } else if (ov.type === 'rect') {
          pCtx.fillStyle = ov.fillColor || '#2563EB';
          pCtx.fillRect(x, y, w, h);
        } else if (ov.type === 'image' && ov.src) {
          await new Promise(resolve => {
            const oImg = new Image();
            oImg.onload = () => { pCtx.drawImage(oImg, x, y, w, h); resolve(); };
            oImg.onerror = resolve;
            oImg.src = ov.src;
          });
        }
        pCtx.globalAlpha = 1;
      }
    } catch (e) {}
  };
  img.src = `/static/slides/slide-${pad}.jpg`;
}

document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && presMode) exitPresentation();
});

// ══════════════════════════════════════════════════════════════════════════
// DRAG & DROP UPLOAD
// ══════════════════════════════════════════════════════════════════════════
const dropOverlay = document.getElementById('drop-overlay');
let dragCounter = 0;

document.addEventListener('dragenter', e => {
  if (e.target.closest && e.target.closest('.thumb-strip')) return;
  e.preventDefault();
  dragCounter++;
  if (dragCounter === 1) dropOverlay.classList.add('active');
});
document.addEventListener('dragleave', e => {
  if (e.target.closest && e.target.closest('.thumb-strip')) return;
  e.preventDefault();
  dragCounter--;
  if (dragCounter === 0) dropOverlay.classList.remove('active');
});
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => {
  if (e.target.closest && e.target.closest('.thumb-strip')) return;
  e.preventDefault();
  dragCounter = 0;
  dropOverlay.classList.remove('active');
  const file = e.dataTransfer.files[0];
  if (file && file.name.toLowerCase().endsWith('.pptx')) {
    doUpload(file);
  } else {
    showToast('Please drop a .pptx file', 'error');
  }
});

async function uploadPPTX(input) {
  const file = input.files[0];
  if (!file) return;
  doUpload(file);
  input.value = '';
}

async function bulkRemoveLogo(input) {
  const files = Array.from(input.files);
  if (!files.length) return;
  if (files.length > 20) {
    showToast('Maximum 20 files allowed', 'error');
    input.value = '';
    return;
  }
  const nonPptx = files.filter(f => !f.name.toLowerCase().endsWith('.pptx'));
  if (nonPptx.length) {
    showToast('Only .pptx files are supported', 'error');
    input.value = '';
    return;
  }
  const totalMB = files.reduce((s, f) => s + f.size, 0) / (1024 * 1024);
  showLoading(`Processing ${files.length} file${files.length > 1 ? 's' : ''} (${totalMB.toFixed(0)} MB)... Removing logos...`);
  const form = new FormData();
  files.forEach(f => form.append('files', f));
  try {
    const resp = await fetch('/api/batch/remove-logo', { method: 'POST', body: form });
    hideLoading();
    if (resp.ok) {
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'SlideCraft_Bulk_Cleaned.zip';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      showToast(`Done! ${files.length} cleaned files downloaded as ZIP`, 'success');
    } else if (resp.status === 413) {
      // Server's friendly 413 handler returns JSON with a useful message
      let msg = `Upload too large (${totalMB.toFixed(0)} MB).`;
      try {
        const data = await resp.json();
        if (data.error) msg = data.error;
      } catch (e) {}
      showToast(msg, 'error', 8000);
    } else {
      let msg = 'Bulk processing failed';
      try {
        const data = await resp.json();
        if (data.error) msg = data.error;
      } catch (e) {}
      showToast(msg, 'error');
    }
  } catch (e) {
    hideLoading();
    showToast('Bulk processing failed: ' + e.message, 'error');
  }
  input.value = '';
}

function _ensureFolderProgressPanel() {
  let el = document.getElementById('folder-progress');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'folder-progress';
  el.style.cssText = [
    'position:fixed','right:16px','top:80px','width:420px','max-width:92vw',
    'max-height:calc(100vh - 120px)','display:flex','flex-direction:column',
    'background:rgba(20,22,28,0.98)','color:#e6e8ee','border:1px solid #2a2f3a',
    'border-radius:10px','box-shadow:0 10px 40px rgba(0,0,0,0.5)',
    'font:13px/1.4 system-ui,sans-serif','z-index:99999','overflow:hidden',
  ].join(';');
  el.innerHTML = `
    <div style="padding:10px 14px;background:#1a1d24;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #2a2f3a">
      <strong id="fp-title">Folder: Remove Logo</strong>
      <button id="fp-close" style="background:none;border:0;color:#9aa0ab;cursor:pointer;font-size:18px;line-height:1">&times;</button>
    </div>
    <div style="padding:12px 14px">
      <div id="fp-summary" style="margin-bottom:8px;color:#b4b9c4">Starting...</div>
      <div style="height:6px;background:#2a2f3a;border-radius:3px;overflow:hidden;margin-bottom:10px">
        <div id="fp-bar" style="height:100%;width:0%;background:linear-gradient(90deg,#3b82f6,#22d3ee);transition:width .2s"></div>
      </div>
      <div id="fp-list" style="flex:1;min-height:200px;overflow-y:auto;font-size:12px"></div>
      <div id="fp-errsum" style="display:none;margin-top:8px;padding:6px 8px;background:#3a1f1f;border-left:3px solid #ef4444;color:#fecaca;font-size:11px;white-space:pre-wrap"></div>
    </div>`;
  document.body.appendChild(el);
  el.querySelector('#fp-close').onclick = () => el.remove();
  return el;
}

function _fpAddLine(file, status, extra) {
  const list = document.getElementById('fp-list');
  if (!list) return null;
  const id = 'fp-row-' + (file.replace(/[^\w]+/g, '_'));
  let row = document.getElementById(id);
  if (!row) {
    row = document.createElement('div');
    row.id = id;
    row.style.cssText = 'padding:3px 0;border-bottom:1px dashed #2a2f3a';
    row.innerHTML = `
      <div style="display:flex;justify-content:space-between;gap:8px">
        <span class="fp-name" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1"></span>
        <span class="fp-status" style="flex-shrink:0"></span>
      </div>
      <div class="fp-reason" style="display:none;color:#fca5a5;font-size:11px;margin-top:2px;word-break:break-word"></div>`;
    list.appendChild(row);
    row.querySelector('.fp-name').textContent = file;
    row.querySelector('.fp-name').title = file;
  }
  const colors = { processing: '#fbbf24', ok: '#22c55e', skipped: '#9aa0ab', error: '#ef4444' };
  const labels = { processing: 'processing...', ok: 'done', skipped: 'skipped', error: 'error' };
  const s = row.querySelector('.fp-status');
  s.textContent = labels[status] || status;
  s.style.color = colors[status] || '#e6e8ee';
  const reasonEl = row.querySelector('.fp-reason');
  if ((status === 'error' || status === 'skipped') && extra) {
    reasonEl.textContent = extra;
    reasonEl.style.display = 'block';
  }
  list.scrollTop = list.scrollHeight;
  return row;
}

async function folderRemoveLogo() {
  const last = localStorage.getItem('folderRemoveLogo:lastPath') || '';
  const folder = prompt(
    'Enter the full path of the folder containing your PPTX files.\n' +
    'Cleaned files will be written to "<folder>\\Slides Final".',
    last
  );
  if (!folder || !folder.trim()) return;

  const overwrite = confirm(
    'Overwrite files in "Slides Final" if they already exist?\n\n' +
    'OK = overwrite,  Cancel = skip existing files.'
  );
  localStorage.setItem('folderRemoveLogo:lastPath', folder.trim());

  const panel = _ensureFolderProgressPanel();
  const summary = panel.querySelector('#fp-summary');
  const bar = panel.querySelector('#fp-bar');
  const list = panel.querySelector('#fp-list');
  list.innerHTML = '';
  summary.textContent = 'Scanning folder...';
  bar.style.width = '0%';

  let total = 0, doneCount = 0;
  const errorReasons = [];
  try {
    const resp = await fetch('/api/folder/remove-logo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder: folder.trim(), overwrite }),
    });
    if (!resp.ok || !resp.body) {
      let msg = `Folder processing failed (${resp.status})`;
      try { const d = await resp.json(); if (d.error) msg = d.error; } catch (e) {}
      summary.textContent = msg;
      summary.style.color = '#ef4444';
      showToast(msg, 'error', 8000);
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let evt;
        try { evt = JSON.parse(line); } catch (e) { continue; }

        if (evt.type === 'start') {
          total = evt.total || 0;
          summary.innerHTML = `Processing <strong>${total}</strong> file${total === 1 ? '' : 's'}<br><span style="color:#9aa0ab;font-size:11px">→ ${evt.output_folder}</span>`;
        } else if (evt.type === 'file') {
          _fpAddLine(evt.file, evt.status, evt.error || evt.reason || '');
          if (evt.status === 'error' && evt.error) {
            errorReasons.push(`${evt.file}: ${evt.error}`);
            console.warn('[folder-remove-logo]', evt.file, evt.error);
          }
          if (evt.status !== 'processing') {
            doneCount = evt.index;
            const pct = total ? Math.round((doneCount / total) * 100) : 0;
            bar.style.width = pct + '%';
          }
        } else if (evt.type === 'done') {
          bar.style.width = '100%';
          const parts = [`${evt.ok}/${evt.total} cleaned`];
          if (evt.skipped) parts.push(`${evt.skipped} skipped`);
          if (evt.error) parts.push(`${evt.error} failed`);
          summary.innerHTML = `<strong>${parts.join(' · ')}</strong><br><span style="color:#9aa0ab;font-size:11px">→ ${evt.output_folder}</span>`;
          if (evt.error && errorReasons.length) {
            const box = panel.querySelector('#fp-errsum');
            const sample = errorReasons.slice(0, 3).join('\n');
            const more = errorReasons.length > 3 ? `\n…and ${errorReasons.length - 3} more (see browser console)` : '';
            box.textContent = `First error reasons:\n${sample}${more}`;
            box.style.display = 'block';
          }
          showToast(parts.join(' · '), evt.error ? 'error' : 'success', 6000);
        }
      }
    }
  } catch (e) {
    summary.textContent = 'Folder processing failed: ' + e.message;
    summary.style.color = '#ef4444';
    showToast('Folder processing failed: ' + e.message, 'error');
  }
}

async function doUpload(file) {
  showLoading('Uploading & processing slides...');
  const form = new FormData();
  form.append('file', file);
  try {
    const resp = await fetch('/api/upload', { method: 'POST', body: form });
    const data = await resp.json();
    hideLoading();
    if (data.ok) {
      showToast('Upload complete! Reloading...', 'success');
      setTimeout(() => location.reload(), 800);
    } else {
      showToast(data.error || 'Upload failed', 'error');
    }
  } catch (e) {
    hideLoading();
    showToast('Upload failed: ' + e.message, 'error');
  }
}

// ══════════════════════════════════════════════════════════════════════════
// LOGO INSERT MODAL
// ══════════════════════════════════════════════════════════════════════════
let logoPosition = 'bottom-left';
let logoScope    = 'all';

function openLogoModal() {
  const modal = document.getElementById('logo-modal');
  if (!modal) return;
  // Load current slide thumbnail into preview
  const slideImg = document.getElementById('slide-img');
  const prev = document.getElementById('logo-preview-slide-img');
  if (slideImg && slideImg.src) prev.src = slideImg.src;
  updateLogoDot();
  modal.classList.add('active');
}

function closeLogoModal() {
  document.getElementById('logo-modal').classList.remove('active');
}

function setLogoPos(pos) {
  logoPosition = pos;
  document.querySelectorAll('.logo-pos-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.pos === pos);
  });
  updateLogoDot();
}

function setLogoScope(scope) {
  logoScope = scope;
  document.getElementById('logo-scope-current').classList.toggle('active', scope === 'current');
  document.getElementById('logo-scope-all').classList.toggle('active', scope === 'all');
}

function updateLogoDot() {
  const dot = document.getElementById('logo-preview-dot');
  const preview = document.getElementById('logo-slide-preview');
  if (!dot || !preview) return;
  const scale   = parseFloat(document.getElementById('logo-scale').value);
  const padding = parseInt(document.getElementById('logo-padding').value);
  // Dot represents logo center as % of preview box
  const pad_pct_x = (padding / 1920) * 100;
  const pad_pct_y = (padding / 1080) * 100;
  const logo_pct  = scale * 100;
  const half_w    = logo_pct / 2;
  const half_h    = (logo_pct / (16/9)) / 2;
  const positions = {
    'top-left':      [pad_pct_x + half_w,       pad_pct_y + half_h],
    'top-center':    [50,                         pad_pct_y + half_h],
    'top-right':     [100 - pad_pct_x - half_w,  pad_pct_y + half_h],
    'middle-left':   [pad_pct_x + half_w,         50],
    'center':        [50,                          50],
    'middle-right':  [100 - pad_pct_x - half_w,   50],
    'bottom-left':   [pad_pct_x + half_w,          100 - pad_pct_y - half_h],
    'bottom-center': [50,                           100 - pad_pct_y - half_h],
    'bottom-right':  [100 - pad_pct_x - half_w,    100 - pad_pct_y - half_h],
  };
  const [lx, ly] = positions[logoPosition] || [50, 50];
  dot.style.left = lx + '%';
  dot.style.top  = ly + '%';
}

function onLogoFileChange(input) {
  if (!input.files[0]) return;
  const name = input.files[0].name;
  document.getElementById('logo-file-name').textContent = name.length > 28 ? name.slice(0, 25) + '…' : name;
  const wrap = document.getElementById('logo-img-preview-wrap');
  const img  = document.getElementById('logo-img-preview');
  const url  = URL.createObjectURL(input.files[0]);
  img.src = url;
  wrap.style.display = 'flex';
}

async function applyLogo() {
  const fileInput = document.getElementById('logo-file-input');
  if (!fileInput.files[0]) { showToast('Choose a logo image first', 'error'); return; }

  const scale   = parseFloat(document.getElementById('logo-scale').value);
  const opacity = parseFloat(document.getElementById('logo-opacity').value);
  const padding = parseInt(document.getElementById('logo-padding').value);

  showLoading('Uploading logo...');
  const form = new FormData();
  form.append('file', fileInput.files[0]);
  try {
    const upResp = await fetch('/api/upload-image', { method: 'POST', body: form });
    const upData = await upResp.json();
    if (!upData.src) { hideLoading(); showToast(upData.error || 'Upload failed', 'error'); return; }

    // Compute overlay bounds (0–1 relative to slide dimensions)
    const aspect = upData.w / upData.h;
    const ovW  = scale;
    const ovH  = ovW / aspect;
    const PX   = padding / 1920;
    const PY   = padding / 1080;
    const cx   = 0.5 - ovW / 2;
    const cy   = 0.5 - ovH / 2;
    const rX   = 1 - ovW - PX;
    const bY   = 1 - ovH - PY;
    const posMap = {
      'top-left':      [PX,  PY],  'top-center':    [cx,  PY],  'top-right':     [rX,  PY],
      'middle-left':   [PX,  cy],  'center':        [cx,  cy],  'middle-right':  [rX,  cy],
      'bottom-left':   [PX,  bY],  'bottom-center': [cx,  bY],  'bottom-right':  [rX,  bY],
    };
    const [ox, oy] = posMap[logoPosition] || posMap['bottom-right'];
    const ovObj = { type: 'image', x: ox, y: oy, w: ovW, h: ovH, src: upData.src, opacity };

    if (logoScope === 'current') {
      // Add as draggable overlay on current slide only
      pushUndo();
      overlays.push(ovObj);
      preloadSingleImage(overlays.length - 1);
      setTool('select');              // must be in select mode to drag
      selectOverlay(overlays.length - 1);
      renderOverlayList();
      renderOverlays();
      markDirty();
      hideLoading();
      closeLogoModal();
      showToast('Logo added — drag to reposition, resize handles on corners', 'success', 6000);
    } else {
      // Save current slide first, then add overlay to all slides via backend
      await saveCurrentSlide(true);
      showLoading('Adding logo to all slides...');
      const addResp = await fetch('/api/logo/add-overlay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ src: upData.src, x: ox, y: oy, w: ovW, h: ovH, opacity, scope: 'all', slide_num: currentSlide })
      });
      const addData = await addResp.json();
      hideLoading();
      if (addData.ok) {
        closeLogoModal();
        await gotoSlide(currentSlide);
        setTool('select');
        // Auto-select the last overlay (the logo we just added)
        if (overlays.length > 0) selectOverlay(overlays.length - 1);
        showToast(`Logo added to ${addData.count} slides — drag to reposition`, 'success', 6000);
      } else {
        showToast(addData.error || 'Failed to add logo', 'error');
      }
    }
  } catch (e) {
    hideLoading();
    showToast('Logo insert error: ' + e.message, 'error');
  }
}

// Adapt layout to actual monitor resolution on load
function adaptToScreen() {
  const sw = window.screen.width;
  const root = document.documentElement.style;
  if (sw >= 3840) {
    root.setProperty('--thumb-w', '260px');
  } else if (sw >= 2560) {
    root.setProperty('--thumb-w', '220px');
  } else if (sw >= 1920) {
    root.setProperty('--thumb-w', '185px');
  } else if (sw >= 1440) {
    root.setProperty('--thumb-w', '170px');
  } else if (sw >= 1280) {
    root.setProperty('--thumb-w', '160px');
  } else {
    root.setProperty('--thumb-w', '140px');
  }
}

// ══════════════════════════════════════════════════════════════════════════
// EXPORT DROPDOWN
// ══════════════════════════════════════════════════════════════════════════
function toggleExportMenu(e) {
  e.stopPropagation();
  const menu = document.getElementById('export-menu');
  menu.classList.toggle('open');
}
function closeExportMenu() {
  document.getElementById('export-menu').classList.remove('open');
}
function toggleMoreMenu(e) {
  e.stopPropagation();
  const menu = document.getElementById('more-menu');
  const exportMenu = document.getElementById('export-menu');
  exportMenu.classList.remove('open');
  menu.classList.toggle('open');
}
function closeMoreMenu() {
  const m = document.getElementById('more-menu');
  if (m) m.classList.remove('open');
}
document.addEventListener('click', (e) => {
  const exportMenu = document.getElementById('export-menu');
  if (exportMenu && !e.target.closest('.export-dropdown')) exportMenu.classList.remove('open');
  const moreMenu = document.getElementById('more-menu');
  if (moreMenu && !e.target.closest('.more-dropdown')) moreMenu.classList.remove('open');
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeExportMenu(); closeMoreMenu(); }
});

// ══════════════════════════════════════════════════════════════════════════
// REMOVE NOTEBOOKLM LOGO
// ══════════════════════════════════════════════════════════════════════════
async function removeLogos() {
  showLoading('Removing NotebookLM logos...');
  try {
    const resp = await fetch('/api/remove-logo', { method: 'POST' });
    const data = await resp.json();
    hideLoading();
    if (data.ok) {
      showToast('Logos removed! Reloading...', 'success');
      setTimeout(() => location.reload(), 800);
    } else {
      showToast('Failed to remove logos', 'error');
    }
  } catch (e) {
    hideLoading();
    showToast('Error: ' + e.message, 'error');
  }
}

// ══════════════════════════════════════════════════════════════════════════
// THUMBNAIL DRAG REORDER
// ══════════════════════════════════════════════════════════════════════════
function initThumbDrag() {
  const strip = document.getElementById('thumb-strip');
  let dragSrcIdx = null;

  strip.addEventListener('dragstart', e => {
    const item = e.target.closest('.thumb-item');
    if (!item) return;
    dragSrcIdx = parseInt(item.dataset.index);
    item.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragSrcIdx);
  });

  strip.addEventListener('dragend', e => {
    const item = e.target.closest('.thumb-item');
    if (item) item.classList.remove('dragging');
    strip.querySelectorAll('.thumb-item').forEach(t => {
      t.classList.remove('drag-over-top', 'drag-over-bottom');
    });
  });

  strip.addEventListener('dragover', e => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const item = e.target.closest('.thumb-item');
    if (!item) return;
    strip.querySelectorAll('.thumb-item').forEach(t => {
      t.classList.remove('drag-over-top', 'drag-over-bottom');
    });
    const rect = item.getBoundingClientRect();
    const mid = rect.top + rect.height / 2;
    if (e.clientY < mid) {
      item.classList.add('drag-over-top');
    } else {
      item.classList.add('drag-over-bottom');
    }
  });

  strip.addEventListener('drop', async e => {
    e.preventDefault();
    e.stopPropagation();
    strip.querySelectorAll('.thumb-item').forEach(t => {
      t.classList.remove('drag-over-top', 'drag-over-bottom', 'dragging');
    });
    const item = e.target.closest('.thumb-item');
    if (!item || dragSrcIdx === null) return;
    const dropIdx = parseInt(item.dataset.index);
    if (dragSrcIdx === dropIdx) return;

    // Build new order array
    const order = [];
    for (let i = 1; i <= NUM_SLIDES; i++) order.push(i);
    // Remove source
    const srcPos = order.indexOf(dragSrcIdx);
    order.splice(srcPos, 1);
    // Insert at drop position
    let dropPos = order.indexOf(dropIdx);
    const rect = item.getBoundingClientRect();
    const mid = rect.top + rect.height / 2;
    if (e.clientY >= mid) dropPos++;
    order.splice(dropPos, 0, dragSrcIdx);

    showLoading('Reordering slides...');
    try {
      const resp = await fetch('/api/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order })
      });
      hideLoading();
      showToast('Slides reordered! Reloading...', 'success');
      setTimeout(() => location.reload(), 800);
    } catch (err) {
      hideLoading();
      showToast('Reorder failed: ' + err.message, 'error');
    }
  });
}

// ══════════════════════════════════════════════════════════════════════════
// EXPORT PNG ZIP
// ══════════════════════════════════════════════════════════════════════════
async function exportPNGZip() {
  await saveCurrentSlide(true);
  showLoading('Exporting PNG slides...');
  try {
    const resp = await fetch('/api/export-png-zip', { method: 'POST' });
    hideLoading();
    if (resp.ok) {
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'slides_png.zip';
      a.click();
      URL.revokeObjectURL(url);
      showToast('PNG ZIP downloaded!', 'success');
    } else {
      showToast('PNG export failed', 'error');
    }
  } catch (e) {
    hideLoading();
    showToast('PNG export error: ' + e.message, 'error');
  }
}

// ══════════════════════════════════════════════════════════════════════════
// EXPORT GIF
// ══════════════════════════════════════════════════════════════════════════
async function exportGIF() {
  const duration = prompt('Duration per slide in milliseconds (default 2000):', '2000');
  if (duration === null) return;
  const dur = parseInt(duration) || 2000;
  await saveCurrentSlide(true);
  showLoading('Generating animated GIF...');
  try {
    const resp = await fetch('/api/export-gif', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ duration: dur })
    });
    hideLoading();
    if (resp.ok) {
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'slides_animated.gif';
      a.click();
      URL.revokeObjectURL(url);
      showToast('GIF downloaded!', 'success');
    } else {
      showToast('GIF export failed', 'error');
    }
  } catch (e) {
    hideLoading();
    showToast('GIF export error: ' + e.message, 'error');
  }
}

// ══════════════════════════════════════════════════════════════════════════
// IMAGE FILTERS
// ══════════════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════════════
// IMAGE FILTERS — live preview via CSS, commit via /filters endpoint
// ══════════════════════════════════════════════════════════════════════════
let fxScope = 'current';
const FX_DEFAULTS = {
  brightness: 100, contrast: 100, saturation: 100,
  hue: 0, blur: 0, sepia: 0, grayscale: 0, sharpen: 100,
};

function _fxRead() {
  return {
    brightness: parseInt(document.getElementById('fx-brightness').value, 10),
    contrast:   parseInt(document.getElementById('fx-contrast').value, 10),
    saturation: parseInt(document.getElementById('fx-saturation').value, 10),
    hue:        parseInt(document.getElementById('fx-hue').value, 10),
    blur:       parseFloat(document.getElementById('fx-blur').value),
    sepia:      parseInt(document.getElementById('fx-sepia').value, 10),
    grayscale:  parseInt(document.getElementById('fx-grayscale').value, 10),
    sharpen:    parseInt(document.getElementById('fx-sharpen').value, 10),
  };
}

function _fxWrite(v) {
  document.getElementById('fx-brightness').value = v.brightness;
  document.getElementById('fx-contrast').value   = v.contrast;
  document.getElementById('fx-saturation').value = v.saturation;
  document.getElementById('fx-hue').value        = v.hue;
  document.getElementById('fx-blur').value       = v.blur;
  document.getElementById('fx-sepia').value      = v.sepia;
  document.getElementById('fx-grayscale').value  = v.grayscale;
  document.getElementById('fx-sharpen').value    = v.sharpen;
}

function _isFxDirty(v) {
  return !(v.brightness === 100 && v.contrast === 100 && v.saturation === 100
        && v.hue === 0 && v.blur === 0 && v.sepia === 0 && v.grayscale === 0
        && v.sharpen === 100);
}

function updateFxLive() {
  const v = _fxRead();
  document.getElementById('fx-brightness-val').textContent = v.brightness + '%';
  document.getElementById('fx-contrast-val').textContent   = v.contrast + '%';
  document.getElementById('fx-saturation-val').textContent = v.saturation + '%';
  document.getElementById('fx-hue-val').textContent        = v.hue + '°';
  document.getElementById('fx-blur-val').textContent       = v.blur.toFixed(1) + 'px';
  document.getElementById('fx-sepia-val').textContent      = v.sepia + '%';
  document.getElementById('fx-grayscale-val').textContent  = v.grayscale + '%';
  document.getElementById('fx-sharpen-val').textContent    = v.sharpen + '%';

  // CSS filter chain — order matches server-side _apply_filter_chain.
  // Sharpen has no CSS equivalent, so it's preview-skipped (server only).
  const parts = [];
  if (v.hue !== 0)        parts.push(`hue-rotate(${v.hue}deg)`);
  if (v.saturation !== 100) parts.push(`saturate(${v.saturation / 100})`);
  if (v.brightness !== 100) parts.push(`brightness(${v.brightness / 100})`);
  if (v.contrast !== 100)   parts.push(`contrast(${v.contrast / 100})`);
  if (v.sepia > 0)        parts.push(`sepia(${v.sepia / 100})`);
  if (v.grayscale > 0)    parts.push(`grayscale(${v.grayscale / 100})`);
  if (v.blur > 0)         parts.push(`blur(${v.blur}px)`);
  slideImg.style.filter = parts.join(' ');

  document.getElementById('fx-preview-tag').style.display = _isFxDirty(v) ? '' : 'none';

  // Untoggle preset selection when sliders drift away from any preset
  document.querySelectorAll('.fx-preset').forEach(b => b.classList.remove('active'));
}

const FX_PRESETS = {
  none:    { ...FX_DEFAULTS },
  bw:      { ...FX_DEFAULTS, grayscale: 100, contrast: 110 },
  vintage: { ...FX_DEFAULTS, sepia: 60, saturation: 80, contrast: 95, brightness: 105 },
  vibrant: { ...FX_DEFAULTS, saturation: 150, contrast: 115 },
  cool:    { ...FX_DEFAULTS, hue: -15, saturation: 110, brightness: 102 },
  warm:    { ...FX_DEFAULTS, hue: 12, saturation: 115, brightness: 105 },
};

function applyFxPreset(name) {
  const p = FX_PRESETS[name] || FX_DEFAULTS;
  _fxWrite(p);
  updateFxLive();
  document.querySelectorAll('.fx-preset').forEach(b => {
    b.classList.toggle('active', b.dataset.preset === name);
  });
}

function setFxScope(s) {
  fxScope = s;
  document.getElementById('fx-scope-current').classList.toggle('active', s === 'current');
  document.getElementById('fx-scope-all').classList.toggle('active', s === 'all');
  const btn = document.getElementById('fx-apply-btn');
  btn.textContent = s === 'all' ? `Apply to all ${NUM_SLIDES} slides` : 'Apply';
}

function resetFxSliders() {
  _fxWrite(FX_DEFAULTS);
  updateFxLive();
}

async function resetFxToOriginal() {
  if (!confirm('Restore this slide image to the version uploaded? Live filter preview will be cleared.')) return;
  showLoading('Restoring original...');
  try {
    const resp = await fetch(`/api/slide/${currentSlide}/reset`, { method: 'POST' });
    hideLoading();
    const data = await resp.json();
    if (data.ok) {
      resetFxSliders();
      const pad = String(currentSlide).padStart(2, '0');
      slideImg.src = `/static/slides/slide-${pad}.jpg?t=${Date.now()}`;
      const thumb = document.querySelector(`#thumb-${currentSlide} img`);
      if (thumb) thumb.src = slideImg.src;
      // Reload overlays for this slide from server (reset cleared them)
      gotoSlide(currentSlide);
      showToast('Slide restored to original', 'success');
    } else {
      showToast(data.error || 'Reset failed', 'error');
    }
  } catch (e) { hideLoading(); showToast('Error: ' + e.message, 'error'); }
}

async function applyFiltersNow() {
  const v = _fxRead();
  if (!_isFxDirty(v)) {
    showToast('No filter changes to apply', 'info');
    return;
  }
  const body = {
    brightness: v.brightness / 100,
    contrast:   v.contrast / 100,
    saturation: v.saturation / 100,
    hue:        v.hue,
    blur:       v.blur,
    sepia:      v.sepia / 100,
    grayscale:  v.grayscale / 100,
    sharpen:    v.sharpen / 100,
    scope:      fxScope,
    from_original: true,
  };
  showLoading(fxScope === 'all' ? `Applying to all ${NUM_SLIDES} slides...` : 'Applying filters...');
  try {
    const resp = await fetch(`/api/slide/${currentSlide}/filters`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    hideLoading();
    const data = await resp.json();
    if (data.ok) {
      // Clear the CSS preview; the new JPG already has the filters baked
      slideImg.style.filter = '';
      const t = Date.now();
      const pad = String(currentSlide).padStart(2, '0');
      slideImg.src = `/static/slides/slide-${pad}.jpg?t=${t}`;
      // Reload all thumbnails too (in case scope=all)
      for (let i = 1; i <= NUM_SLIDES; i++) {
        const tp = String(i).padStart(2, '0');
        const tn = document.querySelector(`#thumb-${i} img`);
        if (tn) tn.src = `/static/slides/slide-${tp}.jpg?t=${t}`;
      }
      // Reset sliders to neutral so the live preview matches the baked image
      _fxWrite(FX_DEFAULTS);
      updateFxLive();
      refreshAppliedBadge();
      showToast(`Filters applied to ${data.count} slide${data.count === 1 ? '' : 's'}.`, 'success', 5000);
      if (data.snapshot) {
        const toast = document.getElementById('toast');
        const span = toast && toast.querySelector('span');
        if (span) span.innerHTML += _undoToastAction(data.snapshot);
      }
    } else {
      showToast(data.error || 'Filter apply failed', 'error');
    }
  } catch (e) { hideLoading(); showToast('Error: ' + e.message, 'error'); }
}

// Clear the live CSS preview when navigating between slides so the next
// slide doesn't inherit the previous slide's preview filters.
function clearFxPreviewOnNav() {
  slideImg.style.filter = '';
  resetFxSliders();
}

// ══════════════════════════════════════════════════════════════════════════
// QR CODE GENERATOR
// ══════════════════════════════════════════════════════════════════════════
function openQRModal() {
  document.getElementById('qr-modal').classList.add('show');
  document.getElementById('qr-url').focus();
}

async function generateQR() {
  const url = document.getElementById('qr-url').value.trim();
  if (!url) { showToast('Enter a URL', 'error'); return; }
  showLoading('Generating QR code...');
  try {
    const resp = await fetch('/api/qr-generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    const data = await resp.json();
    hideLoading();
    if (data.src) {
      pushUndo();
      overlays.push({ type: 'image', x: 0.7, y: 0.7, w: 0.2, h: 0.2 * (16/9), src: data.src, opacity: 1 });
      preloadSingleImage(overlays.length - 1);
      selectOverlay(overlays.length - 1);
      renderOverlayList();
      renderOverlays();
      markDirty();
      document.getElementById('qr-modal').classList.remove('show');
      showToast('QR code added!', 'success');
    } else {
      showToast(data.error || 'QR generation failed', 'error');
    }
  } catch (e) {
    hideLoading();
    showToast('QR error: ' + e.message, 'error');
  }
}

// ══════════════════════════════════════════════════════════════════════════
// WATERMARK MANAGER (redesigned)
// ══════════════════════════════════════════════════════════════════════════
let wmType = 'text';
let wmPosition = 'center';
let wmScope = 'all';
let wmPreviewTimer = null;
let wmDetectCandidates = [];
let wmSelectedCandidates = new Set();
let wmLastSnapshot = null;
let wmDrawMode = false;
let wmDrawing = null;  // {sx,sy} during drag
let wmCustomRegion = null;  // {x,y,w,h} after drawing

function openWatermarkModal() {
  document.getElementById('watermark-modal').classList.add('show');
  switchWmTab('add');
}

function closeWatermarkModal() {
  document.getElementById('watermark-modal').classList.remove('show');
  wmDrawMode = false;
  wmDrawing = null;
  wmCustomRegion = null;
}

function switchWmTab(tab) {
  document.getElementById('wm-panel-add').style.display = tab === 'add' ? '' : 'none';
  document.getElementById('wm-panel-detect').style.display = tab === 'detect' ? '' : 'none';
  document.getElementById('wm-panel-applied').style.display = tab === 'applied' ? '' : 'none';
  document.getElementById('wm-tab-add').classList.toggle('active', tab === 'add');
  document.getElementById('wm-tab-detect').classList.toggle('active', tab === 'detect');
  document.getElementById('wm-tab-applied').classList.toggle('active', tab === 'applied');
  if (tab === 'add') {
    document.getElementById('wm-preview-num').textContent = currentSlide;
    schedulePreview();
  } else if (tab === 'detect') {
    document.getElementById('wm-detect-num').textContent = currentSlide;
    const detectImg = document.getElementById('wm-detect-img');
    const pad = String(currentSlide).padStart(2, '0');
    detectImg.src = '/static/slides/slide-' + pad + '.jpg?t=' + Date.now();
    detectWatermarks();
  } else if (tab === 'applied') {
    loadAppliedWatermarks();
  }
}

function setWmType(type) {
  wmType = type;
  document.getElementById('wm-type-text').classList.toggle('active', type === 'text');
  document.getElementById('wm-type-image').classList.toggle('active', type === 'image');
  document.getElementById('wm-text-options').style.display = type === 'text' ? '' : 'none';
  document.getElementById('wm-image-options').style.display = type === 'image' ? '' : 'none';
  schedulePreview();
}

function setPosition(pos) {
  wmPosition = pos;
  document.querySelectorAll('#wm-pos-grid button').forEach(b => {
    b.classList.toggle('active', b.dataset.pos === pos);
  });
  document.getElementById('wm-tile-spacing-field').style.display = pos === 'tiled' ? '' : 'none';
  schedulePreview();
}

function setWmScope(s) {
  wmScope = s;
  document.getElementById('wm-scope-current').classList.toggle('active', s === 'current');
  document.getElementById('wm-scope-all').classList.toggle('active', s === 'all');
  const btn = document.getElementById('wm-apply-btn');
  btn.textContent = s === 'current' ? 'Apply to current slide' : 'Apply to all ' + NUM_SLIDES + ' slides';
}

function setRotation(deg) {
  document.getElementById('wm-rotation').value = deg;
  onRotationInput();
}

function onFontScaleInput() {
  const v = parseFloat(document.getElementById('wm-font-scale').value);
  document.getElementById('wm-font-scale-val').textContent = (v * 100).toFixed(1) + '%';
  schedulePreview();
}
function onRotationInput() {
  const v = parseFloat(document.getElementById('wm-rotation').value);
  document.getElementById('wm-rotation-val').textContent = v + '°';
  schedulePreview();
}
function onOpacityInput() {
  const v = parseFloat(document.getElementById('wm-opacity').value);
  document.getElementById('wm-opacity-val').textContent = Math.round(v * 100) + '%';
  schedulePreview();
}
function onTileSpacingInput() {
  const v = parseFloat(document.getElementById('wm-tile-spacing').value);
  document.getElementById('wm-tile-spacing-val').textContent = v.toFixed(1) + '×';
  schedulePreview();
}
function onImageScaleInput() {
  const v = parseFloat(document.getElementById('wm-scale').value);
  document.getElementById('wm-scale-val').textContent = Math.round(v * 100) + '%';
  // Image preview is client-side only; trigger image preview re-render
  renderImagePreview();
}

function previewWmImage(input) {
  if (!input.files[0]) return;
  const url = URL.createObjectURL(input.files[0]);
  const preview = document.getElementById('wm-image-preview');
  preview.src = url;
  document.getElementById('wm-img-preview-wrap').style.display = '';
  document.getElementById('wm-image-name').textContent = input.files[0].name;
  renderImagePreview();
}

function renderImagePreview() {
  // Compose the user-selected image at the chosen scale/position over the slide thumbnail.
  // Pure client-side — no API call.
  if (wmType !== 'image') return;
  const fileInput = document.getElementById('wm-image-input');
  if (!fileInput.files[0]) return;
  const wmImgEl = document.getElementById('wm-image-preview');
  const baseImg = new Image();
  const previewImg = document.getElementById('wm-preview-img');
  const pad = String(currentSlide).padStart(2, '0');
  baseImg.crossOrigin = 'anonymous';
  baseImg.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = Math.round(800 * baseImg.height / baseImg.width);
    const c = canvas.getContext('2d');
    c.drawImage(baseImg, 0, 0, canvas.width, canvas.height);
    const scale = parseFloat(document.getElementById('wm-scale').value);
    const opacity = parseFloat(document.getElementById('wm-opacity').value);
    const W = Math.max(8, Math.round(canvas.width * scale));
    const H = Math.max(8, Math.round(W * wmImgEl.naturalHeight / Math.max(1, wmImgEl.naturalWidth)));
    let x = 20, y = 20;
    if (wmPosition === 'center') { x = (canvas.width - W) / 2; y = (canvas.height - H) / 2; }
    else if (wmPosition === 'top-right') { x = canvas.width - W - 20; y = 20; }
    else if (wmPosition === 'bottom-left') { x = 20; y = canvas.height - H - 20; }
    else if (wmPosition === 'bottom-right') { x = canvas.width - W - 20; y = canvas.height - H - 20; }
    c.globalAlpha = opacity;
    if (wmPosition === 'tiled') {
      const sp = 1.0;
      for (let tx = 0; tx < canvas.width; tx += W + 60 * sp) {
        for (let ty = 0; ty < canvas.height; ty += H + 40 * sp) {
          c.drawImage(wmImgEl, tx, ty, W, H);
        }
      }
    } else {
      c.drawImage(wmImgEl, x, y, W, H);
    }
    c.globalAlpha = 1;
    previewImg.src = canvas.toDataURL('image/jpeg', 0.82);
  };
  baseImg.src = '/static/slides/slide-' + pad + '.jpg?t=' + Date.now();
}

function schedulePreview() {
  clearTimeout(wmPreviewTimer);
  if (wmType === 'image') { renderImagePreview(); return; }
  wmPreviewTimer = setTimeout(renderTextPreview, 250);
}

async function renderTextPreview() {
  const box = document.getElementById('wm-preview-box');
  box.classList.add('loading');
  try {
    const body = {
      text: document.getElementById('wm-text').value || 'CONFIDENTIAL',
      opacity: parseFloat(document.getElementById('wm-opacity').value),
      position: wmPosition,
      color: document.getElementById('wm-color').value,
      font_scale: parseFloat(document.getElementById('wm-font-scale').value),
      rotation: parseFloat(document.getElementById('wm-rotation').value),
      tile_spacing: parseFloat(document.getElementById('wm-tile-spacing').value),
    };
    const resp = await fetch('/api/watermark/preview/' + currentSlide, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (data.preview) document.getElementById('wm-preview-img').src = data.preview;
  } catch (e) {
    // Silent — preview is best-effort
  } finally {
    box.classList.remove('loading');
  }
}

function reloadAllSlides() {
  const t = Date.now();
  for (let i = 1; i <= NUM_SLIDES; i++) {
    const pad = String(i).padStart(2, '0');
    const thumb = document.querySelector('#thumb-' + i + ' img');
    if (thumb) thumb.src = '/static/slides/slide-' + pad + '.jpg?t=' + t;
  }
  const pad = String(currentSlide).padStart(2, '0');
  slideImg.src = '/static/slides/slide-' + pad + '.jpg?t=' + t;
}

function _undoToastAction(snapshot) {
  if (!snapshot) return '';
  return ' <a href="#" onclick="event.preventDefault();undoWatermark(\'' + escapeJs(snapshot) + '\')" style="color:var(--accent2);font-weight:600;margin-left:8px">Undo</a>';
}

async function undoWatermark(snapshot) {
  showLoading('Undoing...');
  try {
    const resp = await fetch('/api/history/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: snapshot }),
    });
    hideLoading();
    const data = await resp.json();
    if (data.ok) {
      reloadAllSlides();
      showToast('Reverted', 'success');
    } else {
      showToast(data.error || 'Undo failed', 'error');
    }
  } catch (e) { hideLoading(); showToast('Undo error: ' + e.message, 'error'); }
}

function _parseSkipSlides(str) {
  // "2,4,7-9" → [2,4,7,8,9]. Invalid tokens are silently skipped.
  if (!str) return [];
  const out = new Set();
  String(str).split(',').forEach(tok => {
    tok = tok.trim();
    if (!tok) return;
    const m = tok.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      let a = parseInt(m[1], 10), b = parseInt(m[2], 10);
      if (a > b) { const t = a; a = b; b = t; }
      for (let i = a; i <= b; i++) if (i >= 1) out.add(i);
    } else if (/^\d+$/.test(tok)) {
      const n = parseInt(tok, 10);
      if (n >= 1) out.add(n);
    }
  });
  return Array.from(out).sort((a, b) => a - b);
}

async function applyWatermark() {
  const opacity = parseFloat(document.getElementById('wm-opacity').value);
  const skipInput = document.getElementById('wm-skip');
  const skipSlides = skipInput ? _parseSkipSlides(skipInput.value) : [];

  if (wmType === 'image') {
    const fileInput = document.getElementById('wm-image-input');
    if (!fileInput.files[0]) { showToast('Select an image first', 'error'); return; }
    const scale = parseFloat(document.getElementById('wm-scale').value);
    showLoading(wmScope === 'current' ? 'Applying...' : 'Applying to all slides...');
    const form = new FormData();
    form.append('image', fileInput.files[0]);
    form.append('opacity', opacity);
    form.append('position', wmPosition);
    form.append('scale', scale);
    form.append('scope', wmScope);
    form.append('slide_num', currentSlide);
    if (skipSlides.length) form.append('skip_slides', skipSlides.join(','));
    try {
      const resp = await fetch('/api/watermark-image', { method: 'POST', body: form });
      hideLoading();
      const data = await resp.json();
      if (data.ok) {
        closeWatermarkModal();
        reloadAllSlides();
        showToast('Watermark applied to ' + data.count + ' slide' + (data.count === 1 ? '' : 's') + '.', 'success', 5000);
        wmLastSnapshot = data.snapshot;
        // Inject Undo link
        const toast = document.getElementById('toast');
        if (data.snapshot && toast) {
          toast.querySelector('span').innerHTML += _undoToastAction(data.snapshot);
        }
      } else { showToast(data.error || 'Failed', 'error'); }
    } catch (e) { hideLoading(); showToast('Error: ' + e.message, 'error'); }
  } else {
    const text = document.getElementById('wm-text').value.trim();
    if (!text) { showToast('Enter watermark text', 'error'); return; }
    showLoading(wmScope === 'current' ? 'Applying...' : 'Applying to all slides...');
    try {
      const resp = await fetch('/api/watermark', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'text', text, opacity, position: wmPosition,
          color: document.getElementById('wm-color').value,
          font_scale: parseFloat(document.getElementById('wm-font-scale').value),
          rotation: parseFloat(document.getElementById('wm-rotation').value),
          tile_spacing: parseFloat(document.getElementById('wm-tile-spacing').value),
          scope: wmScope,
          slide_num: currentSlide,
          skip_slides: skipSlides,
        }),
      });
      hideLoading();
      const data = await resp.json();
      if (data.ok) {
        closeWatermarkModal();
        reloadAllSlides();
        showToast('Watermark applied to ' + data.count + ' slide' + (data.count === 1 ? '' : 's') + '.', 'success', 5000);
        wmLastSnapshot = data.snapshot;
        refreshAppliedBadge();
        const toast = document.getElementById('toast');
        if (data.snapshot && toast) {
          toast.querySelector('span').innerHTML += _undoToastAction(data.snapshot);
        }
      } else { showToast(data.error || 'Failed', 'error'); }
    } catch (e) { hideLoading(); showToast('Error: ' + e.message, 'error'); }
  }
}

// ── Detect & Remove ─────────────────────────────────────────────────────────

async function detectWatermarks() {
  const scanBtn = document.getElementById('wm-scan-btn');
  scanBtn.classList.add('loading');
  scanBtn.disabled = true;
  try {
    const resp = await fetch('/api/detect-watermark/' + currentSlide, { method: 'POST' });
    const data = await resp.json();
    wmDetectCandidates = data.candidates || [];
    wmSelectedCandidates = new Set(wmDetectCandidates.map((_, i) => i)); // select all by default
    renderDetectResults();
  } catch (e) {
    showToast('Detection failed: ' + e.message, 'error');
  } finally {
    scanBtn.classList.remove('loading');
    scanBtn.disabled = false;
  }
}

function renderDetectResults() {
  const container = document.getElementById('wm-candidates');
  const actions = document.getElementById('wm-detect-actions');
  const countEl = document.getElementById('wm-detect-count');
  const overlay = document.getElementById('wm-detect-overlay');

  if (wmDetectCandidates.length === 0) {
    container.innerHTML = '<div class="empty-state" style="padding:24px"><div>No watermarks detected on this slide.</div><div style="font-size:11px;margin-top:6px">Try the &ldquo;Draw custom region&rdquo; button below the preview.</div></div>';
    actions.style.display = 'none';
    countEl.textContent = '';
    overlay.innerHTML = '';
    return;
  }
  countEl.textContent = wmDetectCandidates.length + ' candidate' + (wmDetectCandidates.length === 1 ? '' : 's');
  actions.style.display = '';
  document.getElementById('wm-select-all').checked = wmSelectedCandidates.size === wmDetectCandidates.length;

  container.innerHTML = wmDetectCandidates.map((c, i) => {
    const loc = c.location.replace('-', ' ').replace(/\b\w/g, l => l.toUpperCase());
    const checked = wmSelectedCandidates.has(i) ? 'checked' : '';
    const sel = wmSelectedCandidates.has(i) ? ' selected' : '';
    return '<label class="wm-cand-item' + sel + '" onmouseenter="highlightCandidate(' + i + ',true)" onmouseleave="highlightCandidate(' + i + ',false)">' +
      '<input type="checkbox" ' + checked + ' onchange="toggleCandidate(' + i + ')">' +
      '<div style="flex:1;display:flex;flex-direction:column;gap:2px">' +
        '<div class="wm-cand-name">' + escapeHtml(loc) + '</div>' +
        (c.note ? '<div class="wm-cand-note">' + escapeHtml(c.note) + '</div>' : '') +
      '</div>' +
      '<span class="wm-cand-conf">' + Math.round(c.confidence) + '%</span>' +
    '</label>';
  }).join('');

  // Render SVG region overlays
  overlay.innerHTML = wmDetectCandidates.map((c, i) => {
    const cls = wmSelectedCandidates.has(i) ? 'wm-region selected' : 'wm-region';
    return '<rect class="' + cls + '" data-i="' + i + '"' +
      ' x="' + (c.x * 100) + '" y="' + (c.y * 100) + '"' +
      ' width="' + (c.w * 100) + '" height="' + (c.h * 100) + '"></rect>';
  }).join('');
}

function highlightCandidate(i, on) {
  const overlay = document.getElementById('wm-detect-overlay');
  const rect = overlay.querySelector('rect[data-i="' + i + '"]');
  if (rect) rect.classList.toggle('hover', on);
}

function toggleCandidate(i) {
  if (wmSelectedCandidates.has(i)) wmSelectedCandidates.delete(i);
  else wmSelectedCandidates.add(i);
  renderDetectResults();
}

function toggleSelectAllCandidates() {
  if (wmSelectedCandidates.size === wmDetectCandidates.length) {
    wmSelectedCandidates.clear();
  } else {
    wmSelectedCandidates = new Set(wmDetectCandidates.map((_, i) => i));
  }
  renderDetectResults();
}

async function bulkRemove(scope) {
  // Collect selected candidate regions + any custom region
  const regions = [];
  wmSelectedCandidates.forEach(i => regions.push(wmDetectCandidates[i]));
  if (wmCustomRegion) regions.push(wmCustomRegion);
  if (regions.length === 0) {
    showToast('Select a region or check at least one candidate', 'error');
    return;
  }
  const count = scope === 'all' ? NUM_SLIDES : 1;
  if (!confirm('Remove ' + regions.length + ' region(s) from ' + (scope === 'all' ? 'ALL ' + NUM_SLIDES + ' slides' : 'this slide') + '?\n\nThis edits the image. A history snapshot is saved so you can undo.')) return;

  showLoading('Removing watermark from ' + count + ' slide' + (count === 1 ? '' : 's') + '...');
  try {
    const url = scope === 'all' ? '/api/remove-watermark-all' : '/api/remove-watermark/' + currentSlide;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ regions }),
    });
    hideLoading();
    const data = await resp.json();
    if (data.ok) {
      closeWatermarkModal();
      reloadAllSlides();
      showToast('Removed from ' + (data.slides || 1) + ' slide(s).', 'success', 5000);
      const toast = document.getElementById('toast');
      if (data.snapshot && toast) {
        toast.querySelector('span').innerHTML += _undoToastAction(data.snapshot);
      }
    } else { showToast(data.error || 'Failed', 'error'); }
  } catch (e) { hideLoading(); showToast('Error: ' + e.message, 'error'); }
}

// ── Custom region drawing on the detect preview ────────────────────────────

function toggleDrawRegion() {
  wmDrawMode = !wmDrawMode;
  const box = document.getElementById('wm-detect-preview-box');
  const hint = document.getElementById('wm-draw-hint');
  const link = document.getElementById('wm-draw-toggle');
  box.classList.toggle('drawing', wmDrawMode);
  hint.style.display = wmDrawMode ? '' : 'none';
  link.textContent = wmDrawMode ? '✕ Cancel drawing' : '+ Draw custom region';
}

function _wmDetectMouseToNorm(e) {
  const box = document.getElementById('wm-detect-preview-box');
  const r = box.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
    y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
  };
}

document.addEventListener('mousedown', e => {
  if (!wmDrawMode) return;
  const box = document.getElementById('wm-detect-preview-box');
  if (!box.contains(e.target)) return;
  e.preventDefault();
  const p = _wmDetectMouseToNorm(e);
  wmDrawing = { sx: p.x, sy: p.y };
});
document.addEventListener('mousemove', e => {
  if (!wmDrawMode || !wmDrawing) return;
  const p = _wmDetectMouseToNorm(e);
  const x = Math.min(wmDrawing.sx, p.x);
  const y = Math.min(wmDrawing.sy, p.y);
  const w = Math.abs(p.x - wmDrawing.sx);
  const h = Math.abs(p.y - wmDrawing.sy);
  const overlay = document.getElementById('wm-detect-overlay');
  // Render base regions + the live draw rect
  const base = wmDetectCandidates.map((c, i) => {
    const cls = wmSelectedCandidates.has(i) ? 'wm-region selected' : 'wm-region';
    return '<rect class="' + cls + '" x="' + (c.x*100) + '" y="' + (c.y*100) + '" width="' + (c.w*100) + '" height="' + (c.h*100) + '"></rect>';
  }).join('');
  overlay.innerHTML = base + '<rect class="wm-draw-rect" x="' + (x*100) + '" y="' + (y*100) + '" width="' + (w*100) + '" height="' + (h*100) + '"></rect>';
});
document.addEventListener('mouseup', e => {
  if (!wmDrawMode || !wmDrawing) return;
  const p = _wmDetectMouseToNorm(e);
  const x = Math.min(wmDrawing.sx, p.x);
  const y = Math.min(wmDrawing.sy, p.y);
  const w = Math.abs(p.x - wmDrawing.sx);
  const h = Math.abs(p.y - wmDrawing.sy);
  wmDrawing = null;
  if (w < 0.01 || h < 0.01) return;
  wmCustomRegion = { x, y, w, h };
  // Add it as a "candidate" so the rest of the bulk-remove UX works
  const idx = wmDetectCandidates.length;
  wmDetectCandidates.push({
    location: 'custom', x, y, w, h,
    confidence: 100, note: 'user-drawn region',
  });
  wmSelectedCandidates.add(idx);
  wmDrawMode = false;
  document.getElementById('wm-detect-preview-box').classList.remove('drawing');
  document.getElementById('wm-draw-hint').style.display = 'none';
  document.getElementById('wm-draw-toggle').textContent = '+ Draw custom region';
  renderDetectResults();
});

// ── Applied watermarks: list / revert / clear ─────────────────────────────

async function refreshAppliedBadge() {
  try {
    const resp = await fetch('/api/watermarks/applied');
    const data = await resp.json();
    const badge = document.getElementById('wm-applied-badge');
    const revertable = (data.entries || []).filter(e => e.revertable).length;
    if (revertable > 0) {
      badge.textContent = revertable;
      badge.style.display = '';
    } else {
      badge.style.display = 'none';
    }
  } catch (e) { /* silent */ }
  // Also refresh the global undo/redo button state — every destructive action
  // changes what Ctrl+Z would target next.
  refreshServerUndoState();
}

async function loadAppliedWatermarks() {
  const listEl = document.getElementById('wm-applied-list');
  listEl.innerHTML = '<div class="empty-state" style="padding:24px">Loading...</div>';
  try {
    const resp = await fetch('/api/watermarks/applied');
    const data = await resp.json();
    const entries = data.entries || [];
    if (entries.length === 0) {
      listEl.innerHTML = '<div class="empty-state" style="padding:32px"><div>No watermarks applied yet.</div><div style="font-size:11px;margin-top:6px">Apply one from the <strong>Add</strong> tab to see it here.</div></div>';
      return;
    }
    listEl.innerHTML = entries.map(e => renderAppliedEntry(e)).join('');
  } catch (e) {
    listEl.innerHTML = '<div class="empty-state" style="padding:24px;color:var(--red)">Failed to load: ' + escapeHtml(e.message) + '</div>';
  }
}

function renderAppliedEntry(e) {
  const isOrphan = !!e.orphan;
  let swatch, title;
  // SVG icons keyed by kind
  const ICONS = {
    crop:        '<path d="M6 2v14a2 2 0 002 2h14"/><path d="M18 22V8a2 2 0 00-2-2H2"/>',
    rotate:      '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15A9 9 0 1 1 18 6.36L23 10"/>',
    bake:        '<path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/>',
    'remove-logo':'<circle cx="12" cy="12" r="10"/><path d="M4.93 4.93l14.14 14.14"/>',
    'find-replace':'<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
    reorder:     '<line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/>',
    'load-template':'<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>',
    'restore-version':'<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 102.13-9.36L1 10"/>',
  };
  // Friendly kind labels
  const KIND_LABEL = {
    filters: 'Filters', crop: 'Crop', rotate: 'Rotate', bake: 'Bake overlays',
    'remove-logo': 'Remove logo', 'find-replace': 'Find & replace',
    reorder: 'Reorder', 'load-template': 'Load template',
    'restore-version': 'Restore version',
  };
  if (e.kind === 'filters') {
    swatch = '<div class="wm-applied-swatch" style="color:var(--accent2)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="12" cy="18" r="3"/></svg></div>';
    title = escapeHtml('Filters: ' + (e.text || 'no changes'));
  } else if (e.kind === 'text') {
    swatch = '<div class="wm-applied-swatch" style="color:' + escapeAttr(e.color || '#888') + '">A</div>';
    title = escapeHtml(e.text || '(empty)');
  } else if (ICONS[e.kind]) {
    swatch = '<div class="wm-applied-swatch" style="color:var(--accent2)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' + ICONS[e.kind] + '</svg></div>';
    title = escapeHtml(KIND_LABEL[e.kind] || e.kind) + ' — ' + escapeHtml(e.text || '');
  } else {
    swatch = '<div class="wm-applied-swatch"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="M21 15l-5-5L5 21"/></svg></div>';
    title = escapeHtml(e.filename || 'Image watermark');
  }
  const scopeLabel = e.scope === 'current'
    ? 'Slide ' + (e.slide_num || '?')
    : (e.count || 0) + ' slides';
  const posLabel = (e.position || '').replace('-', ' ');
  const ts = (e.timestamp || '').replace('T', ' ');
  const tags = [
    isOrphan ? '<span class="wm-tag" style="background:rgba(251,191,36,0.12);color:var(--orange)">Earlier session</span>' : '',
    !isOrphan ? '<span class="wm-tag">' + escapeHtml(scopeLabel) + '</span>' : '',
    posLabel && !isOrphan ? '<span class="wm-tag dim">' + escapeHtml(posLabel) + '</span>' : '',
    e.rotation && !isOrphan ? '<span class="wm-tag dim">' + Math.round(e.rotation) + '°</span>' : '',
    ts ? '<span class="wm-tag dim">' + escapeHtml(ts) + '</span>' : '',
    isOrphan && e.count ? '<span class="wm-tag dim">' + e.count + ' slides in snapshot</span>' : '',
  ].filter(Boolean).join('');
  const revertBtn = e.revertable
    ? '<button class="btn btn-danger btn-sm" onclick="revertAppliedWatermark(\'' + escapeJs(e.id) + '\',\'' + escapeJs(title) + '\')">Revert</button>'
    : '<span style="font-size:10px;color:var(--text3)">Snapshot lost</span>';
  return '<div class="wm-applied-item' + (e.revertable ? '' : ' stale') + '">' +
    swatch +
    '<div class="wm-applied-main">' +
      '<div class="wm-applied-title">' + title + '</div>' +
      '<div class="wm-applied-meta">' + tags + '</div>' +
    '</div>' +
    revertBtn +
  '</div>';
}

async function revertAppliedWatermark(id, title) {
  if (!confirm('Revert this watermark: "' + title + '"?\n\nThis restores the slide images to the snapshot taken before this watermark was applied. Any watermarks applied AFTER this one will also be removed from the log (since the disk no longer matches).')) return;
  showLoading('Reverting...');
  try {
    const resp = await fetch('/api/watermarks/revert/' + encodeURIComponent(id), { method: 'POST' });
    hideLoading();
    const data = await resp.json();
    if (data.ok) {
      reloadAllSlides();
      loadAppliedWatermarks();
      refreshAppliedBadge();
      const msg = data.dropped > 1
        ? 'Reverted. ' + (data.dropped - 1) + ' later watermark(s) also removed from the log.'
        : 'Watermark reverted.';
      showToast(msg, 'success', 4500);
    } else {
      showToast(data.error || 'Revert failed', 'error');
    }
  } catch (e) { hideLoading(); showToast('Error: ' + e.message, 'error'); }
}

async function clearAppliedLog() {
  if (!confirm('Clear the watermark log?\n\nThis hides all current entries (including the "Earlier session" orphans detected from history snapshots). Slide images and the underlying history snapshots are NOT touched — you can still revert them from the History modal.')) return;
  try {
    await fetch('/api/watermarks/clear-log', { method: 'POST' });
    loadAppliedWatermarks();
    refreshAppliedBadge();
    showToast('Log cleared', 'success');
  } catch (e) { showToast('Error: ' + e.message, 'error'); }
}

// Initialise the badge on load (after the page mounts).
window.addEventListener('load', refreshAppliedBadge);

// ══════════════════════════════════════════════════════════════════════════
// CROP TOOL
// ══════════════════════════════════════════════════════════════════════════
let cropMode = false;
let cropStart = null;
let cropRect = null;

function startCrop() {
  cropMode = true;
  cropStart = null;
  cropRect = null;
  canvas.style.cursor = 'crosshair';
  showToast('Draw a crop rectangle on the slide', 'info', 3000);
}

canvas.addEventListener('mousedown', function cropMouseDown(e) {
  if (!cropMode || e.button !== 0) return;
  e.stopImmediatePropagation();
  cropStart = { x: normX(e.clientX), y: normY(e.clientY) };
}, true);

canvas.addEventListener('mousemove', function cropMouseMove(e) {
  if (!cropMode || !cropStart) return;
  e.stopImmediatePropagation();
  const nx = normX(e.clientX), ny = normY(e.clientY);
  cropRect = {
    x: Math.min(cropStart.x, nx), y: Math.min(cropStart.y, ny),
    w: Math.abs(nx - cropStart.x), h: Math.abs(ny - cropStart.y)
  };
  renderOverlays();
  // Draw crop rect
  ctx.save();
  ctx.strokeStyle = '#34d399';
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 4]);
  ctx.strokeRect(cropRect.x * canvas.width, cropRect.y * canvas.height, cropRect.w * canvas.width, cropRect.h * canvas.height);
  // Dim outside
  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  ctx.fillRect(0, 0, canvas.width, cropRect.y * canvas.height);
  ctx.fillRect(0, (cropRect.y + cropRect.h) * canvas.height, canvas.width, canvas.height);
  ctx.fillRect(0, cropRect.y * canvas.height, cropRect.x * canvas.width, cropRect.h * canvas.height);
  ctx.fillRect((cropRect.x + cropRect.w) * canvas.width, cropRect.y * canvas.height, canvas.width, cropRect.h * canvas.height);
  ctx.restore();
}, true);

canvas.addEventListener('mouseup', function cropMouseUp(e) {
  if (!cropMode || !cropStart) return;
  e.stopImmediatePropagation();
  cropStart = null;
  if (cropRect && cropRect.w > 0.02 && cropRect.h > 0.02) {
    if (confirm('Apply this crop to the slide?')) {
      applyCrop(cropRect);
    }
  }
  cropMode = false;
  cropRect = null;
  canvas.style.cursor = currentTool === 'select' ? 'default' : 'crosshair';
  renderOverlays();
}, true);

async function applyCrop(rect) {
  showLoading('Cropping slide...');
  try {
    const resp = await fetch(`/api/slide/${currentSlide}/crop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ x: rect.x, y: rect.y, w: rect.w, h: rect.h })
    });
    hideLoading();
    const data = await resp.json();
    if (data.ok || resp.ok) {
      const pad = String(currentSlide).padStart(2, '0');
      slideImg.src = `/static/slides/slide-${pad}.jpg?t=${Date.now()}`;
      const thumb = document.querySelector(`#thumb-${currentSlide} img`);
      if (thumb) thumb.src = slideImg.src;
      showToast('Slide cropped!', 'success');
    } else {
      showToast(data.error || 'Crop failed', 'error');
    }
  } catch (e) {
    hideLoading();
    showToast('Crop error: ' + e.message, 'error');
  }
}

// ══════════════════════════════════════════════════════════════════════════
// ROTATE SLIDE
// ══════════════════════════════════════════════════════════════════════════
async function rotateSlide(angle) {
  showLoading('Rotating slide...');
  try {
    const resp = await fetch(`/api/slide/${currentSlide}/rotate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ angle })
    });
    hideLoading();
    const data = await resp.json();
    if (data.ok || resp.ok) {
      const pad = String(currentSlide).padStart(2, '0');
      slideImg.src = `/static/slides/slide-${pad}.jpg?t=${Date.now()}`;
      const thumb = document.querySelector(`#thumb-${currentSlide} img`);
      if (thumb) thumb.src = slideImg.src;
      showToast(`Rotated ${angle === 90 ? 'CW' : 'CCW'}!`, 'success');
    } else {
      showToast(data.error || 'Rotate failed', 'error');
    }
  } catch (e) {
    hideLoading();
    showToast('Rotate error: ' + e.message, 'error');
  }
}

// ══════════════════════════════════════════════════════════════════════════
// FIND & REPLACE
// ══════════════════════════════════════════════════════════════════════════
function openFindReplaceModal() {
  document.getElementById('findreplace-modal').classList.add('show');
  document.getElementById('fr-find').focus();
  document.getElementById('fr-result').textContent = '';
}

async function doFindReplace() {
  const find = document.getElementById('fr-find').value;
  const replace = document.getElementById('fr-replace').value;
  if (!find) { showToast('Enter search text', 'error'); return; }
  showLoading('Finding & replacing...');
  try {
    const resp = await fetch('/api/find-replace', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ find, replace })
    });
    hideLoading();
    const data = await resp.json();
    if (data.replacements !== undefined) {
      document.getElementById('fr-result').textContent = `Replaced ${data.replacements} occurrence(s)`;
      if (data.replacements > 0) {
        // Reload current slide
        const pad = String(currentSlide).padStart(2, '0');
        slideImg.src = `/static/slides/slide-${pad}.jpg?t=${Date.now()}`;
        showToast(`${data.replacements} replacement(s) made`, 'success');
      } else {
        showToast('No matches found', 'info');
      }
    } else {
      showToast(data.error || 'Find/replace failed', 'error');
    }
  } catch (e) {
    hideLoading();
    showToast('Find/replace error: ' + e.message, 'error');
  }
}

// ══════════════════════════════════════════════════════════════════════════
// VERSION HISTORY
// ══════════════════════════════════════════════════════════════════════════
function openHistoryModal() {
  document.getElementById('history-modal').classList.add('show');
  loadHistory();
}

async function loadHistory() {
  const listEl = document.getElementById('history-list');
  listEl.innerHTML = '<div class="empty-state" style="padding:16px">Loading...</div>';
  try {
    const resp = await fetch('/api/history');
    const data = await resp.json();
    const versions = data.versions || [];
    if (versions.length === 0) {
      listEl.innerHTML = '<div class="empty-state" style="padding:16px">No saved versions yet</div>';
      return;
    }
    listEl.innerHTML = versions.map(v => `
      <div class="list-item" onclick="restoreVersion('${escapeJs(v.version)}')">
        <div>
          <div class="list-item-name">${escapeHtml(v.version)}</div>
          <div class="list-item-meta">${escapeHtml(v.slides || '?')} slides</div>
        </div>
      </div>
    `).join('');
  } catch (e) {
    listEl.innerHTML = '<div class="empty-state" style="padding:16px">Failed to load history</div>';
  }
}

async function saveVersion() {
  await saveCurrentSlide(true);
  showLoading('Saving version...');
  try {
    const resp = await fetch('/api/history/save', { method: 'POST' });
    hideLoading();
    const data = await resp.json();
    if (data.version) {
      showToast(`Version saved: ${data.version}`, 'success');
      loadHistory();
    } else {
      showToast(data.error || 'Save version failed', 'error');
    }
  } catch (e) {
    hideLoading();
    showToast('Error: ' + e.message, 'error');
  }
}

async function restoreVersion(version) {
  if (!confirm(`Restore version "${version}"? Current changes will be overwritten.`)) return;
  showLoading('Restoring version...');
  try {
    const resp = await fetch('/api/history/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version })
    });
    hideLoading();
    const data = await resp.json();
    if (data.ok || resp.ok) {
      document.getElementById('history-modal').classList.remove('show');
      showToast('Version restored! Reloading...', 'success');
      setTimeout(() => location.reload(), 800);
    } else {
      showToast(data.error || 'Restore failed', 'error');
    }
  } catch (e) {
    hideLoading();
    showToast('Restore error: ' + e.message, 'error');
  }
}

// ══════════════════════════════════════════════════════════════════════════
// TEMPLATES
// ══════════════════════════════════════════════════════════════════════════
function openTemplatesModal() {
  document.getElementById('templates-modal').classList.add('show');
  loadTemplates();
}

async function loadTemplates() {
  const listEl = document.getElementById('templates-list');
  listEl.innerHTML = '<div class="empty-state" style="padding:16px">Loading...</div>';
  try {
    const resp = await fetch('/api/templates');
    const data = await resp.json();
    const templates = data.templates || [];
    if (templates.length === 0) {
      listEl.innerHTML = '<div class="empty-state" style="padding:16px">No templates saved yet</div>';
      return;
    }
    listEl.innerHTML = templates.map(t => `
      <div class="list-item">
        <div onclick="loadTemplate('${escapeJs(t.name)}')" style="flex:1;cursor:pointer">
          <div class="list-item-name">${escapeHtml(t.name)}</div>
          <div class="list-item-meta">${escapeHtml(t.slides || '?')} slides${t.created ? ' &middot; ' + escapeHtml(t.created) : ''}</div>
        </div>
        <div class="list-item-actions">
          <button class="btn btn-danger btn-sm" onclick="event.stopPropagation();deleteTemplate('${escapeJs(t.name)}')">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3,6 5,6 21,6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
          </button>
        </div>
      </div>
    `).join('');
  } catch (e) {
    listEl.innerHTML = '<div class="empty-state" style="padding:16px">Failed to load templates</div>';
  }
}

async function saveTemplate() {
  const name = document.getElementById('tpl-name').value.trim();
  if (!name) { showToast('Enter a template name', 'error'); return; }
  await saveCurrentSlide(true);
  showLoading('Saving template...');
  try {
    const resp = await fetch('/api/templates/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    hideLoading();
    const data = await resp.json();
    if (data.ok || resp.ok) {
      showToast(`Template "${name}" saved!`, 'success');
      document.getElementById('tpl-name').value = '';
      loadTemplates();
    } else {
      showToast(data.error || 'Save template failed', 'error');
    }
  } catch (e) {
    hideLoading();
    showToast('Error: ' + e.message, 'error');
  }
}

async function loadTemplate(name) {
  if (!confirm(`Load template "${name}"? Current presentation will be replaced.`)) return;
  showLoading('Loading template...');
  try {
    const resp = await fetch('/api/templates/load', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    hideLoading();
    const data = await resp.json();
    if (data.ok || resp.ok) {
      document.getElementById('templates-modal').classList.remove('show');
      showToast('Template loaded! Reloading...', 'success');
      setTimeout(() => location.reload(), 800);
    } else {
      showToast(data.error || 'Load template failed', 'error');
    }
  } catch (e) {
    hideLoading();
    showToast('Load error: ' + e.message, 'error');
  }
}

async function deleteTemplate(name) {
  if (!confirm(`Delete template "${name}"?`)) return;
  try {
    const resp = await fetch('/api/templates/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    const data = await resp.json();
    if (data.ok || resp.ok) {
      showToast('Template deleted', 'success');
      loadTemplates();
    } else {
      showToast(data.error || 'Delete failed', 'error');
    }
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
}

// ══════════════════════════════════════════════════════════════════════════
// COMMENTS
// ══════════════════════════════════════════════════════════════════════════
let slideComments = [];

async function loadComments() {
  try {
    const resp = await fetch(`/api/comments/${currentSlide}`);
    const data = await resp.json();
    slideComments = data.comments || [];
    renderCommentsList();
    renderCommentPins();
  } catch (e) {
    slideComments = [];
  }
}

function renderCommentsList() {
  const listEl = document.getElementById('comments-list');
  if (slideComments.length === 0) {
    listEl.innerHTML = `<div class="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width:32px;height:32px;opacity:0.3"><path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z"/></svg>
      <div>No comments yet</div>
      <div style="font-size:11px;margin-top:4px">Use the comment tool to add pins on the canvas</div>
    </div>`;
    return;
  }
  listEl.innerHTML = slideComments.map((c, i) => `
    <div class="comment-item ${c.resolved ? 'resolved' : ''}">
      <div class="comment-author">${escapeHtml(c.author || 'User')}</div>
      <div class="comment-text">${escapeHtml(c.text)}</div>
      <div class="comment-meta">${escapeHtml(c.timestamp || '')}</div>
      <div class="comment-actions">
        ${!c.resolved ? `<button class="btn btn-glass btn-sm" onclick="resolveComment(${i})">Resolve</button>` : '<span style="font-size:11px;color:var(--green)">Resolved</span>'}
        <button class="btn btn-danger btn-sm" onclick="deleteComment(${i})">Delete</button>
      </div>
    </div>
  `).join('');
}

function renderCommentPins() {
  // Remove existing pins
  document.querySelectorAll('.comment-pin').forEach(p => p.remove());
  slideComments.forEach((c, i) => {
    if (c.x !== undefined && c.y !== undefined) {
      const pin = document.createElement('div');
      pin.className = 'comment-pin' + (c.resolved ? ' resolved' : '');
      pin.textContent = i + 1;
      pin.style.left = (c.x * 100) + '%';
      pin.style.top = (c.y * 100) + '%';
      pin.title = c.text;
      pin.onclick = () => { switchTab('comments'); };
      container.appendChild(pin);
    }
  });
}

function submitComment() {
  const text = document.getElementById('comment-input').value.trim();
  if (!text || !pendingCommentPos) { cancelComment(); return; }
  document.getElementById('comment-popup').style.display = 'none';
  const body = { text, x: pendingCommentPos.x, y: pendingCommentPos.y, author: 'User' };
  fetch(`/api/comments/${currentSlide}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then(resp => resp.json()).then(data => {
    loadComments();
    showToast('Comment added!', 'success');
  }).catch(e => {
    showToast('Comment failed: ' + e.message, 'error');
  });
  pendingCommentPos = null;
  setTool('select');
}

function cancelComment() {
  document.getElementById('comment-popup').style.display = 'none';
  pendingCommentPos = null;
  setTool('select');
}

async function resolveComment(index) {
  try {
    await fetch(`/api/comments/${currentSlide}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index })
    });
    loadComments();
    showToast('Comment resolved', 'success');
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
}

async function deleteComment(index) {
  if (!confirm('Delete this comment?')) return;
  try {
    await fetch(`/api/comments/${currentSlide}/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index })
    });
    loadComments();
    showToast('Comment deleted', 'success');
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
}

// Close modals with Escape
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-backdrop.show').forEach(m => m.classList.remove('show'));
    document.getElementById('help-modal').classList.remove('show');
    cancelComment();
  }
  if (e.key === 'h' || e.key === 'H') openHelpModal();
});

// ══════════════════════════════════════════════════════════════════════════
// HELP MODAL
// ══════════════════════════════════════════════════════════════════════════
function openHelpModal() {
  document.getElementById('help-modal').classList.add('show');
}
function closeHelpModal() {
  document.getElementById('help-modal').classList.remove('show');
}
document.getElementById('help-modal').addEventListener('click', function(e) {
  if (e.target === this) closeHelpModal();
});

// ══════════════════════════════════════════════════════════════════════════
// DECK INFO / SLIDE STRUCTURE OPS
// ══════════════════════════════════════════════════════════════════════════
let currentDeckName = '';

async function refreshDeckInfo() {
  try {
    const resp = await fetch('/api/deck/info');
    if (!resp.ok) return;
    const data = await resp.json();
    const el = document.getElementById('deck-name');
    const txt = document.getElementById('deck-name-text');
    if (!el || !txt) return;
    if (data.deck_name) {
      currentDeckName = data.deck_name;
      txt.textContent = data.deck_name;
      el.classList.add('has-deck');
      el.title = data.deck_name;
    } else {
      currentDeckName = '';
      txt.textContent = 'No deck loaded';
      el.classList.remove('has-deck');
      el.title = 'No deck loaded';
    }
  } catch (e) {}
}

async function duplicateSlide() {
  if (!currentSlide) return;
  showLoading('Duplicating slide...');
  try {
    const resp = await fetch(`/api/slide/${currentSlide}/duplicate`, { method: 'POST' });
    const data = await resp.json();
    hideLoading();
    if (data.ok) {
      try { sessionStorage.setItem('current_slide', String(data.new_slide || currentSlide + 1)); } catch (e) {}
      showToast('Slide duplicated! Reloading...', 'success');
      setTimeout(() => location.reload(), 600);
    } else {
      showToast(data.error || 'Duplicate failed', 'error');
    }
  } catch (e) {
    hideLoading();
    showToast('Duplicate failed: ' + e.message, 'error');
  }
}

async function deleteSlide() {
  if (!currentSlide) return;
  const total = parseInt(document.getElementById('slide-total')?.textContent || '1', 10);
  if (total <= 1) {
    showToast('Cannot delete the only slide', 'error');
    return;
  }
  if (!confirm(`Delete slide ${currentSlide}? This can be undone with Ctrl+Z.`)) return;
  showLoading('Deleting slide...');
  try {
    const resp = await fetch(`/api/slide/${currentSlide}/delete`, { method: 'POST' });
    const data = await resp.json();
    hideLoading();
    if (data.ok) {
      const next = Math.min(currentSlide, data.num_slides);
      try { sessionStorage.setItem('current_slide', String(next)); } catch (e) {}
      showToast('Slide deleted! Reloading...', 'success');
      setTimeout(() => location.reload(), 600);
    } else {
      showToast(data.error || 'Delete failed', 'error');
    }
  } catch (e) {
    hideLoading();
    showToast('Delete failed: ' + e.message, 'error');
  }
}

function downloadSlidePNG() {
  if (!currentSlide) return;
  const a = document.createElement('a');
  a.href = `/api/slide/${currentSlide}/download.png`;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function printDeck() {
  const total = parseInt(document.getElementById('slide-total')?.textContent || '0', 10);
  if (!total) { showToast('No slides to print', 'error'); return; }
  const w = window.open('', '_blank');
  if (!w) { showToast('Popup blocked — allow popups to print', 'error'); return; }
  const imgs = [];
  for (let i = 1; i <= total; i++) {
    const n = String(i).padStart(2, '0');
    imgs.push(`<div class="page"><img src="/static/slides/slide-${n}.jpg?t=${Date.now()}" /></div>`);
  }
  w.document.write(`<!doctype html><html><head><title>Print Deck</title>
<style>
  @page { size: landscape; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fff; }
  .page { page-break-after: always; width: 100vw; height: 100vh;
          display: flex; align-items: center; justify-content: center; }
  .page:last-child { page-break-after: auto; }
  img { max-width: 100%; max-height: 100%; object-fit: contain; display: block; }
  @media print { .page { width: 100%; height: 100vh; } }
</style></head><body>${imgs.join('')}
<script>
  (function () {
    var imgs = document.images, left = imgs.length;
    if (!left) { window.print(); return; }
    for (var i = 0; i < imgs.length; i++) {
      if (imgs[i].complete) { if (--left === 0) setTimeout(function(){window.print();}, 200); }
      else imgs[i].addEventListener('load', function(){ if (--left === 0) setTimeout(function(){window.print();}, 200); });
      imgs[i].addEventListener('error', function(){ if (--left === 0) setTimeout(function(){window.print();}, 200); });
    }
  })();
<\/script>
</body></html>`);
  w.document.close();
}
