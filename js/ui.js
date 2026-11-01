// Small UI building blocks: icons, an element helper, the elevation chart, the bottom sheet,
// menus and toasts.

const svg = body => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
export const icon = {
  search: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
  x: svg('<path d="M18 6 6 18M6 6l12 12"/>'),
  back: svg('<path d="m15 18-6-6 6-6"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  locate: svg('<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="8"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2"/>'),
  layers: svg('<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/>'),
  go: svg('<path d="M3 11 21 3l-8 18-2-8-8-2Z"/>'),
  download: svg('<path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14"/>'),
  share: svg('<circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="m8.3 10.8 7.4-4.3M8.3 13.2l7.4 4.3"/>'),
  person: svg('<circle cx="12" cy="5" r="2.5"/><path d="M12 8v6m0 0-3 7m3-7 3 7M8 11h8"/>'),
  globe: svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>'),
  grip: svg('<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>'),
  swap: svg('<path d="M7 4v16m0 0-3-3m3 3 3-3M17 20V4m0 0-3 3m3-3 3 3"/>'),
  trash: svg('<path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13"/>'),
  fuel: svg('<path d="M4 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16M3 21h12M14 10h2a2 2 0 0 1 2 2v5a1.5 1.5 0 0 0 3 0V8l-3-3"/><path d="M7 7h4"/>'),
  warn: svg('<path d="M12 3 2 20h20L12 3Z"/><path d="M12 10v4M12 17v.5"/>'),
  mountain: svg('<path d="m3 20 6-11 4 6 3-4 5 9H3Z"/>'),
  route: svg('<circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M8 19h7a3.5 3.5 0 0 0 0-7H9a3.5 3.5 0 0 1 0-7h7"/>'),
  pin: svg('<path d="M12 21s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12Z"/><circle cx="12" cy="9" r="2.5"/>'),
  chevron: svg('<path d="m6 9 6 6 6-6"/>'),
  help: svg('<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17v.5"/>'),
};

// h('div.card.on', { onclick }, child, 'text', …)
export function h(tag, props = {}, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style') el.style.cssText = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(c));
  return el;
}

export const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Elevation chart; scrubbing it (mouse or finger) reports the sample under the pointer.
export function elevationChart(prof, onScrub) {
  const W = 300, H = 70, n = prof.samples.length - 1, span = Math.max(prof.hi - prof.lo, 60);
  const X = i => i / n * W, Y = v => H - 4 - (v - prof.lo) / span * (H - 12);
  const pts = prof.samples.map((s, i) => `${X(i).toFixed(1)},${Y(s.ft).toFixed(1)}`).join(' ');
  const wrap = h('div.chart');
  wrap.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <defs><linearGradient id="elevFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4dabf7" stop-opacity=".45"/><stop offset="1" stop-color="#4dabf7" stop-opacity=".05"/></linearGradient></defs>
    <polygon points="0,${H} ${pts} ${W},${H}" fill="url(#elevFill)"/>
    <polyline points="${pts}" fill="none" stroke="#4dabf7" stroke-width="1.6" vector-effect="non-scaling-stroke"/>
    <line class="cursor" y1="0" y2="${H}" stroke="#fff" vector-effect="non-scaling-stroke" visibility="hidden"/></svg>
    <div class="chart-readout"></div>`;
  const svgEl = wrap.querySelector('svg'), cursor = wrap.querySelector('.cursor'), readout = wrap.querySelector('.chart-readout');
  const move = e => {
    const box = svgEl.getBoundingClientRect(), i = Math.max(0, Math.min(n, Math.round((e.clientX - box.left) / box.width * n)));
    cursor.setAttribute('x1', X(i)); cursor.setAttribute('x2', X(i)); cursor.setAttribute('visibility', 'visible');
    const s = prof.samples[i];
    readout.textContent = `Mile ${(s.m / 1609.34).toFixed(1)} · ${Math.round(s.ft).toLocaleString()} ft`;
    onScrub(s);
  };
  const leave = () => { cursor.setAttribute('visibility', 'hidden'); readout.textContent = ''; onScrub(null); };
  svgEl.addEventListener('pointermove', move);
  svgEl.addEventListener('pointerdown', e => { svgEl.setPointerCapture(e.pointerId); move(e); });
  svgEl.addEventListener('pointerleave', leave);
  svgEl.addEventListener('pointerup', e => { if (e.pointerType !== 'mouse') leave(); });
  return wrap;
}

// The sheet: a bottom sheet with three heights on phones, a fixed side panel on wide screens.
// Its height is always the visible part, so its content never runs off-screen. It's dragged by
// its handle, or by swiping the content like a map app: down when the list is at its top, up
// until it's fully open; otherwise a swipe scrolls the list.
const SNAPS = ['peek', 'half', 'full'];
export class Sheet {
  constructor(el, grab, onChange) {
    this.el = el;
    this.onChange = onChange;
    this.snap = el.dataset.snap || 'half';
    const body = el.querySelector('.sheet-body');
    let startY = null, startH = 0;
    const begin = y => {
      startY = y;
      startH = el.getBoundingClientRect().height;
      el.classList.add('dragging');
    };
    const move = y => {
      const hgt = Math.max(90, Math.min(this.heightFor('full'), startH - (y - startY)));
      el.style.height = `${hgt}px`;
      el.style.top = `${innerHeight - hgt}px`;
    };
    const end = y => {
      const moved = y - startY, hgt = el.getBoundingClientRect().height;
      startY = null;
      el.classList.remove('dragging');
      el.style.height = el.style.top = '';
      if (Math.abs(moved) < 6) return this.set(SNAPS[(SNAPS.indexOf(this.snap) + 1) % 3]);  // a tap steps up, full wraps to peek
      // The height nearest where it was let go; a swipe of 50 px moves at least one step.
      let to = [...SNAPS].sort((a, b) => Math.abs(this.heightFor(a) - hgt) - Math.abs(this.heightFor(b) - hgt))[0];
      const at = SNAPS.indexOf(this.snap);
      if (to === this.snap && Math.abs(moved) > 50) to = SNAPS[Math.max(0, Math.min(2, at + (moved > 0 ? -1 : 1)))];
      this.set(to);
    };

    grab.addEventListener('pointerdown', e => {
      if (Sheet.wide()) return;
      begin(e.clientY);
      grab.setPointerCapture(e.pointerId);
    });
    grab.addEventListener('pointermove', e => { if (startY != null) move(e.clientY); });
    grab.addEventListener('pointerup', e => { if (startY != null) end(e.clientY); });

    // Swipes on the content. Touch events, not pointer events: once the browser starts scrolling
    // it cancels the pointer, and only a touchmove listener can stop the scroll from starting.
    // They're followed on the element touched, which still gets them if the content re-renders
    // under the finger (new roads loading) and takes it out of the page.
    body.addEventListener('touchstart', e => {
      if (Sheet.wide() || e.touches.length !== 1) return;
      // Things with their own drag: the stop grips and the elevation chart.
      if (e.target.closest('.grip, .chart')) return;
      const target = e.target, x0 = e.touches[0].clientX, y0 = e.touches[0].clientY;
      let mode = null;   // null until it moves: then 'sheet' or 'scroll'
      const onMove = ev => {
        const t = ev.touches[0], dy = t.clientY - y0, dx = t.clientX - x0;
        if (!mode) {
          if (Math.abs(dy) < 8 && Math.abs(dx) < 8) return;
          const down = dy > 0, vertical = Math.abs(dy) > Math.abs(dx);
          mode = vertical && ((down && body.scrollTop <= 0) || (!down && this.snap !== 'full')) ? 'sheet' : 'scroll';
          if (mode === 'sheet') begin(y0);
        }
        if (mode !== 'sheet') return;
        ev.preventDefault();
        move(t.clientY);
      };
      const onEnd = ev => {
        target.removeEventListener('touchmove', onMove);
        target.removeEventListener('touchend', onEnd);
        target.removeEventListener('touchcancel', onEnd);
        if (mode === 'sheet') end(ev.changedTouches[0].clientY);
      };
      target.addEventListener('touchmove', onMove, { passive: false });
      target.addEventListener('touchend', onEnd);
      target.addEventListener('touchcancel', onEnd);
    }, { passive: true });
  }
  static wide() { return matchMedia('(min-width: 900px)').matches; }
  heightFor(snap) {
    if (snap === 'peek') return 132;
    if (snap === 'half') return innerHeight * 0.5;
    const css = getComputedStyle(document.documentElement);
    return innerHeight - (parseFloat(css.getPropertyValue('--topbar-h')) || 110) - 18;
  }
  set(snap) {
    this.snap = snap;
    this.el.dataset.snap = snap;
    this.onChange && this.onChange(snap);
  }
  // Pixels of map hidden under the sheet (bottom on phones, left on wide screens).
  covered() {
    if (Sheet.wide()) return { left: this.el.getBoundingClientRect().right, bottom: 0 };
    return { left: 0, bottom: this.heightFor(this.snap) };
  }
}

// action: { label, run }, or a list of them.
let toastTimer = null;
export function toast(msg, action) {
  const el = document.getElementById('toast'), actions = [action || []].flat();
  el.replaceChildren(h('span', {}, msg), ...actions.map(a => h('button', { onclick: () => { el.hidden = true; a.run(); } }, a.label)));
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, actions.length || msg.length > 80 ? 9000 : 3200);
}

// A small popover menu under an anchor element or at a screen point. Tapping the same anchor
// again, anywhere outside, or Esc closes it.
let menuAnchor = null;
export function menu(items, at) {
  const el = document.getElementById('menu');
  if (!el.hidden && menuAnchor === at) return closeMenu();
  menuAnchor = at;
  el.replaceChildren(...items.map(it => it.heading
    ? h('div.menu-heading', {}, it.heading)
    : h(`button.menu-item${it.on ? '.on' : ''}`, { onclick: () => { closeMenu(); it.run(); } },
      it.icon ? h('span', { html: it.icon }) : '', it.label)));
  el.hidden = false;
  const r = at.getBoundingClientRect ? at.getBoundingClientRect() : { left: at.x, bottom: at.y, top: at.y };
  const w = el.offsetWidth, hgt = el.offsetHeight;
  el.style.left = `${Math.min(Math.max(8, r.left), innerWidth - w - 8)}px`;
  el.style.top = `${r.bottom + hgt + 8 < innerHeight ? r.bottom + 6 : Math.max(8, r.top - hgt - 6)}px`;
  // Capture phase: the map stops some events before they'd bubble up to the document.
  setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
}
function outside(e) {
  if (document.getElementById('menu').contains(e.target)) return;
  // A tap on the anchor itself is handled by menu() as a toggle, so leave the anchor alone.
  if (menuAnchor && menuAnchor.contains && menuAnchor.contains(e.target)) return;
  closeMenu();
}
export function closeMenu() {
  document.getElementById('menu').hidden = true;
  menuAnchor = null;
  document.removeEventListener('pointerdown', outside, true);
}
