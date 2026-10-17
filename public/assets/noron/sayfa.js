const videos = [...document.querySelectorAll('video')];
const motion = document.querySelector('#motion');
const dialog = document.querySelector('.photo-dialog');
const imageHost = document.querySelector('.lightbox-image');
const caption = document.querySelector('.lightbox-caption');
let paused = matchMedia('(prefers-reduced-motion: reduce)').matches;
const visible = new Set();

function updateMotion() {
  const label = paused ? 'Videoları oynat' : 'Hareketi durdur';
  motion.setAttribute('aria-pressed', String(paused));
  motion.setAttribute('aria-label', label);
  motion.title = label;
}
function syncVideo(video) {
  if (paused || document.hidden || !visible.has(video)) video.pause();
  else video.play().catch(() => {
    video.closest('.video-surface').querySelector('.play-fallback').hidden = false;
  });
}
const observer = new IntersectionObserver(entries => {
  entries.forEach(entry => {
    if (entry.isIntersecting) visible.add(entry.target); else visible.delete(entry.target);
    syncVideo(entry.target);
  });
}, {rootMargin: '60px', threshold: 0.01});
videos.forEach(video => {
  video.muted = true;
  if (paused) { video.removeAttribute('autoplay'); video.pause(); }
  observer.observe(video);
  const fallback = video.closest('.video-surface').querySelector('.play-fallback');
  video.addEventListener('playing', () => fallback.hidden = true);
  fallback.addEventListener('click', () => {
    paused = false;
    updateMotion();
    videos.forEach(syncVideo);
  });
});
motion.addEventListener('click', () => {
  paused = !paused;
  updateMotion();
  videos.forEach(syncVideo);
});
document.addEventListener('visibilitychange', () => videos.forEach(syncVideo));
document.querySelectorAll('.photo-open').forEach(button => {
  button.addEventListener('click', () => {
    const frame = button.querySelector('.photo-frame').cloneNode(true);
    frame.querySelector('img').loading = 'eager';
    imageHost.replaceChildren(frame);
    caption.textContent = button.closest('figure').querySelector('figcaption').textContent;
    dialog.showModal();
  });
});
document.querySelector('.close-dialog').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
dialog.addEventListener('close', () => imageHost.replaceChildren());
updateMotion();
