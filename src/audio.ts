import { SampleQueue } from './playlist';
export type LayerState = 'off' | 'pending' | 'on' | 'fading';
export type Sample = { label: string; url: string };
const MASTER_LEVEL = .36;
export const CROSSFADE_SECONDS = 4;
export const DEFAULT_VOLUME = .67;
export const OUTPUT_CEILING = .85;
export const WAVE_SAMPLES = 256;
export function outputCurve() {
  const knee = .7, headroom = OUTPUT_CEILING - knee;
  return Float32Array.from({ length: 4097 }, (_, i) => {
    const x = i / 2048 - 1;
    const magnitude = Math.abs(x);
    return Math.sign(x) * (magnitude <= knee ? magnitude : knee + headroom * Math.tanh((magnitude - knee) / headroom));
  });
}
function trace(signal: Float32Array, target: Uint8Array, gain: number) {
  let start = 0;
  for (let i = 1; i < signal.length / 2; i++) {
    if (signal[i - 1] <= 0 && signal[i] > 0) { start = i; break; }
  }
  for (let i = 0; i < target.length; i++) {
    const sample = signal[start + Math.floor(i * (signal.length / 2 - 1) / (target.length - 1))];
    target[i] = Math.round(128 + Math.max(-1, Math.min(1, sample * gain)) * 127);
  }
}
type Envelope = { from: number; to: number; start: number; end: number; shape?: 'in' | 'out' };
type Voice = { index: number; sample: number; source: AudioBufferSourceNode; gain: GainNode; envelope: Envelope; startedAt: number; offset: number; stopAt?: number };
function levelAt(envelope: Envelope, now: number) {
  const { from, to, start, end, shape } = envelope;
  const progress = end <= start ? 1 : Math.max(0, Math.min(1, (now - start) / (end - start)));
  const blend = shape === 'in' ? Math.sin(progress * Math.PI / 2) : shape === 'out' ? 1 - Math.cos(progress * Math.PI / 2) : progress;
  return from + (to - from) * blend;
}

export class SoundEngine {
  context?: AudioContext;
  private master?: GainNode;
  private volumeGain?: GainNode;
  private analyser?: AnalyserNode;
  private layerAnalysers: AnalyserNode[] = [];
  private signal = new Float32Array(1024);
  private layerSignal = new Float32Array(256);
  readonly waveform = new Uint8Array(WAVE_SAMPLES).fill(128);
  readonly layerWaveforms: Uint8Array[];
  readonly levels: Float32Array;
  private volumeLevel = DEFAULT_VOLUME;
  private buffers = new Map<number, AudioBuffer>();
  private loads = new Map<number, Promise<AudioBuffer>>();
  // A blob keeps its assigned file and paused playhead for the page's lifetime.
  // Inactive blobs do not advance while another blob is playing.
  private remembered = new Map<number, { sample: number; offset: number }>();
  private lastSelected = 0;
  private request = 0;
  private selected?: number;
  private loading?: number;
  private queued?: { index: number; sample: number };
  private playlist: SampleQueue;
  private voices: Voice[] = [];
  private stopping = new Set<Voice>();
  private transition?: { outgoing: Voice; end: number; timer?: number };
  private media = new Set<string>();
  private envelope: Envelope = { from: MASTER_LEVEL, to: MASTER_LEVEL, start: 0, end: 0 };
  onChange: () => void = () => {};

  constructor(private samples: readonly Sample[] = [], random: () => number = Math.random) {
    this.playlist = new SampleQueue(samples.length, random);
    this.layerWaveforms = Array.from({ length: 3 }, () => new Uint8Array(WAVE_SAMPLES).fill(128));
    this.levels = new Float32Array(3);
  }
  name(index: number) {
    const saved = this.remembered.get(index);
    return saved ? this.samples[saved.sample].label : `Ses ${String(index + 1).padStart(2, '0')}`;
  }
  get available() { return this.samples.length > 0; }
  get resumeIndex() { return this.selected ?? this.lastSelected; }

  async prepare() {
    if (!this.context) {
      this.context = new AudioContext();
      this.master = this.context.createGain();
      this.master.gain.value = this.mediaMuted ? 0 : MASTER_LEVEL;
      this.envelope = { from: this.master.gain.value, to: this.master.gain.value, start: 0, end: 0 };
      this.volumeGain = this.context.createGain();
      this.volumeGain.gain.value = this.volumeLevel;
      const compressor = this.context.createDynamicsCompressor();
      compressor.threshold.value = -9; compressor.knee.value = 3;
      compressor.ratio.value = 20; compressor.attack.value = .003; compressor.release.value = .12;
      const ceiling = this.context.createWaveShaper(); ceiling.curve = outputCurve();
      this.analyser = this.context.createAnalyser(); this.analyser.fftSize = this.signal.length;
      this.master.connect(this.volumeGain); this.volumeGain.connect(compressor); compressor.connect(ceiling);
      ceiling.connect(this.analyser); this.analyser.connect(this.context.destination);
      this.layerAnalysers = this.layerWaveforms.map(() => {
        const analyser = this.context!.createAnalyser();
        analyser.fftSize = this.layerSignal.length; analyser.connect(this.master!);
        return analyser;
      });
    }
    await this.context.resume();
  }

