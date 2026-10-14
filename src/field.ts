import * as THREE from 'three';
import opentype from 'opentype.js';
import { WAVE_SAMPLES, type SoundEngine } from './audio';
import { MORPH_TOP_START, MORPH_TOP_END, MORPH_BOTTOM_START, MORPH_BOTTOM_END, blobDrift, blobBounds, overlaps, placeBlob, glide, type Rect } from './layout';

type TextGlyph = { left: number; right: number; start: number; end: number; hover: number };
type TextLine = { el: HTMLElement; mesh: THREE.Mesh; material: THREE.ShaderMaterial; x: number; y: number; height: number; width: number; shown: boolean; key: string; morph: number; glyphs: TextGlyph[]; hoverWidth: number; opacity: string; mask: string };
type Blob = { button: HTMLButtonElement; mesh: THREE.Mesh; layer: number; section: HTMLElement; rx: number; ry: number; seed: number; x: number; y: number; targetX: number; targetY: number; initialized: boolean; opacity: number; size: number; placed: boolean; shown: boolean };
const smooth = (a: number, b: number, v: number) => { const t = Math.max(0, Math.min(1, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
const symbols = ['≈', '✳', '∴'];
const colors = ['#aeb783', '#d6a56b', '#a5b9bc'];
const WAVE_STROKE_PX = 2;
// Keep the filled letter dominant: hover only hints at the live waveform.
const HOVER_MORPH_MAX = .03;
const hiddenByDetails = (el: Element) => {
  const closed = el.closest('details:not([open])');
  return !!closed && !closed.querySelector(':scope > summary')?.contains(el);
};

export class Experience {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(0, innerWidth, 0, innerHeight, -10, 10);
  private lines: TextLine[] = [];
  private blobs: Blob[] = [];
  private font?: opentype.Font;
  private waveformTexture: THREE.DataTexture;
  private layerTextures: THREE.DataTexture[];
  private lastSignal = 0;
  private layoutReady = false;
  private panelBounds?: Rect;
  private paragraphText = new WeakMap<HTMLElement, string>();
  private textBuildFrame = 0;
  private paragraphLayout = new WeakMap<HTMLElement, string>();
  private home = document.body.classList.contains('home-page');
  private blockers: Rect[] = [];
  private raf = 0;
  private resizeTimer = 0;
  private width = innerWidth;
  private height = innerHeight;
  private lastFrame = 0;
  private pointer = { x: -1000, y: -1000 };
  reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  constructor(private audio: SoundEngine, private selectSound: (index: number) => void) {
    this.waveformTexture = new THREE.DataTexture(audio.waveform, WAVE_SAMPLES, 1, THREE.RedFormat);
    this.waveformTexture.minFilter = this.waveformTexture.magFilter = THREE.LinearFilter;
    this.waveformTexture.needsUpdate = true;
    this.layerTextures = audio.layerWaveforms.map(wave => {
      const texture = new THREE.DataTexture(wave, WAVE_SAMPLES, 1, THREE.RedFormat);
      texture.minFilter = texture.magFilter = THREE.LinearFilter;
      texture.needsUpdate = true;
      return texture;
    });
    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.35));
    this.renderer.setSize(innerWidth, innerHeight, false);
    this.renderer.setClearColor(0, 0);
    this.renderer.domElement.id = 'experience';
    this.renderer.domElement.setAttribute('aria-hidden', 'true');
    document.body.append(this.renderer.domElement);
    this.createBlobs();
    window.addEventListener('resize', () => {
      this.layoutReady = false;
      clearTimeout(this.resizeTimer);
      this.resizeTimer = window.setTimeout(() => this.resize(), 120);
    });
    document.addEventListener('pointermove', e => { this.pointer.x = e.pointerType === 'touch' ? -1000 : e.clientX; this.pointer.y = e.pointerType === 'touch' ? -1000 : e.clientY; }, { passive: true });
    document.addEventListener('pointerdown', e => { if (e.pointerType === 'touch') { this.pointer.x = -1000; this.pointer.y = -1000; } }, { passive: true });
    document.documentElement.addEventListener('pointerleave', () => { this.pointer.x = -1000; this.pointer.y = -1000; });
    document.addEventListener('toggle', event => {
      if (!(event.target instanceof HTMLDetailsElement)) return;
      // Disclosure only updates the layout; playback has its own lifetime.
      this.measure();
      cancelAnimationFrame(this.textBuildFrame);
      this.textBuildFrame = requestAnimationFrame(() => this.buildText());
    }, true);
    const layoutObserver = new ResizeObserver(() => this.measure());
    for (const el of document.querySelectorAll('main, header, .sound-panel, .project, .hero')) layoutObserver.observe(el);
    document.fonts.addEventListener('loadingdone', () => this.buildText());
    void this.loadFont();
    this.frame(0);
  }

  private async loadFont() {
    try {
      const response = await fetch(new URL('assets/SayHelloWeb.otf', document.baseURI));
      if (!response.ok) throw new Error('Yazı tipi yüklenemedi');
      this.font = opentype.parse(await response.arrayBuffer());
      await document.fonts.load('16px SayHello');
      await document.fonts.ready;
      this.buildText();
    } catch (error) { console.warn('Metin normal görünümde gösteriliyor.', error); }
  }

  private wrapParagraphs() {
    for (const paragraph of document.querySelectorAll<HTMLElement>('.project-body p, [data-morph-paragraph]')) {
      if (paragraph.closest('details:not([open])')) continue;
      const layout = `${paragraph.getBoundingClientRect().width}|${getComputedStyle(paragraph).fontSize}|${getComputedStyle(paragraph).fontFamily}`;
      if (this.paragraphLayout.get(paragraph) === layout) continue;
      this.paragraphLayout.set(paragraph, layout);
      const text = this.paragraphText.get(paragraph) ?? paragraph.textContent!.trim();
      this.paragraphText.set(paragraph, text);
      paragraph.textContent = text;

      // Read the browser's actual line breaks before making each line a morph target.
      const textNode = paragraph.firstChild!;
      const range = document.createRange();
      const rows: { top: number; start: number; end: number }[] = [];
      for (const word of text.matchAll(/\S+/gu)) {
        const start = word.index!;
        const end = start + word[0].length;
        range.setStart(textNode, start);
        range.setEnd(textNode, end);
        const top = range.getBoundingClientRect().top;
        const row = rows[rows.length - 1];
        if (row && Math.abs(row.top - top) < 1) row.end = end;
        else rows.push({ top, start, end });
      }
      const fragment = document.createDocumentFragment();
      for (const [index, row] of rows.entries()) {
        if (index) fragment.append(' ');
        const line = document.createElement('span');
        line.className = 'morph-line';
        line.textContent = text.slice(row.start, row.end);
        fragment.append(line);
      }
      paragraph.replaceChildren(fragment);
    }
  }

  private buildText() {
    if (!this.font) return;
    const previous = new Map(this.lines.map(line => [line.el, line]));
    const next: TextLine[] = [];
    this.wrapParagraphs();
    for (const el of document.querySelectorAll<HTMLElement>('.morph-line')) {
      const retained = previous.get(el);
      if (hiddenByDetails(el) || !el.getClientRects().length) {
        if (retained) { next.push(retained); previous.delete(el); }
        continue;
      }
      const css = getComputedStyle(el);
      // Leave unsupported characters to browser fallback instead of drawing .notdef boxes.
      if ([...el.textContent!.trim()].some(character => !this.font!.charToGlyphIndex(character))) {
        el.style.opacity = '1';
        continue;
      }
      const size = parseFloat(css.fontSize);
      const height = parseFloat(css.lineHeight) || size * 1.1;
      const width = el.getBoundingClientRect().width;
      // A few letters at most; even a short label keeps most of its text intact.
      const hoverWidth = Math.min(76, Math.max(24, size * 1.3), width * .44);
      const key = `${el.textContent}|${size}|${height}|${width}|${css.color}`;
      if (retained?.key === key) { next.push(retained); previous.delete(el); continue; }
      const font = this.font;
      const baseline = (height - size * (font.ascender - font.descender) / font.unitsPerEm) / 2 + size * font.ascender / font.unitsPerEm;
      const text = el.textContent!.trim();
      const segments: number[] = [];
      const glyphs: TextGlyph[] = [];
      const scaleX = width / font.getAdvanceWidth(text, size);
      font.forEachGlyph(text, 0, baseline, size, {}, (glyph, x, y, fontSize, options) => {
        const path = glyph.getPath(x, y, fontSize, options, font);
        if (!path.commands.length) return;
        const box = path.getBoundingBox();
        const start = segments.length / 6;
        const contours: string[] = [];
        let d = '';
        for (const c of path.commands) {
          if (c.type === 'M') { if (d) contours.push(d); d = `M${c.x},${c.y}`; }
          else if (c.type === 'L') d += `L${c.x},${c.y}`;
          else if (c.type === 'C') d += `C${c.x1},${c.y1} ${c.x2},${c.y2} ${c.x},${c.y}`;
          else if (c.type === 'Q') d += `Q${c.x1},${c.y1} ${c.x},${c.y}`;
          else d += 'Z';
        }
        if (d) contours.push(d);
        for (const contour of contours) {
          const svg = document.createElementNS('http://www.w3.org/2000/svg', 'path'); svg.setAttribute('d', contour);
          const length = svg.getTotalLength();
          const count = Math.max(6, Math.min(500, Math.ceil(length / 3.5)));
          for (let j = 0; j < count; j++) {
            const a = svg.getPointAtLength(j / count * length);
            const b = svg.getPointAtLength((j + 1) / count * length);
            segments.push(a.x * scaleX, a.y, 0, b.x * scaleX, b.y, 0);
          }
        }
        glyphs.push({ left: box.x1 * scaleX, right: box.x2 * scaleX, start, end: segments.length / 6, hover: 0 });
      });
      // Put mask seams in the spaces between whole glyphs, never through a letter.
      const boundaries = glyphs.slice(1).map((glyph, i) => (glyphs[i].right + glyph.left) / 2);
      glyphs.forEach((glyph, i) => { glyph.left = i ? boundaries[i - 1] : 0; glyph.right = i < boundaries.length ? boundaries[i] : width; });
      // Screen-space quads keep stroke thickness consistent across WebGL devices.
      const segmentCount = segments.length / 6;
      const corners: number[] = [], starts: number[] = [], ends: number[] = [], waves: number[] = [], hoverWaves: number[] = [], indices: number[] = [];
      let glyphIndex = 0;
      for (let i = 0; i < segmentCount; i++) {
        while (i >= glyphs[glyphIndex].end) glyphIndex++;
        const glyph = glyphs[glyphIndex];
        const localStart = glyph.left + (i - glyph.start) / (glyph.end - glyph.start) * (glyph.right - glyph.left);
        const localEnd = glyph.left + (i + 1 - glyph.start) / (glyph.end - glyph.start) * (glyph.right - glyph.left);
        const offset = i * 6;
        for (const [along, side] of [[0, -1], [0, 1], [1, -1], [1, 1]]) {
          corners.push(along, side, 0);
          starts.push(segments[offset], segments[offset + 1]);
          ends.push(segments[offset + 3], segments[offset + 4]);
          waves.push(i / segmentCount * width, (i + 1) / segmentCount * width);
          hoverWaves.push(localStart, localEnd);
        }
        const vertex = i * 4;
        indices.push(vertex, vertex + 1, vertex + 2, vertex + 2, vertex + 1, vertex + 3);
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(corners, 3));
      geometry.setAttribute('segmentStart', new THREE.Float32BufferAttribute(starts, 2));
      geometry.setAttribute('segmentEnd', new THREE.Float32BufferAttribute(ends, 2));
      geometry.setAttribute('waveRange', new THREE.Float32BufferAttribute(waves, 2));
      geometry.setAttribute('hoverWaveRange', new THREE.Float32BufferAttribute(hoverWaves, 2));
      geometry.setAttribute('hoverAmount', new THREE.BufferAttribute(new Float32Array(segmentCount * 4), 1).setUsage(THREE.DynamicDrawUsage));
      geometry.setIndex(indices);
      const material = new THREE.ShaderMaterial({
        transparent: true, depthTest: false, side: THREE.DoubleSide,
        uniforms: { uMorph: { value: 1 }, uHeight: { value: height }, uWidth: { value: width }, uWave: { value: this.waveformTexture }, uStroke: { value: WAVE_STROKE_PX }, uFill: { value: 1 }, uColor: { value: new THREE.Color(css.color) } },
        vertexShader: `attribute vec2 segmentStart, segmentEnd, waveRange, hoverWaveRange;
          attribute float hoverAmount;
          uniform float uMorph, uHeight, uWidth, uStroke;
          uniform sampler2D uWave;
          varying float vHoverFill, vMorph;
          vec2 wavePoint(float x){
            float u=clamp(x/max(uWidth,1.),0.,1.);
            float signal=(texture2D(uWave,vec2((u*255.+.5)/256.,.5)).r*255.-128.)/127.;
            return vec2(x,uHeight*.55+signal*uHeight*.42);
          }
          void main(){
            // Use the same live waveform and whole-contour interpolation as scrolling.
            vec2 localA=mix(segmentStart,wavePoint(hoverWaveRange.x),hoverAmount);
            vec2 localB=mix(segmentEnd,wavePoint(hoverWaveRange.y),hoverAmount);
            vec2 a=mix(wavePoint(waveRange.x),localA,uMorph);
            vec2 b=mix(wavePoint(waveRange.y),localB,uMorph);
            vMorph=uMorph*(1.-hoverAmount);
            vHoverFill=1.-smoothstep(.91,1.,1.-hoverAmount);
            vec2 delta=b-a; vec2 direction=delta/max(length(delta),.00001);
            vec2 normal=vec2(-direction.y,direction.x);
            vec2 p=mix(a,b,position.x)+normal*position.y*mix(uStroke,1.1,vMorph)*.5;
            gl_Position=projectionMatrix*modelViewMatrix*vec4(p,0.,1.);
          }`,
        fragmentShader: `uniform vec3 uColor;
          uniform float uFill;
          varying float vHoverFill, vMorph;
          void main(){
            gl_FragColor=vec4(uColor,(.54+vMorph*.46)*(1.-uFill+uFill*vHoverFill));
          }`
      });
      const mesh = new THREE.Mesh(geometry, material); mesh.frustumCulled = false;
      this.scene.add(mesh); next.push({ el, mesh, material, x: 0, y: 0, height, width, shown: true, key, morph: -1, glyphs, hoverWidth, opacity: '', mask: '' });
    }
    for (const line of previous.values()) {
      this.scene.remove(line.mesh); line.mesh.geometry.dispose(); line.material.dispose(); line.el.style.opacity = '';
      line.el.style.maskImage = line.el.style.webkitMaskImage = '';
    }
    this.lines = next;
    this.measure();
  }

  private createBlobs() {
    const definitions: [string, number, number, number][] = [
      ['.hero', .82, .28, 0], ['.hero', .78, .72, 1], ['.hero', .35, .9, 2],
      ['#works', .02, .2, 0], ['#works', .98, .52, 1], ['#works', .58, .85, 2]
    ];
    definitions.forEach(([selector, rx, ry, layer], i) => {
      const section = document.querySelector<HTMLElement>(selector);
      if (!section) return;
      const button = document.createElement('button');
      button.className = 'blob-button'; button.dataset.layer = String(layer); button.dataset.state = 'off';
      button.innerHTML = `<span class="blob-symbol" aria-hidden="true">${symbols[layer]}</span><span class="blob-title"></span>`;
      button.querySelector('.blob-title')!.textContent = this.audio.name(layer);
      button.disabled = !this.audio.available;
      button.setAttribute('aria-label', `${this.audio.name(layer)} sesini seç`); button.setAttribute('aria-pressed', 'false');
      button.addEventListener('click', () => this.selectSound(layer));
      document.querySelector('#blob-controls')!.append(button);
      const material = new THREE.ShaderMaterial({ transparent: true, depthTest: false, side: THREE.DoubleSide, uniforms: { uOpacity: { value: 0 }, uTime: { value: 0 }, uColor: { value: new THREE.Color(colors[layer]) }, uActive: { value: 0 }, uWave: { value: this.layerTextures[layer] }, uSeed: { value: i * 1.7 }, uHover: { value: 0 } },
        vertexShader: `varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
        fragmentShader: `varying vec2 vUv;uniform float uTime,uActive,uSeed,uHover,uOpacity;uniform vec3 uColor;uniform sampler2D uWave;
        void main(){vec2 p=(vUv-.5)*2.;float a=atan(p.y,p.x);float r=length(p);
        float signal=(texture2D(uWave,vec2((a+3.141593)/6.283186,.5)).r*255.-128.)/127.;
        float edge=.68+.067*sin(a*3.+uTime*.42+uSeed)+.04*cos(a*5.-uTime*.24)+uHover*.02+uActive*.09+signal*.025;
        float alpha=(1.-smoothstep(edge-.035,edge,r))*(.49+uActive*.24);float ring=1.-smoothstep(.005,.018,abs(r-edge+.10));
        vec3 col=mix(uColor,uColor*.78,ring*.25);col+=.12*(1.-r);gl_FragColor=vec4(col,alpha*uOpacity);}` });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material); mesh.frustumCulled = false;
      mesh.renderOrder = -1; this.scene.add(mesh);
      this.blobs.push({ button, mesh, layer, section, rx, ry, seed: i * 1.7, x: 0, y: 0, targetX: 0, targetY: 0, initialized: false, opacity: 0, size: 0, placed: false, shown: false });
    });
  }

  private measure() {
    for (const line of this.lines) {
      line.shown = line.el.isConnected && !hiddenByDetails(line.el) && !!line.el.getClientRects().length;
      const r = line.el.getBoundingClientRect(); line.x = r.left; line.y = r.top + scrollY;
    }
    this.blockers = [];
    for (const el of document.querySelectorAll<HTMLElement>('.morph-line, .page-link, .project > summary .plus, .project-body p, .project-body a, .project-body img, .video-viewer, header, footer')) {
      if (hiddenByDetails(el) || !el.getClientRects().length) continue;
      const r = el.getBoundingClientRect();
      this.blockers.push({ left: r.left, right: r.right, top: r.top + scrollY, bottom: r.bottom + scrollY });
    }
    const panel = document.querySelector('.sound-panel')!.getBoundingClientRect();
    this.panelBounds = { left: panel.left - 8, right: panel.right + 8, top: panel.top - 8, bottom: panel.bottom + 8 };
    const occupied = [...this.blockers, { ...this.panelBounds, top: panel.top + scrollY - 8, bottom: panel.bottom + scrollY + 8 }];
    // Use content height; animated controls must never enlarge the document.
    const pageHeight = Math.max(this.height, document.body.scrollHeight);
    const mobile = this.width <= 800;
    for (const [i, blob] of this.blobs.entries()) {
      const r = blob.section.getBoundingClientRect();
      let rx = blob.rx, ry = blob.ry;
      if (mobile && this.home) { rx = i === 0 ? .81 : .23; ry = i === 0 ? .72 : .88; }
      blob.size = mobile ? 94 : 136;
      blob.mesh.scale.set(blob.size, blob.size, 1);
      const previous = blob.initialized ? { x: blob.targetX, y: blob.targetY } : undefined;
      const placement = placeBlob(r.left + r.width * rx, r.top + scrollY + r.height * ry, blob.size, this.width, pageHeight, occupied, previous);
      blob.placed = !!placement;
      if (placement) {
        blob.targetX = placement.x; blob.targetY = placement.y;
        if (!blob.initialized || this.reduced) { blob.x = placement.x; blob.y = placement.y; }
        blob.initialized = true;
        occupied.push(placement.bounds);
      }
    }
    this.layoutReady = !!this.font && document.fonts.check('16px SayHello');
  }

  private resize() {
    const changedWidth = this.width !== innerWidth;
    this.width = innerWidth; this.height = innerHeight;
    this.renderer.setSize(this.width, this.height, false);
    this.camera.right = this.width; this.camera.bottom = this.height; this.camera.updateProjectionMatrix();
    if (changedWidth) this.buildText();
    this.measure();
  }

  setReduced(value: boolean) { this.reduced = value; document.documentElement.classList.toggle('reduced', value); }
  updateStates() {
    for (const b of this.blobs) {
      const state = this.audio.state(b.layer);
      b.button.title = this.audio.available ? this.audio.name(b.layer) : 'Henüz ses eklenmedi';
      b.button.dataset.state = state;
      b.button.setAttribute('aria-pressed', String(state === 'on' || state === 'pending'));
      b.button.setAttribute('aria-label', `${this.audio.name(b.layer)}: ${state === 'pending' ? 'hazırlanıyor' : state === 'on' ? 'çalıyor' : state === 'fading' ? 'kısılıyor' : 'sesi seç'}`);
      b.button.querySelector('.blob-title')!.textContent = this.audio.name(b.layer) + (state === 'pending' ? ' · bekliyor' : '');
    }
  }

  private frame = (time: number) => {
    this.raf = requestAnimationFrame(this.frame);
    const elapsed = time - this.lastFrame;
    if (document.hidden || elapsed < 1000 / 60 - .6) return;
    const dt = Math.min(elapsed / 1000, .05);
    this.lastFrame = time;
    const ease = 1 - Math.exp(-dt * 14);
    const t = this.reduced ? 0 : time / 1000;
    if (!this.reduced && time - this.lastSignal >= 1000 / 30) {
      this.audio.sampleSignals();
      this.waveformTexture.needsUpdate = true;
      this.layerTextures.forEach(texture => { texture.needsUpdate = true; });
      this.lastSignal = time;
    }
    for (const line of this.lines) {
      const y = line.y - scrollY;
      line.mesh.visible = line.shown && !this.reduced && y < this.height + line.height && y > -line.height;
      if (this.reduced) {
        if (line.opacity !== '1') { line.el.style.opacity = '1'; line.opacity = '1'; }
        if (line.mask) { line.el.style.maskImage = line.el.style.webkitMaskImage = ''; line.mask = ''; }
        for (const glyph of line.glyphs) glyph.hover = 0;
        const amounts = line.mesh.geometry.getAttribute('hoverAmount') as THREE.BufferAttribute;
        amounts.array.fill(0); amounts.needsUpdate = true;
        continue;
      }
      if (!line.mesh.visible) continue;
      const center = (y + line.height * .5) / this.height;
      const target = this.home ? 1 : smooth(MORPH_TOP_START, MORPH_TOP_END, center) * (1 - smooth(MORPH_BOTTOM_START, MORPH_BOTTOM_END, center));
      // Even a fast scroll must reveal letters as soon as they reach the readable area.
      line.morph = line.morph < 0 || target === 1 ? target : line.morph + (target - line.morph) * ease;
      if (Math.abs(line.morph - target) < .0005) line.morph = target;
      const morph = line.morph;
      const px = this.pointer.x - line.x, py = this.pointer.y - y;
      const hovering = px >= 0 && px <= line.width && py >= 0 && py <= line.height;
      const nearest = hovering ? line.glyphs.findIndex(glyph => px >= glyph.left && px <= glyph.right) : -1;
      let first = nearest, last = nearest;
      if (nearest >= 0) {
        // Keep at least the pointed-at glyph whole; add at most two nearby small glyphs.
        for (let n = 0; n < 2; n++) {
          const left = first > 0 ? line.glyphs[first - 1] : undefined;
          const right = last + 1 < line.glyphs.length ? line.glyphs[last + 1] : undefined;
          const leftFits = left && line.glyphs[last].right - left.left <= line.hoverWidth;
          const rightFits = right && right.right - line.glyphs[first].left <= line.hoverWidth;
          if (leftFits && (!rightFits || px - left.right < right.left - px)) first--;
          else if (rightFits) last++;
          else break;
        }
      }
      const amounts = line.mesh.geometry.getAttribute('hoverAmount') as THREE.BufferAttribute;
      const stops: string[] = [];
      let activeHover = false, changedHover = false;
      line.glyphs.forEach((glyph, i) => {
        const targetHover = nearest >= 0 && i >= first && i <= last ? HOVER_MORPH_MAX * (i === nearest ? 1 : .5) : 0;
        const previous = glyph.hover;
        glyph.hover += (targetHover - glyph.hover) * ease;
        if (Math.abs(glyph.hover - targetHover) < .001) glyph.hover = targetHover;
        if (previous !== glyph.hover) {
          amounts.array.fill(glyph.hover, glyph.start * 4, glyph.end * 4);
          changedHover = true;
        }
        activeHover ||= glyph.hover > 0;
        const alpha = smooth(.91, 1, 1 - glyph.hover).toFixed(3);
        stops.push(`rgba(0,0,0,${alpha}) ${glyph.left}px ${glyph.right}px`);
      });
      if (changedHover) amounts.needsUpdate = true;
      const fill = smooth(.91, 1, morph);
      const opacity = fill.toFixed(3);
      if (line.opacity !== opacity) { line.el.style.opacity = opacity; line.opacity = opacity; }
      const mask = activeHover && fill > 0 ? `linear-gradient(to right, ${stops.join(', ')})` : '';
      if (line.mask !== mask) { line.el.style.maskImage = line.el.style.webkitMaskImage = mask; line.mask = mask; }
      line.mesh.visible = fill < .999 || activeHover;
      line.mesh.position.set(line.x, y, 0);
      line.material.uniforms.uMorph.value = morph;
      line.material.uniforms.uFill.value = fill;
    }
    let visible = 0;
    const mobile = this.width <= 800;
    for (const [i, blob] of this.blobs.entries()) {
      blob.x = this.reduced ? blob.targetX : glide(blob.x, blob.targetX, dt);
      blob.y = this.reduced ? blob.targetY : glide(blob.y, blob.targetY, dt);
      const { x: dx, y: dy } = blobDrift(t, blob.seed, mobile, this.reduced);
      const x = blob.x + dx, pageY = blob.y + dy;
      const y = pageY - scrollY;
      const bounds = blobBounds(x, pageY, blob.size);
      const screenBounds = { ...bounds, top: bounds.top - scrollY, bottom: bounds.bottom - scrollY };
      const clear = !this.blockers.some(blocker => overlaps(bounds, blocker)) && (!this.panelBounds || !overlaps(screenBounds, this.panelBounds));
      const shown = this.layoutReady && blob.placed && clear && y > -blob.size && y < this.height + blob.size && !(mobile && this.home && i === 2) && visible < (mobile ? 2 : 3);
      if (shown) visible++;
      blob.opacity += ((shown ? 1 : 0) - blob.opacity) * (this.reduced ? 1 : 1 - Math.exp(-dt * 10));
      const visibleNow = blob.opacity > .01;
      blob.mesh.visible = visibleNow;
      blob.button.disabled = !shown || !this.audio.available;
      blob.button.style.pointerEvents = shown && this.audio.available ? 'auto' : 'none';
      blob.button.style.opacity = blob.opacity.toFixed(3);
      blob.button.setAttribute('aria-hidden', String(!shown));
      if (blob.shown !== visibleNow || !blob.button.style.display) {
        blob.button.hidden = !visibleNow;
        blob.button.style.display = visibleNow ? 'flex' : 'none';
        blob.shown = visibleNow;
      }
      if (!visibleNow) continue;
      blob.mesh.position.set(x, y, 1);
      blob.button.style.transform = `translate3d(${x.toFixed(2)}px,${y.toFixed(2)}px,0) translate(-50%,-50%)`;
      const material = blob.mesh.material as THREE.ShaderMaterial;
      material.uniforms.uOpacity.value = blob.opacity;
      material.uniforms.uTime.value = t;
      material.uniforms.uActive.value += (this.audio.levels[blob.layer] - material.uniforms.uActive.value) * ease;
      material.uniforms.uHover.value = Math.hypot(this.pointer.x - x, this.pointer.y - y) < blob.size * .6 ? 1 : 0;
    }
    this.renderer.render(this.scene, this.camera);
  };
  dispose() { cancelAnimationFrame(this.raf); cancelAnimationFrame(this.textBuildFrame); this.waveformTexture.dispose(); this.layerTextures.forEach(texture => texture.dispose()); this.renderer.dispose(); }
}
