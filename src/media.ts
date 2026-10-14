import type { SoundEngine } from './audio';

type Player = { playVideo(): void; pauseVideo(): void; destroy(): void; getIframe(): HTMLIFrameElement };
type PlayerEvent = { target: Player; data: number };
type YouTubeAPI = { Player: new (element: HTMLElement, options: {
  videoId: string; host: string;
  playerVars: Record<string, string | number>;
  events: { onReady(event: PlayerEvent): void; onStateChange(event: PlayerEvent): void; onError(): void; onAutoplayBlocked(): void };
}) => Player };
declare global { interface Window { YT?: YouTubeAPI; onYouTubeIframeAPIReady?: () => void } }
let apiPromise: Promise<YouTubeAPI> | undefined;

function loadYouTube() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;
  apiPromise = new Promise<YouTubeAPI>((resolve, reject) => {
    const script = document.createElement('script');
    const fail = () => { clearTimeout(timeout); script.remove(); apiPromise = undefined; reject(new Error('YouTube yüklenemedi')); };
    const timeout = window.setTimeout(fail, 12000);
    window.onYouTubeIframeAPIReady = () => { clearTimeout(timeout); resolve(window.YT!); };
    script.src = 'https://www.youtube.com/iframe_api';
    script.onerror = fail;
    document.head.append(script);
  });
  return apiPromise;
}

