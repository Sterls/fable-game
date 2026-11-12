// Tiny drawing pad. Drawings are stored as strokes on a 256x256 grid and packed into a
// compact base64 string (2 bytes per point), so a whole drawing is a few KB to send.

export const PALETTE = ['#2f3437', '#c0614f', '#d39b3a', '#5f8575', '#4f78a8', '#8a6aa8'];
export const WIDTHS = [0.014, 0.034]; // fraction of canvas size
export const PAPER = '#fffdf9';
const MAX_POINTS = 4000;

export function encode(strokes) {
  const bytes = [];
  for (const s of strokes) {
    const n = s.p.length / 2;
    if (!n) continue;
    bytes.push(s.c & 255, s.w & 255, (n >> 8) & 255, n & 255, ...s.p);
  }
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function decode(str) {
  const strokes = [];
  try {
    const bin = atob(String(str || ''));
    let i = 0;
    while (i + 4 <= bin.length) {
      const c = bin.charCodeAt(i) % PALETTE.length;
      const w = bin.charCodeAt(i + 1) % WIDTHS.length;
      const n = (bin.charCodeAt(i + 2) << 8) | bin.charCodeAt(i + 3);
      i += 4;
      const p = [];
      for (let k = 0; k < n * 2 && i < bin.length; k++) p.push(bin.charCodeAt(i++));
      strokes.push({ c, w, p });
    }
  } catch {}
  return strokes;
}

export function pointCount(strokes) {
  return strokes.reduce((n, s) => n + s.p.length / 2, 0);
}

function stroke(ctx, s, size) {
  const k = size / 255;
  ctx.strokeStyle = PALETTE[s.c] || PALETTE[0];
  ctx.fillStyle = ctx.strokeStyle;
  ctx.lineWidth = Math.max(1, WIDTHS[s.w] * size);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const p = s.p;
  if (p.length === 2) {
    ctx.beginPath();
    ctx.arc(p[0] * k, p[1] * k, ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(p[0] * k, p[1] * k);
  for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i] * k, p[i + 1] * k);
  ctx.stroke();
}

function fit(canvas) {
  const css = canvas.clientWidth || canvas.width;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const px = Math.round(css * dpr);
  if (canvas.width !== px) { canvas.width = px; canvas.height = px; }
  return px;
}

export function paint(canvas, strokes) {
  const size = fit(canvas);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, size, size);
  for (const s of strokes) stroke(ctx, s, size);
}

// Render every <canvas data-art="..."> inside root (gallery thumbnails etc.).
export function paintAll(root, getArt) {
  root.querySelectorAll('canvas[data-art]').forEach((c) => {
    const data = getArt(c.dataset.art);
    if (c._painted === data) return;
    c._painted = data;
    paint(c, decode(data));
  });
}

// Attach drawing to a canvas. `state` = { strokes, color, width } is kept by the caller so
// the drawing survives re-renders; onChange fires after every finished stroke.
export function attachPad(canvas, state, onChange, onFull) {
  if (canvas._pad) return;
  canvas._pad = true;
  paint(canvas, state.strokes);
  let cur = null;
  const pt = (e) => {
    const r = canvas.getBoundingClientRect();
    const x = Math.round(((e.clientX - r.left) / r.width) * 255);
    const y = Math.round(((e.clientY - r.top) / r.height) * 255);
    return [Math.max(0, Math.min(255, x)), Math.max(0, Math.min(255, y))];
  };
  const drawSeg = () => {
    const size = canvas.width;
    stroke(canvas.getContext('2d'), { ...cur, p: cur.p.slice(-4) }, size);
  };
  canvas.addEventListener('pointerdown', (e) => {
    if (pointCount(state.strokes) >= MAX_POINTS) { onFull && onFull(); return; }
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    cur = { c: state.color, w: state.width, p: pt(e) };
    state.strokes.push(cur);
    stroke(canvas.getContext('2d'), cur, canvas.width);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!cur) return;
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of events) {
      const [x, y] = pt(ev);
      const n = cur.p.length;
      if (Math.abs(x - cur.p[n - 2]) + Math.abs(y - cur.p[n - 1]) < 2) continue;
      if (pointCount(state.strokes) >= MAX_POINTS) { onFull && onFull(); break; }
      cur.p.push(x, y);
      drawSeg();
    }
  });
  const end = () => {
    if (!cur) return;
    cur = null;
    onChange && onChange();
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
}