  private async load(index: number): Promise<AudioBuffer> {
    const cached = this.buffers.get(index);
    if (cached) return cached;
    let promise = this.loads.get(index);
    if (!promise) {
      promise = (async () => {
        const url = this.samples[index].url;
        const response = await fetch(new URL(url, document.baseURI));
        if (!response.ok) throw new Error(`Ses dosyası yüklenemedi (${response.status})`);
        const buffer = await this.context!.decodeAudioData(await response.arrayBuffer());
        if (!(buffer.duration > 0)) throw new Error('Ses dosyası boş.');
        return buffer;
      })();
      this.loads.set(index, promise);
    }
    try {
      const buffer = await promise;
      this.buffers.set(index, buffer);
      return buffer;
    } finally { this.loads.delete(index); }
  }

  async select(index: number) {
    if (!Number.isInteger(index) || index < 0 || index >= this.layerWaveforms.length || !this.available) return;
    const request = ++this.request;
    this.queued = undefined;
    if (this.selected === index) { this.loading = undefined; this.onChange(); return; }
    const sample = this.remembered.get(index)?.sample ?? this.playlist.peek()!;
    this.loading = index;
    this.onChange();
    try {
      await this.prepare();
      await this.load(sample);
      if (request !== this.request) return;
      this.loading = undefined;
      this.finishTransition(false);
      if (this.selected === index) { this.onChange(); return; }
      if (this.transition) {
        // Finish the current pair before accepting the latest third choice.
        // This caps playback at two voices, including during rapid repeated clicks.
        this.queued = { index, sample };
        this.onChange();
        return;
      }
      this.switchTo(index, sample);
    } catch (error) {
      if (request !== this.request) return;
      this.loading = undefined;
      this.onChange();
      throw error;
    }
  }

  private switchTo(index: number, sample: number) {
    const context = this.context!;
    const now = context.currentTime;
    // A fresh choice after Stop must not overlap the tails of the stopped pair.
    for (const voice of this.stopping) {
      voice.stopAt = Math.min(voice.stopAt ?? now, now);
      voice.source.stop(now);
      this.disconnect(voice);
    }
    const outgoing = this.voices[0];
    const source = context.createBufferSource(), gain = context.createGain();
    const buffer = this.buffers.get(sample)!;
    source.buffer = buffer; source.loop = true;
    source.connect(gain); gain.connect(this.layerAnalysers[index]);
    const saved = this.remembered.get(index);
    const offset = (saved?.offset ?? 0) % buffer.duration;
    const voice: Voice = { index, sample, source, gain, startedAt: now, offset, envelope: { from: 0, to: 0, start: now, end: now } };
    this.voices.push(voice);
    const duration = outgoing ? CROSSFADE_SECONDS : .08;
    this.fade(voice, 1, duration, outgoing ? 'in' : undefined);
    source.start(now, offset);
    this.selected = this.lastSelected = index;
    if (!saved) {
      this.remembered.set(index, { sample, offset: 0 });
      this.playlist.consume(sample);
    }
    if (outgoing) {
      this.fade(outgoing, 0, duration, 'out');
      const transition = { outgoing, end: now + duration, timer: undefined as number | undefined };
      this.transition = transition;
      outgoing.stopAt = transition.end;
      outgoing.source.onended = () => this.finishTransition();
      outgoing.source.stop(transition.end);
      transition.timer = window.setTimeout(() => this.finishTransition(), duration * 1000);
    }
    this.onChange();
  }

  private fade(voice: Voice, to: number, duration: number, shape?: 'in' | 'out') {
    const now = this.context!.currentTime;
    const from = levelAt(voice.envelope, now);
    const param = voice.gain.gain;
    // Hold also cancels an in-progress value curve without a discontinuity.
    param.cancelAndHoldAtTime(now);
    voice.envelope = { from, to, start: now, end: now + duration, shape };
    if (shape) {
      const curve = Float32Array.from({ length: 129 }, (_, i) => levelAt(voice.envelope, now + duration * i / 128));
      param.setValueCurveAtTime(curve, now, duration);
    } else {
      param.setValueAtTime(from, now);
      param.linearRampToValueAtTime(to, now + duration);
    }
  }