export function connectMedia(audio: SoundEngine) {
  type Viewing = { root: HTMLElement; stage: HTMLElement; link: HTMLAnchorElement; player?: Player; wantsPlay: boolean; revealing: boolean; revealTimeout?: number; timeout?: number };
  let viewing: Viewing | undefined;
  let externalPending = false;
  let externalAway = false;
  const veil = document.createElement('div');
  veil.className = 'video-focus-veil';
  veil.setAttribute('aria-hidden', 'true');
  document.body.append(veil);
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.classList.contains('reduced');
  const focus = (active: boolean) => document.body.classList.toggle('video-focused', active);

  const inView = (session: Viewing) => {
    if (session.root.closest('details:not([open])')) return false;
    if (document.fullscreenElement && session.root.contains(document.fullscreenElement)) return true;
    const box = session.root.getBoundingClientRect();
    const visible = Math.min(box.bottom, innerHeight) - Math.max(box.top, 0);
    return visible > Math.min(box.height, innerHeight) * .15;
  };
  const pause = (session: Viewing) => {
    session.wantsPlay = false;
    session.player?.pauseVideo();
    audio.setMediaActive('embed', false);
  };
  const observer = new IntersectionObserver(() => {
    if (!viewing || document.hidden) return;
    const visible = inView(viewing);
    focus(visible);
    if (!visible && !viewing.revealing) pause(viewing);
  }, { threshold: [0, .15] });

  const close = (restoreFocus = false) => {
    if (!viewing) return;
    const session = viewing;
    viewing = undefined;
    clearTimeout(session.timeout);
    clearTimeout(session.revealTimeout);
    observer.unobserve(session.root);
    session.player?.destroy();
    session.link.setAttribute('aria-expanded', 'false');
    session.root.id = '';
    session.root.inert = true;
    focus(false);
    if (!reduced() && session.root.animate) {
      const animation = session.root.animate([{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'translateY(8px) scale(.985)' }], { duration: 240, easing: 'ease-out', fill: 'forwards' });
      void animation.finished.catch(() => {}).then(() => session.root.remove());
    } else session.root.remove();
    audio.setMediaActive('embed', false);
    if (restoreFocus) session.link.focus({ preventScroll: true });
  };

  const showError = (session: Viewing) => {
    if (viewing !== session) return;
    clearTimeout(session.timeout);
    session.player?.destroy();
    session.player = undefined;
    session.wantsPlay = false;
    audio.setMediaActive('embed', false);
    const fallback = document.createElement('a');
    fallback.href = session.link.href;
    fallback.target = '_blank';
    fallback.rel = 'noopener noreferrer';
    fallback.textContent = 'YouTube’da izle ↗';
    const message = document.createElement('div');
    message.className = 'video-error';
    message.append('Video burada yüklenemedi. ', fallback);
    session.stage.replaceChildren(message);
  };

  async function open(link: HTMLAnchorElement) {
    close();
    audio.setMediaActive('embed', true);
    const root = document.createElement('div');
    root.className = 'video-viewer';
    root.id = 'video-board';
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', link.textContent!.replace('▶', '').trim());
    const button = document.createElement('button');
    button.className = 'video-close';
    button.textContent = '×';
    button.setAttribute('aria-label', 'Videoyu kapat');
    button.title = 'Videoyu kapat';
    button.addEventListener('click', () => close(true));
    const toolbar = document.createElement('div');
    toolbar.className = 'video-toolbar';
    const title = document.createElement('span');
    title.className = 'video-title';
    title.textContent = root.getAttribute('aria-label');
    toolbar.append(title, button);
    const stage = document.createElement('div');
    stage.className = 'video-stage';
    stage.textContent = 'Video yükleniyor…';
    root.append(toolbar, stage);
    link.closest('.video-links')!.after(root);
    link.setAttribute('aria-expanded', 'true');
    link.setAttribute('aria-controls', root.id);
    const session: Viewing = { root, stage, link, wantsPlay: true, revealing: !reduced() };
    viewing = session;
    root.scrollIntoView({ block: 'center', behavior: reduced() ? 'instant' : 'smooth' });
    focus(inView(session));
    session.revealTimeout = window.setTimeout(() => {
      session.revealing = false;
      if (viewing !== session) return;
      focus(inView(session));
      if (!inView(session)) pause(session);
    }, 900);
    observer.observe(root);
    button.focus({ preventScroll: true });
    try {
      const api = await loadYouTube();
      if (viewing !== session) return;
      const mount = document.createElement('div');
      stage.replaceChildren(mount);
      session.timeout = window.setTimeout(() => showError(session), 12000);
      session.player = new api.Player(mount, {
        videoId: link.dataset.youtube!, host: 'https://www.youtube-nocookie.com',
        playerVars: { playsinline: 1, rel: 0, origin: location.origin },
        events: {
          onReady({ target }) {
            if (viewing !== session) return;
            clearTimeout(session.timeout);
            target.getIframe().title = root.getAttribute('aria-label')!;
            if (session.wantsPlay && (session.revealing || inView(session))) target.playVideo();
            else pause(session);
          },
          onStateChange({ data }) {
            if (viewing !== session) return;
            if (data === 1 || data === 3) {
              if (!document.hidden && !session.revealing && !inView(session)) { pause(session); return; }
              session.wantsPlay = true;
              audio.setMediaActive('embed', true);
            } else if (data === 0 || data === 2 || data === 5) {
              audio.setMediaActive('embed', false);
            }
          },
          onError() { showError(session); },
          onAutoplayBlocked() { if (viewing === session) audio.setMediaActive('embed', false); },
        },
      });
    } catch { showError(session); }
  }

  const isYouTube = (link: HTMLAnchorElement) => /(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be)$/.test(new URL(link.href).hostname);
  const externalStart = () => {
    if (viewing) pause(viewing);
    focus(false);
    externalPending = true;
    externalAway = false;
    audio.setMediaActive('external', true);
  };
  const externalReturn = () => {
    if (!externalPending || document.hidden) return;
    externalPending = false;
    externalAway = false;
    audio.setMediaActive('external', false);
  };
  document.addEventListener('click', event => {
    if (viewing && event.target instanceof Element && !viewing.root.contains(event.target) && !event.target.closest('.sound-panel')) {
      // Consume the dismissing click so the page underneath is not activated.
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    const link = (event.target as Element).closest<HTMLAnchorElement>('a[href]');
    if (!link || !isYouTube(link) || event.defaultPrevented) return;
    if (link.dataset.youtube && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      void open(link);
    } else externalStart();
  }, true);
  document.addEventListener('auxclick', event => {
    const link = (event.target as Element).closest<HTMLAnchorElement>('a[href]');
    if (event.button === 1 && link && isYouTube(link)) externalStart();
  });
  window.addEventListener('blur', () => { if (externalPending) externalAway = true; });
  window.addEventListener('focus', () => { if (externalAway) externalReturn(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (externalPending) externalAway = true; }
    else if (externalAway) externalReturn();
  });
  // Returning to the page in a background-tab workflow also counts as leaving the video.
  document.addEventListener('pointerdown', () => { if (externalPending) externalReturn(); }, { passive: true });
  window.addEventListener('scroll', () => {
    if (externalPending && !document.hidden) externalReturn();
  }, { passive: true });
  document.addEventListener('toggle', event => {
    if (event.target instanceof HTMLDetailsElement && !event.target.open && viewing && event.target.contains(viewing.root)) close();
  }, true);
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && viewing) close(true); });
  window.addEventListener('pagehide', () => close());
}
