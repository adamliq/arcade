import { SmackerFile, VGA_TO_8 } from './smacker.js';
import { parseScript, paletteLevel, musicLevel } from './script.js';

const MOVIE_URL = 'data/BAMDEMOF.SMK';
const SCRIPT_URL = 'data/DEMOF.SCR';
const SNAP_EVERY = 27; // keep a decoder snapshot every 3 s for instant seeking
const MUSIC_TRACK = 0;

// Scene list for the Blood & Magic preview (1-based frames, matching the fade-ins in DEMOF.SCR).
const CHAPTERS = [
  [1, 'Interplay'],
  [33, 'Tachyon Studios'],
  [61, 'Prologue'],
  [187, 'The Legend'],
  [562, 'Title Screen'],
  [605, 'Create Your Mage'],
  [675, 'Choose Your Story'],
  [734, 'Battle: Canyon Pass'],
  [827, 'Moonlit Ruins'],
  [897, 'Battle: River Ford'],
  [975, 'The Fallen Wyrm'],
  [1054, 'Battle: The Crypt'],
  [1164, 'The Spire'],
  [1239, 'Battle: Deep Forest'],
  [1378, 'The Burning Peak'],
  [1448, 'Battle: Town Siege'],
  [1551, 'Thirty Types of Creatures'],
  [1649, 'Finale'],
];