  private finishTransition(startQueued = true) {
    const transition = this.transition;
    if (!transition || !this.context) return;
    clearTimeout(transition.timer);
    const remaining = transition.end - this.context.currentTime;
    if (remaining > .001) {
      transition.timer = window.setTimeout(() => this.finishTransition(), remaining * 1000);
      return;
    }
    this.transition = undefined;
    this.disconnect(transition.outgoing);
    this.voices = this.voices.filter(voice => voice !== transition.outgoing);
    const next = this.queued;
    this.queued = undefined;
    if (startQueued && next && next.index !== this.selected) this.switchTo(next.index, next.sample);
    else this.onChange();
  }

  private disconnect(voice: Voice) {
    // A delayed onended callback must not count time after the scheduled stop.
    const stoppedAt = Math.min(this.context!.currentTime, voice.stopAt ?? this.context!.currentTime);
    const duration = this.buffers.get(voice.sample)!.duration;
    this.remembered.set(voice.index, { sample: voice.sample, offset: (voice.offset + Math.max(0, stoppedAt - voice.startedAt)) % duration });
    this.stopping.delete(voice);
    voice.source.onended = null;
    voice.source.disconnect(); voice.gain.disconnect();
  }

  stopAll() {
    ++this.request;
    this.loading = this.selected = undefined; this.queued = undefined;
    clearTimeout(this.transition?.timer); this.transition = undefined;
    const now = this.context?.currentTime ?? 0;
    for (const voice of this.voices) {
      this.fade(voice, 0, .2);
      this.stopping.add(voice);
      voice.stopAt = now + .2;
      voice.source.onended = () => this.disconnect(voice);
      voice.source.stop(voice.stopAt);
    }
    this.voices = [];
    this.onChange();
  }

  get mediaMuted() { return this.media.size > 0; }
  get volume() { return this.volumeLevel; }
  get engaged() { return this.voices.length > 0 || this.loading !== undefined || this.queued !== undefined; }
  get transitioning() { return !!this.transition; }
  get pendingCount() { return Number(this.loading !== undefined || this.queued !== undefined); }
  state(index: number): LayerState {
    if (this.loading === index || this.queued?.index === index) return 'pending';
    if (this.selected === index) return 'on';
    if (this.voices.some(voice => voice.index === index)) return 'fading';
    return 'off';
  }

  setVolume(value: number) {
    if (!Number.isFinite(value)) return;
    this.volumeLevel = Math.max(0, Math.min(1, value));
    if (this.context && this.volumeGain) {
      const now = this.context.currentTime;
      this.volumeGain.gain.cancelScheduledValues(now);
      this.volumeGain.gain.setTargetAtTime(this.volumeLevel, now, .025);
    }
  }

  sampleSignals() {
    if (!this.analyser || this.context?.state !== 'running' || !this.engaged || this.mediaMuted || !this.volumeLevel) {
      this.waveform.fill(128); this.levels.fill(0);
      this.layerWaveforms.forEach(wave => wave.fill(128)); return;
    }
    this.analyser.getFloatTimeDomainData(this.signal);
    trace(this.signal, this.waveform, 5);
    const audibleGain = this.volumeLevel * this.mediaLevel() / MASTER_LEVEL;
    for (const [i, analyser] of this.layerAnalysers.entries()) {
      if (!this.voices.some(voice => voice.index === i)) { this.levels[i] = 0; this.layerWaveforms[i].fill(128); continue; }
      analyser.getFloatTimeDomainData(this.layerSignal);
      trace(this.layerSignal, this.layerWaveforms[i], 3 * audibleGain);
      let sum = 0;
      for (const sample of this.layerSignal) sum += sample * sample;
      this.levels[i] = Math.min(1, Math.sqrt(sum / this.layerSignal.length) * 5 * audibleGain);
    }
  }

  private mediaLevel() { return levelAt(this.envelope, this.context?.currentTime ?? 0); }
  setMediaActive(source: string, active: boolean) {
    const wasMuted = this.mediaMuted;
    if (active) this.media.add(source); else this.media.delete(source);
    if (wasMuted === this.mediaMuted) return;
    if (this.context && this.master) {
      const now = this.context.currentTime, level = this.mediaLevel();
      const target = this.mediaMuted ? 0 : MASTER_LEVEL, duration = this.mediaMuted ? .12 : 4;
      this.master.gain.cancelScheduledValues(now);
      this.master.gain.setValueAtTime(level, now);
      this.master.gain.linearRampToValueAtTime(target, now + duration);
      this.envelope = { from: level, to: target, start: now, end: now + duration };
    }
    // Video changes only the master gain; never the source or its playback position.
    this.onChange();
  }
  dispose() { this.stopAll(); void this.context?.close(); }
}
