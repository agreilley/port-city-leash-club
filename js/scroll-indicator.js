// Always-visible scroll indicator for sideways-scrolling boxes (.h-scroll):
// the availability grids on careers.html / walker-screening.html and the
// screening comfort table. iOS Safari hides native scrollbars no matter what,
// so a thin track + thumb is drawn under each box, shown only when the content
// actually overflows. Thumb width = visible fraction, position follows
// scrollLeft; the track can be tapped or dragged to scroll. The native bar is
// hidden so Android doesn't show two. Load with `defer` so boxes whose content
// is built by inline scripts are already filled in.
(function () {
  const style = document.createElement('style');
  style.textContent = `
    .h-scroll { overflow-x: auto; scrollbar-width: none; }
    .h-scroll::-webkit-scrollbar { display: none; }
    .scroll-track { display: none; position: relative; height: 6px; margin-top: 10px; border-radius: 3px; background: rgba(0,0,0,0.08); cursor: pointer; touch-action: none; }
    .scroll-track.active { display: block; }
    .scroll-thumb { position: absolute; top: 0; left: 0; height: 100%; border-radius: 3px; background: var(--seafoam); }
  `;
  document.head.appendChild(style);

  document.querySelectorAll('.h-scroll').forEach(box => {
    const track = document.createElement('div');
    track.className = 'scroll-track';
    const thumb = document.createElement('div');
    thumb.className = 'scroll-thumb';
    track.appendChild(thumb);
    box.after(track);

    const update = () => {
      const overflow = box.scrollWidth - box.clientWidth;
      track.classList.toggle('active', overflow > 1);
      if (overflow <= 1) return;
      const trackW = track.clientWidth;
      const thumbW = Math.max(24, trackW * box.clientWidth / box.scrollWidth);
      thumb.style.width = thumbW + 'px';
      thumb.style.transform = `translateX(${(trackW - thumbW) * box.scrollLeft / overflow}px)`;
    };
    const scrollTo = clientX => {
      const r = track.getBoundingClientRect();
      const thumbW = thumb.offsetWidth;
      const frac = Math.min(1, Math.max(0, (clientX - r.left - thumbW / 2) / (r.width - thumbW)));
      box.scrollLeft = frac * (box.scrollWidth - box.clientWidth);
    };
    box.addEventListener('scroll', update, { passive: true });
    // Re-measure on viewport changes and when fonts load and resize the content.
    const ro = new ResizeObserver(update);
    ro.observe(box);
    if (box.firstElementChild) ro.observe(box.firstElementChild);
    window.addEventListener('resize', update);
    track.addEventListener('pointerdown', e => {
      track.setPointerCapture(e.pointerId);
      scrollTo(e.clientX);
      const move = ev => scrollTo(ev.clientX);
      const up = () => {
        track.removeEventListener('pointermove', move);
        track.removeEventListener('pointerup', up);
        track.removeEventListener('pointercancel', up);
      };
      track.addEventListener('pointermove', move);
      track.addEventListener('pointerup', up);
      track.addEventListener('pointercancel', up);
    });
    update();
  });
})();