const $ = sel => document.querySelector(sel);
const store = {
  get(k, d) { try { const v = localStorage.getItem('bam.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('bam.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
};
const fmt = s => {
  s = Math.max(0, Math.floor(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

class Player {
  constructor() {
    this.el = $('#player');
    this.canvas = $('#screen');
    this.ctx2d = this.canvas.getContext('2d');
    this.overlay = $('#overlay');
    this.playing = false;
    this.offset = 0; // seconds, position when paused
    this.loop = store.get('loop', true);
    this.volume = store.get('volume', 0.8);
    this.muted = store.get('muted', false);
    this.crt = store.get('crt', true);
    this.lastDrawn = { frame: -1, level: -1, w: 0, h: 0 };
    this.bindUI();
    this.applySettings();
    new ResizeObserver(() => this.resize()).observe(this.canvas);
    requestAnimationFrame(t => this.tick(t));
  }

  // ---------- loading ----------

  async loadDefault() {
    try {
      const [movie, script] = await Promise.all([
        this.fetchWithProgress(MOVIE_URL),
        fetch(SCRIPT_URL).then(r => (r.ok ? r.text() : null)).catch(() => null),
      ]);
      await this.open(movie, script ? parseScript(script) : null, CHAPTERS, 'Blood & Magic — Preview');
    } catch (err) {
      console.error(err);
      this.showMessage('Could not load the demo data.',
        location.protocol === 'file:'
          ? 'Browsers block local file access. Serve this folder over HTTP (e.g. <code>python3 -m http.server</code>) or drop <b>BAMDEMOF</b> onto this page.'
          : 'Drop the original <b>BAMDEMOF</b> file (or any Smacker .smk video) onto this page to play it.');
    }
  }

  async fetchWithProgress(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    const total = +res.headers.get('content-length') || 0;
    if (!res.body || !total) return new Uint8Array(await res.arrayBuffer());
    const out = new Uint8Array(total);
    const reader = res.body.getReader();
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (got + value.length > out.length) { // content-encoding mismatch: fall back to growing
        const bigger = new Uint8Array(Math.max(out.length * 2, got + value.length));
        bigger.set(out.subarray(0, got));
        return this.finishGrow(reader, bigger, got, value);
      }
      out.set(value, got);
      got += value.length;
      this.setProgress('Downloading', got / total * 0.8);
    }
    return got === out.length ? out : out.slice(0, got);
  }

  async finishGrow(reader, buf, got, first) {
    let value = first;
    for (;;) {
      if (got + value.length > buf.length) {
        const b = new Uint8Array((got + value.length) * 2);
        b.set(buf.subarray(0, got));
        buf = b;
      }
      buf.set(value, got);
      got += value.length;
      const r = await reader.read();
      if (r.done) break;
      value = r.value;
    }
    return buf.slice(0, got);
  }

  async open(bytes, script, chapters, title) {
    this.pause();
    this.setProgress('Unpacking audio', 0.82);
    await nextFrame();
    const smk = new SmackerFile(bytes);
    this.smk = smk;
    this.script = script;
    this.title = title;
    this.duration = smk.frameCount / smk.fps;
    this.src = new ImageData(smk.width, smk.height);
    this.src32 = new Uint32Array(this.src.data.buffer);
    this.srcCanvas = document.createElement('canvas');
    this.srcCanvas.width = smk.width;
    this.srcCanvas.height = smk.height;
    this.srcCtx = this.srcCanvas.getContext('2d');
    this.midCanvas = document.createElement('canvas');
    this.midCtx = this.midCanvas.getContext('2d');

    this.pcm = smk.decodeAudio();
    this.buffers = null;

    // One full decode pass to build seek snapshots (~1 s for the whole movie).
    const dec = smk.createDecoder();
    this.snaps = [];
    let yieldAt = performance.now() + 30;
    for (let f = 0; f < smk.frameCount; f++) {
      dec.next();
      if (f % SNAP_EVERY === 0) this.snaps.push(dec.snapshot());
      if (performance.now() > yieldAt) {
        this.setProgress('Preparing video', 0.85 + 0.15 * f / smk.frameCount);
        await nextFrame();
        yieldAt = performance.now() + 30;
      }
    }
    this.dec = smk.createDecoder();
    this.previewDec = smk.createDecoder();
    this.offset = 0;
    this.lastDrawn.frame = -1;

    this.chapters = (chapters || []).filter(([f]) => f <= smk.frameCount);
    this.buildChapters();
    this.setupMediaSession();
    $('#scrub').max = this.duration;
    $('#dur').textContent = fmt(this.duration);
    document.title = `${title} · Arcade`;

    const p = new URLSearchParams(location.search);
    if (p.has('frame')) this.offset = Math.min(this.duration, (Math.max(1, +p.get('frame') || 1) - 1) / smk.fps);
    else if (p.has('t')) this.offset = Math.min(this.duration, Math.max(0, +p.get('t') || 0));

    this.ready = true;
    this.el.classList.add('ready');
    this.showStart();
  }

  // ---------- audio ----------

  ensureAudio() {
    if (this.actx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const actx = new AC();
    this.actx = actx;
    this.master = actx.createGain();
    // The 8-bit sample tracks carry a DC offset; strip it so pauses and seeks don't click.
    const hp = actx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 18;
    this.master.connect(hp).connect(actx.destination);
    this.applyVolume();
  }

  makeBuffers() {
    if (this.buffers || !this.actx) return;
    this.buffers = this.pcm.map(t => {
      const b = this.actx.createBuffer(t.channels.length, t.channels[0].length || 1, t.rate);
      t.channels.forEach((c, i) => b.copyToChannel(c, i));
      return { track: t.track, buffer: b };
    });
  }

  startAudio(at) {
    if (!this.actx) return;
    this.makeBuffers();
    const when = this.actx.currentTime + 0.04;
    this.sources = this.buffers.map(({ track, buffer }) => {
      const s = this.actx.createBufferSource();
      s.buffer = buffer;
      const g = this.actx.createGain();
      g.gain.value = track === MUSIC_TRACK ? this.musicGainAt(at) : 1;
      s.connect(g).connect(this.master);
      if (at < buffer.duration) s.start(when, at);
      return { s, g, track };
    });
    this.clockBase = { ctx: when, pos: at };
  }

  stopAudio() {
    for (const { s, g } of this.sources || []) {
      try { s.stop(); } catch { /* not started */ }
      s.disconnect(); g.disconnect();
    }
    this.sources = null;
  }

  musicGainAt(t) {
    return musicLevel(this.script, t * this.smk.fps + 1);
  }

  applyVolume() {
    if (!this.master) return;
    const v = this.muted ? 0 : this.volume * this.volume;
    this.master.gain.setTargetAtTime(v, this.actx.currentTime, 0.015);
  }

  // ---------- transport ----------

  now() {
    if (!this.playing) return this.offset;
    if (this.actx && this.clockBase) {
      const lat = this.actx.outputLatency || this.actx.baseLatency || 0;
      return Math.max(this.clockBase.pos, this.clockBase.pos + this.actx.currentTime - this.clockBase.ctx - lat);
    }
    return this.offset + (performance.now() - this.wallBase) / 1000;
  }

  play() {
    if (!this.ready || this.playing) return;
    this.ensureAudio();
    if (this.offset >= this.duration - 0.01) this.offset = 0;
    this.playing = true;
    if (this.actx) {
      this.actx.resume();
      this.startAudio(this.offset);
    } else {
      this.wallBase = performance.now();
    }
    this.hideOverlay();
    this.syncButtons();
  }

  pause() {
    if (!this.playing) return;
    this.offset = Math.min(this.duration, this.now());
    this.playing = false;
    this.stopAudio();
    this.syncButtons();
  }

  toggle() { this.playing ? this.pause() : this.play(); }

  seek(t) {
    if (!this.ready) return;
    t = Math.max(0, Math.min(this.duration, t));
    const was = this.playing;
    if (was) { this.playing = false; this.stopAudio(); }
    this.offset = t;
    if (was) this.play();
    else this.hideOverlay();
  }

  seekFrame(f) { this.seek((f - 1) / this.smk.fps + 1e-6); }

  step(n) {
    this.pause();
    const f = Math.floor(this.offset * this.smk.fps) + 1 + n;
    this.seekFrame(Math.max(1, Math.min(this.smk.frameCount, f)));
  }

  // ---------- video ----------

  // Bring a decoder to 0-based frame `target`, using snapshots for long jumps.
  advance(dec, target) {
    if (target === dec.frame) return;
    if (target < dec.frame || target - dec.frame > SNAP_EVERY) {
      const snap = this.snaps[Math.floor(target / SNAP_EVERY)];
      if (snap.frame > dec.frame || target < dec.frame) dec.restore(snap);
    }
    while (dec.frame < target) dec.next();
  }

  // Indexed pixels + 6-bit palette -> RGBA, with the script's palette fade applied.
  paint(dec, level, out32) {
    const lut = new Uint32Array(256);
    const pal = dec.palette;
    for (let i = 0; i < 256; i++) {
      const r = VGA_TO_8[Math.round(pal[i * 3] * level)];
      const g = VGA_TO_8[Math.round(pal[i * 3 + 1] * level)];
      const b = VGA_TO_8[Math.round(pal[i * 3 + 2] * level)];
      lut[i] = 0xff000000 | (b << 16) | (g << 8) | r;
    }
    const px = dec.pixels;
    for (let i = 0; i < px.length; i++) out32[i] = lut[px[i]];
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(r.width * dpr));
    const h = Math.max(1, Math.round(r.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.lastDrawn.frame = -1;
    }
    this.el.style.setProperty('--scan', `${(r.height / 200).toFixed(3)}px`);
  }

  draw(t) {
    const smk = this.smk;
    const frame = Math.min(smk.frameCount - 1, Math.floor(t * smk.fps));
    const pos = t * smk.fps + 1;
    const lvl = Math.round(paletteLevel(this.script, pos) * 63) / 63;
    const W = this.canvas.width, H = this.canvas.height;
    const L = this.lastDrawn;
    if (frame === L.frame && lvl === L.level && W === L.w && H === L.h) return;
    this.advance(this.dec, frame);
    this.paint(this.dec, lvl, this.src32);
    this.srcCtx.putImageData(this.src, 0, 0);
    // "Sharp bilinear": integer nearest-neighbour upscale, then a smooth fit to the screen.
    const kx = Math.max(1, Math.ceil(W / smk.width)), ky = Math.max(1, Math.ceil(H / smk.height));
    if (this.midCanvas.width !== smk.width * kx || this.midCanvas.height !== smk.height * ky) {
      this.midCanvas.width = smk.width * kx;
      this.midCanvas.height = smk.height * ky;
    }
    this.midCtx.imageSmoothingEnabled = false;
    this.midCtx.drawImage(this.srcCanvas, 0, 0, this.midCanvas.width, this.midCanvas.height);
    this.ctx2d.imageSmoothingEnabled = true;
    this.ctx2d.imageSmoothingQuality = 'high';
    this.ctx2d.drawImage(this.midCanvas, 0, 0, W, H);
    Object.assign(L, { frame, level: lvl, w: W, h: H });
  }

  tick() {
    requestAnimationFrame(() => this.tick());
    if (!this.ready) return;
    let t = this.now();
    if (this.playing && t >= this.duration) {
      if (this.loop) { this.seek(0); t = 0; }
      else { this.pause(); this.offset = t = this.duration; this.showEnd(); }
    }
    if (this.playing && this.sources) {
      const g = this.musicGainAt(t);
      for (const s of this.sources) if (s.track === MUSIC_TRACK) s.g.gain.setTargetAtTime(g, this.actx.currentTime, 0.03);
    }
    this.draw(Math.min(t, this.duration - 1e-6));
    this.updateTimeline(t);
  }

  // ---------- UI ----------

  bindUI() {
    $('#play').addEventListener('click', () => this.toggle());
    $('#start').addEventListener('click', () => this.play());
    this.canvas.addEventListener('click', () => this.toggle());
    this.canvas.addEventListener('dblclick', () => this.toggleFullscreen());
    $('#fullscreen').addEventListener('click', () => this.toggleFullscreen());
    $('#loop').addEventListener('click', () => { this.loop = !this.loop; store.set('loop', this.loop); this.applySettings(); });
    $('#crt').addEventListener('click', () => { this.crt = !this.crt; store.set('crt', this.crt); this.applySettings(); });
    $('#mute').addEventListener('click', () => this.setMuted(!this.muted));
    const vol = $('#volume');
    vol.addEventListener('input', () => {
      this.volume = +vol.value;
      store.set('volume', this.volume);
      if (this.muted && this.volume > 0) this.setMuted(false);
      this.applyVolume();
      this.applySettings();
    });

    const scrub = $('#scrub');
    scrub.addEventListener('pointerdown', () => { this.scrubbing = true; this.resumeAfterScrub = this.playing; this.pause(); });
    scrub.addEventListener('input', () => { this.offset = +scrub.value; this.hideOverlay(); });
    const endScrub = () => {
      if (!this.scrubbing) return;
      this.scrubbing = false;
      if (this.resumeAfterScrub) this.play();
    };
    scrub.addEventListener('change', endScrub);
    window.addEventListener('pointerup', endScrub);
    scrub.addEventListener('pointermove', e => this.preview(e));
    scrub.addEventListener('pointerleave', () => $('#preview').classList.remove('show'));

    document.addEventListener('keydown', e => this.onKey(e));
    document.addEventListener('fullscreenchange', () => this.el.classList.toggle('is-fullscreen', !!document.fullscreenElement));

    // Auto-hide controls while playing.
    let idle;
    const wake = () => {
      this.el.classList.remove('idle');
      clearTimeout(idle);
      idle = setTimeout(() => { if (this.playing) this.el.classList.add('idle'); }, 2500);
    };
    this.el.addEventListener('pointermove', wake);
    this.el.addEventListener('pointerdown', wake);
    document.addEventListener('keydown', wake);

    // Drag & drop any Smacker file.
    window.addEventListener('dragover', e => { e.preventDefault(); document.body.classList.add('dropping'); });
    window.addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('dropping'); });
    window.addEventListener('drop', async e => {
      e.preventDefault();
      document.body.classList.remove('dropping');
      const files = [...(e.dataTransfer?.files || [])];
      const movie = files.find(f => !/\.scr$/i.test(f.name));
      const scr = files.find(f => /\.scr$/i.test(f.name));
      if (!movie) return;
      try {
        const bytes = new Uint8Array(await movie.arrayBuffer());
        const isBam = /^bamdemo/i.test(movie.name);
        const script = scr ? parseScript(await scr.text()) : isBam ? this.script || null : null;
        this.ready = false;
        await this.open(bytes, script, isBam ? CHAPTERS : [], movie.name);
      } catch (err) {
        console.error(err);
        this.showMessage('That file could not be played.', String(err.message || err));
      }
    });
  }

  onKey(e) {
    if (e.target.closest('input[type=text], textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (!this.ready) return;
    const fps = this.smk.fps;
    const k = e.key;
    let handled = true;
    if (k === ' ' || k === 'k' || k === 'K') {
      if (e.target.closest('button') && k === ' ') return;
      this.toggle();
    } else if (k === 'ArrowRight' || k === 'l') this.seek(this.now() + (e.shiftKey ? 30 : 5));
    else if (k === 'ArrowLeft' || k === 'j') this.seek(this.now() - (e.shiftKey ? 30 : 5));
    else if (k === '.') this.step(1);
    else if (k === ',') this.step(-1);
    else if (k === 'Home') this.seek(0);
    else if (k === 'End') this.seek(this.duration - 1 / fps);
    else if (k === 'f' || k === 'F') this.toggleFullscreen();
    else if (k === 'm' || k === 'M') this.setMuted(!this.muted);
    else if (k === 'c' || k === 'C') $('#crt').click();
    else if (k === 'ArrowUp') this.nudgeVolume(0.1);
    else if (k === 'ArrowDown') this.nudgeVolume(-0.1);
    else if (k === 'PageDown' || k === 'n') this.jumpChapter(1);
    else if (k === 'PageUp' || k === 'p') this.jumpChapter(-1);
    else if (/^[0-9]$/.test(k)) this.seek(this.duration * (+k / 10));
    else handled = false;
    if (handled) e.preventDefault();
  }

  nudgeVolume(d) {
    const v = $('#volume');
    v.value = Math.max(0, Math.min(1, this.volume + d));
    v.dispatchEvent(new Event('input'));
  }

  setMuted(m) {
    this.muted = m;
    store.set('muted', m);
    this.applyVolume();
    this.applySettings();
  }

  jumpChapter(dir) {
    if (!this.chapters.length) return;
    const cur = this.now() * this.smk.fps + 1;
    const starts = this.chapters.map(c => c[0]);
    let target;
    if (dir > 0) target = starts.find(f => f > cur + 0.5);
    else {
      const prev = starts.filter(f => f < cur - this.smk.fps * 2);
      target = prev.length ? prev[prev.length - 1] : 1;
    }
    if (target) this.seekFrame(target);
  }

  toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else this.el.requestFullscreen?.().catch(() => {});
  }

  applySettings() {
    this.el.classList.toggle('crt', this.crt);
    $('#crt').setAttribute('aria-pressed', this.crt);
    $('#loop').setAttribute('aria-pressed', this.loop);
    const v = $('#volume');
    v.value = this.volume;
    v.style.setProperty('--fill', `${(this.muted ? 0 : this.volume) * 100}%`);
    $('#mute').classList.toggle('muted', this.muted || this.volume === 0);
    $('#mute').setAttribute('aria-label', this.muted ? 'Unmute' : 'Mute');
  }

  syncButtons() {
    this.el.classList.toggle('playing', this.playing);
    $('#play').setAttribute('aria-label', this.playing ? 'Pause' : 'Play');
    if (navigator.mediaSession) navigator.mediaSession.playbackState = this.playing ? 'playing' : 'paused';
  }

  updateTimeline(t) {
    const s = Math.floor(t);
    const frame = Math.min(this.smk.frameCount, Math.floor(t * this.smk.fps) + 1);
    if (!this.scrubbing) $('#scrub').value = t;
    $('#scrub').style.setProperty('--fill', `${(t / this.duration) * 100}%`);
    if (s !== this._s) { this._s = s; $('#cur').textContent = fmt(t); }
    if (frame !== this._f) {
      this._f = frame;
      $('#frame').textContent = `Frame ${frame} / ${this.smk.frameCount}`;
      const ch = this.chapterAt(frame);
      if (ch !== this._ch) {
        this._ch = ch;
        $('#chapter-name').textContent = ch >= 0 ? this.chapters[ch][1] : '';
        document.querySelectorAll('.chapter').forEach((el, i) => el.classList.toggle('current', i === ch));
      }
    }
  }

  chapterAt(frame) {
    let idx = -1;
    this.chapters.forEach(([f], i) => { if (f <= frame) idx = i; });
    return idx;
  }

  // Render an arbitrary frame (full brightness) into a small canvas.
  renderThumb(frame0, canvas) {
    const smk = this.smk;
    this.advance(this.previewDec, frame0);
    if (!this.thumbImg) {
      this.thumbImg = new ImageData(smk.width, smk.height);
      this.thumbCanvas = document.createElement('canvas');
      this.thumbCanvas.width = smk.width;
      this.thumbCanvas.height = smk.height;
    }
    this.paint(this.previewDec, 1, new Uint32Array(this.thumbImg.data.buffer));
    this.thumbCanvas.getContext('2d').putImageData(this.thumbImg, 0, 0);
    const c = canvas.getContext('2d');
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = 'high';
    c.drawImage(this.thumbCanvas, 0, 0, canvas.width, canvas.height);
  }

  preview(e) {
    if (!this.ready) return;
    const scrub = $('#scrub');
    const r = scrub.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const t = x * this.duration;
    const frame0 = Math.min(this.smk.frameCount - 1, Math.floor(t * this.smk.fps));
    const box = $('#preview');
    box.classList.add('show');
    const half = box.offsetWidth / 2;
    box.style.left = `${Math.max(half, Math.min(r.width - half, x * r.width))}px`;
    $('#preview-time').textContent = fmt(t);
    const ch = this.chapterAt(frame0 + 1);
    $('#preview-title').textContent = ch >= 0 ? this.chapters[ch][1] : '';
    if (this._pv === frame0) return;
    this._pv = frame0;
    cancelAnimationFrame(this._pvRaf);
    this._pvRaf = requestAnimationFrame(() => this.renderThumb(frame0, $('#preview canvas')));
  }

  buildChapters() {
    const list = $('#chapters');
    list.innerHTML = '';
    const ticks = $('#ticks');
    ticks.innerHTML = '';
    $('#chapters-section').hidden = !this.chapters.length;
    const fps = this.smk.fps;
    this.chapters.forEach(([f, name], i) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.className = 'chapter';
      btn.type = 'button';
      const cv = document.createElement('canvas');
      cv.width = 160; cv.height = 120;
      // Thumbnail from once the scene has faded in.
      const fadeIn = this.script?.palette.find(r => r.a === f && r.up);
      const shot = Math.min(this.smk.frameCount, (fadeIn ? fadeIn.b + 1 : f) + 9) - 1;
      this.renderThumb(shot, cv);
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.innerHTML = `<span class="num">${String(i + 1).padStart(2, '0')}</span><span class="name"></span><span class="time">${fmt((f - 1) / fps)}</span>`;
      meta.querySelector('.name').textContent = name;
      btn.append(cv, meta);
      btn.addEventListener('click', () => {
        this.seekFrame(f);
        if (!this.playing) this.play();
        this.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      li.append(btn);
      list.append(li);
      if (i > 0) {
        const tick = document.createElement('span');
        tick.style.left = `${((f - 1) / this.smk.frameCount) * 100}%`;
        ticks.append(tick);
      }
    });
  }

  setupMediaSession() {
    const ms = navigator.mediaSession;
    if (!ms) return;
    try {
      ms.metadata = new MediaMetadata({ title: this.title, artist: 'Tachyon Studios / Interplay', album: 'Blood & Magic (1996)' });
      ms.setActionHandler('play', () => this.play());
      ms.setActionHandler('pause', () => this.pause());
      ms.setActionHandler('seekbackward', () => this.seek(this.now() - 10));
      ms.setActionHandler('seekforward', () => this.seek(this.now() + 10));
      ms.setActionHandler('previoustrack', () => this.jumpChapter(-1));
      ms.setActionHandler('nexttrack', () => this.jumpChapter(1));
      ms.setActionHandler('seekto', d => this.seek(d.seekTime));
    } catch { /* partial support */ }
  }

  // ---------- overlay ----------

  setProgress(label, p) {
    this.overlay.dataset.state = 'loading';
    $('#loading-label').textContent = label;
    $('#loading-bar').style.setProperty('--p', `${Math.round(p * 100)}%`);
  }

  showStart() {
    this.overlay.dataset.state = 'start';
    // Poster: the title screen, or the first frame for other movies.
    const poster = this.chapters.find(c => c[1] === 'Title Screen');
    const f = poster ? poster[0] + 14 : Math.floor(this.offset * this.smk.fps) + 1;
    this.renderThumb(f - 1, $('#poster'));
  }

  showEnd() {
    this.overlay.dataset.state = 'end';
    this.syncButtons();
  }

  showMessage(title, html) {
    this.overlay.dataset.state = 'error';
    $('#error-title').textContent = title;
    $('#error-body').innerHTML = html;
  }

  hideOverlay() {
    if (this.ready) this.overlay.dataset.state = 'hidden';
  }
}

// Yield to the browser (setTimeout keeps working in background tabs, unlike rAF).
const nextFrame = () => new Promise(r => setTimeout(r, 0));

const player = new Player();
$('#replay').addEventListener('click', () => { player.seek(0); player.play(); });
player.loadDefault();
window.bam = player; // handy for debugging from the console
