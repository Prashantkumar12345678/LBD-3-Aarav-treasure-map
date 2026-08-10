/* =============================================================================
   Aarav and the Treasure Map — Vanilla JS reimplementation (no dependencies)
   Faithful port of the Unity project (LBD 1, LBD 2, LBD 3).

   Original Unity scripts ported here 1:1 in behaviour:
     - GridGenerator    -> Grid (cell math + grid line drawing)
     - PlayerController  -> PlayerController (LBD 1 & 2)
     - ShipController    -> ShipController (LBD 3, incl. BFS pathfinding)
     - ItemManager       -> ItemManager (collect animation + final screen)
     - ChatManager       -> ChatManager (typewriter + synced voice-over, queue/interrupt)
     - AudioManager      -> AudioManager (bg / sfx / win / collect / mute)
     - SplashController   -> handled in Level.showSplash()
     - TutorialManager   -> TutorialManager

   The DOTween dependency is replaced by the small Tween/Sequence engine below.
   No mechanic or timing has been removed; thresholds and sequence intervals
   mirror the C# source exactly.
============================================================================= */
(function () {
"use strict";

/* =============================================================================
   0. TWEEN ENGINE  (replacement for Demigiant DOTween — only the used subset)
   ---------------------------------------------------------------------------
   Supports: property tweens, easing (Linear, OutQuad, OutBack, OutElastic,
   InBack, InOutSine), Yoyo loops, shake, delayed calls, kill, and a chainable
   Sequence (Append / AppendInterval / AppendCallback / Join / OnComplete).
============================================================================= */
const Ease = {
  Linear:     t => t,
  OutQuad:    t => 1 - (1 - t) * (1 - t),
  InOutSine:  t => -(Math.cos(Math.PI * t) - 1) / 2,
  InBack:     t => { const c1 = 1.70158, c3 = c1 + 1; return c3 * t * t * t - c1 * t * t; },
  OutBack:    t => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); },
  OutElastic: t => {
    const c4 = (2 * Math.PI) / 3;
    return t === 0 ? 0 : t === 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
  },
};

const _tweens = new Set();
let _lastTime = null;

function _tick(now) {
  if (_lastTime === null) _lastTime = now;
  const dt = Math.min((now - _lastTime) / 1000, 0.05); // clamp big frame gaps
  _lastTime = now;
  for (const tw of Array.from(_tweens)) tw._step(dt);
  requestAnimationFrame(_tick);
}
requestAnimationFrame(_tick);

class Tween {
  constructor(target, to, duration, ease, onUpdate, onComplete) {
    this.target = target;
    this.to = to;
    this.from = {};
    for (const k in to) this.from[k] = target[k];
    this.duration = Math.max(duration, 0.0001);
    this.ease = ease || Ease.Linear;
    this.onUpdate = onUpdate;
    this.onComplete = onComplete;
    this.elapsed = 0;
    this.loops = 0;          // -1 = infinite
    this.loopType = null;    // 'yoyo'
    this._dir = 1;
    this.dead = false;
    _tweens.add(this);
  }
  setLoops(n, type) { this.loops = n; this.loopType = type; return this; }
  _step(dt) {
    if (this.dead) return;
    this.elapsed += dt * this._dir;
    let t = this.elapsed / this.duration;
    if (t >= 1) {
      if (this.loops === -1 && this.loopType === 'yoyo') { this._dir = -1; this.elapsed = this.duration; t = 1; }
      else t = 1;
    } else if (t <= 0 && this._dir === -1) { this._dir = 1; this.elapsed = 0; t = 0; }
    const e = this.ease(Math.max(0, Math.min(1, t)));
    for (const k in this.to) this.target[k] = this.from[k] + (this.to[k] - this.from[k]) * e;
    if (this.onUpdate) this.onUpdate();
    if (t >= 1 && !(this.loops === -1)) {
      this.kill();
      if (this.onComplete) this.onComplete();
    }
  }
  kill() { this.dead = true; _tweens.delete(this); }
}

function delayedCall(seconds, cb) {
  const t = new Tween({ v: 0 }, { v: 1 }, seconds, Ease.Linear, null, cb);
  return t;
}

// A chainable sequence, faithful to DOTween.Sequence usage in the project.
class Sequence {
  constructor() { this.steps = []; this.running = false; this._killed = false; this._onComplete = null; }
  append(factory)      { this.steps.push({ type: 'tween', factory }); return this; }
  appendInterval(sec)  { this.steps.push({ type: 'interval', sec }); return this; }
  appendCallback(cb)   { this.steps.push({ type: 'callback', cb }); return this; }
  onComplete(cb)       { this._onComplete = cb; return this; }
  play() { this.running = true; this._runFrom(0); return this; }
  kill() { this._killed = true; }
  _runFrom(i) {
    if (this._killed) return;
    if (i >= this.steps.length) { if (this._onComplete) this._onComplete(); return; }
    const step = this.steps[i];
    const next = () => this._runFrom(i + 1);
    if (step.type === 'callback') { step.cb(); next(); }
    else if (step.type === 'interval') { delayedCall(step.sec, next); }
    else if (step.type === 'tween') { const tw = step.factory(); if (tw && tw.onComplete === undefined) {} step.factory._done = next; /* factory must call next */ }
  }
}

/* ---- element transform helpers (compose translate + scale + rotate) -------- */
function initTransform(el) {
  if (el._tf) return el._tf;
  el._tf = { x: 0, y: 0, scale: 1, rot: 0, baseCenter: true, flipX: false };
  return el._tf;
}
function applyTransform(el) {
  const tf = initTransform(el);
  // Unity Y is up; CSS Y is down -> negate y. Elements are centered at their cell.
  const centre = tf.baseCenter ? 'translate(-50%, -50%) ' : '';
  const sx = tf.flipX ? -tf.scale : tf.scale;   // flipX mirrors horizontally (e.g. ship facing right)
  el.style.transform = `${centre}translate(${tf.x}px, ${-tf.y}px) rotate(${tf.rot}deg) scale(${sx}, ${tf.scale})`;
}

// Move a positioned element to field-space (x,y) with y-up, easing over dur.
function doMove(el, x, y, dur, ease, onComplete) {
  const tf = initTransform(el);
  return new Tween(tf, { x, y }, dur, ease, () => applyTransform(el), onComplete);
}
function doScale(el, to, dur, ease, onComplete) {
  const tf = initTransform(el);
  return new Tween(tf, { scale: to }, dur, ease, () => applyTransform(el), onComplete);
}
function doRotate(el, deg) { const tf = initTransform(el); tf.rot = deg; applyTransform(el); }
function doFade(el, to, dur, onComplete) {
  const st = { a: parseFloat(el.style.opacity || getComputedStyle(el).opacity || 1) };
  return new Tween(st, { a: to }, dur, Ease.OutQuad, () => { el.style.opacity = st.a; }, onComplete);
}
function doShake(el, dur, strength) {
  const tf = initTransform(el);
  const baseX = tf.x, baseY = tf.y;
  const st = { p: 0 };
  return new Tween(st, { p: 1 }, dur, Ease.Linear, () => {
    const damp = 1 - st.p;
    tf.x = baseX + (Math.random() * 2 - 1) * strength * damp;
    tf.y = baseY + (Math.random() * 2 - 1) * strength * damp;
    applyTransform(el);
  }, () => { tf.x = baseX; tf.y = baseY; applyTransform(el); });
}
function killTweensOn(el) {
  const tf = el._tf;
  if (!tf) return;
  for (const tw of Array.from(_tweens)) if (tw.target === tf) tw.kill();
}

/* =============================================================================
   1. GRID  (port of GridGenerator.cs)
============================================================================= */
class Grid {
  constructor(el, cols, rows) {
    this.el = el;
    this.columns = cols;
    this.rows = rows;
  }
  get width()  { return this.el.clientWidth; }
  get height() { return this.el.clientHeight; }
  // GetCellPosition — identical math to Unity (center origin, y up)
  getCellPosition(col, row) {
    const w = this.width, h = this.height;
    const x = ((col + 0.5) * (w / this.columns)) - (w / 2);
    const y = ((row + 0.5) * (h / this.rows)) - (h / 2);
    return { x, y };
  }
}

/* =============================================================================
   2. AUDIO MANAGER  (port of AudioManager.cs)
   Note (from source): PlayLossSound() is used as the *collect* sound.
============================================================================= */
class AudioManager {
  constructor() {
    this.isMuted = false;
    this.bg = new Audio();          this.bg.loop = true;   this.bg.volume = 0.2;   // background music only (further reduced)
    this.bg.preload = 'none';       // preloader feeds it a blob later — avoid a double download
    this.title = new Audio();       this.title.loop = false;   this.title.preload = 'none';
    this.sfx = { click: null, win: null, loss: null };
    this._titlePlayed = false;
  }
  setClips(clips) {
    if (clips.bg)   this._bgSrc = clips.bg;     // resolved to a blob: URL lazily at play time
    if (clips.win)  this.sfx.win = clips.win;
    if (clips.loss) this.sfx.loss = clips.loss;
    if (clips.click)this.sfx.click = clips.click;
  }
  playBackgroundMusic() { if (this._bgSrc) { setMediaSrc(this.bg, this._bgSrc); this.bg.muted = this.isMuted; this.bg.play().catch(()=>{}); } }
  stopBackgroundMusic() { this.bg.pause(); }
  _oneShot(src) { if (!src) return; const a = new Audio(); setMediaSrc(a, src); a.muted = this.isMuted; a.play().catch(()=>{}); }
  playButtonClick() { this._oneShot(this.sfx.click); }
  playWinSound()    { this._oneShot(this.sfx.win); }
  playLossSound()   { this._oneShot(this.sfx.loss); }   // == collect sound
  playChime()       { this._oneShot(this.sfx.loss); }   // collect.ogg "ching" — used for ship/island pulses
  toggleMute() {
    this.isMuted = !this.isMuted;
    this.bg.muted = this.isMuted;
    return this.isMuted;
  }
}

/* =============================================================================
   3. CHAT MANAGER  (port of ChatManager.cs)
   - Typewriter reveal synced with voice-over.
   - sequenceMode = Interrupt (scene value was 1) -> new chat stops current.
   - Repository is per-level: { index: {text, audio} }  (reconstructed from the
     controller code semantics + the original VO filenames, since the Unity
     scenes shipped with an empty repository).
============================================================================= */
const ChatSequenceMode = { Queue: 0, Interrupt: 1 };

class ChatManager {
  constructor(boxEl, audioMgr) {
    this.box = boxEl;
    this.audioMgr = audioMgr;
    this.repository = {};       // index -> { text, audio }
    this.typingSpeed = 0.045;   // seconds per character
    this.sequenceMode = ChatSequenceMode.Interrupt;
    this.voice = new Audio(); this.voice.preload = 'none';   // fed blob: URLs by the preloader
    this._queue = [];
    this._busy = false;
    this._typingTween = null;
    this._voiceWaiter = null;
    this._active = null;
  }
  setRepository(repo) { this.repository = repo; }
  setMuted(m) { this.voice.muted = m; }
  // Show text instantly with NO voice-over (used for repeating instructions).
  showText(text) { this.stopAllActiveChat(true); this.box.textContent = text || ''; }

  // PlayChat(index, clearTextOnWait, preDelay, postDelay, onComplete)
  playChat(index, clearTextOnWait = true, preDelay = 0, postDelay = 0, onComplete = null) {
    const req = { index, preDelay, postDelay, clearTextOnWait, onComplete };
    if (this.sequenceMode === ChatSequenceMode.Interrupt) {
      this.stopAllActiveChat(clearTextOnWait);
      this._execute(req);
    } else {
      this._queue.push(req);
      if (!this._busy) this._processQueue();
    }
  }
  // Overload: play by exact text (ItemManager final screen used a string).
  playChatText(text, clearTextOnWait = false, onComplete = null) {
    let foundIndex = null;
    for (const k in this.repository)
      if ((this.repository[k].text || '').trim().toLowerCase() === text.trim().toLowerCase()) { foundIndex = k; break; }
    if (foundIndex !== null) this.playChat(parseInt(foundIndex), clearTextOnWait, 0, 0, onComplete);
    else { // still show the literal text even if not in repo
      this.playChatDirect({ text, audio: null }, clearTextOnWait, onComplete);
    }
  }
  playChatDirect(item, clearTextOnWait, onComplete) {
    this.stopAllActiveChat(clearTextOnWait);
    this._runItem(item, 0, 0, onComplete);
  }
  _processQueue() {
    this._busy = true;
    const step = () => {
      if (this._queue.length === 0) { this._busy = false; return; }
      this._execute(this._queue.shift(), step);
    };
    step();
  }
  _execute(req, afterQueueStep) {
    const item = this.repository[req.index];
    if (!item) { if (req.onComplete) req.onComplete(); if (afterQueueStep) afterQueueStep(); return; }
    if (req.clearTextOnWait) { this.box.textContent = ''; }
    const start = () => this._runItem(item, req.postDelay, 0, () => {
      if (req.onComplete) req.onComplete();
      if (afterQueueStep) afterQueueStep();
    });
    if (req.preDelay > 0) delayedCall(req.preDelay, start); else start();
  }
  _runItem(item, postDelay, _pre, onComplete) {
    const text = item.text || '';
    this.box.textContent = text;
    // reveal via a clip: use CSS by wrapping? Simpler: animate substring.
    this.box.textContent = '';
    // Voice
    if (item.audio) {
      this.voice.pause();
      setMediaSrc(this.voice, item.audio);
      this.voice.muted = this.audioMgr ? this.audioMgr.isMuted : false;
      this.voice.play().catch(()=>{});
    }
    const total = Math.max(text.length * this.typingSpeed, 0.2);
    const st = { n: 0 };
    this._active = st;
    this._typingTween = new Tween(st, { n: text.length }, total, Ease.Linear, () => {
      this.box.textContent = text.substring(0, Math.floor(st.n));
    }, () => {
      this.box.textContent = text;
      // wait for voice to finish — with a hard safety cap so a stalled/failed
      // audio clip can never freeze the game (which would block the tutorial).
      const startWait = now();
      const waitVoice = () => {
        const playing = item.audio && !this.voice.paused && !this.voice.ended;
        const cap = (isFinite(this.voice.duration) && this.voice.duration > 0) ? this.voice.duration + 1 : 4;
        if (playing && (now() - startWait) < cap) { this._voiceWaiter = requestAnimationFrame(waitVoice); return; }
        if (postDelay > 0) delayedCall(postDelay, () => onComplete && onComplete());
        else onComplete && onComplete();
      };
      waitVoice();
    });
  }
  // Typewriter that fires per-word cues as each word is fully revealed, optionally
  // holding (voice + typing paused together, so they stay in sync) for a beat so a
  // matching sprite can pulse. Used by the scripted intro ("...the SHIP...ISLAND.").
  playChatCued(index, cues, onComplete) {
    const item = this.repository[index];
    if (!item) { if (onComplete) onComplete(); return; }
    this.stopAllActiveChat(true);
    const text = item.text || '';
    const lower = text.toLowerCase();
    const marks = (cues || []).map((c) => {
      const at = lower.indexOf(c.word.toLowerCase());
      return at < 0 ? null : { end: at + c.word.length, fn: c.fn, pause: c.pause || 0, fired: false };
    }).filter(Boolean).sort((a, b) => a.end - b.end);

    this.box.textContent = '';
    this._cuedActive = true;
    let n = 0;
    // Pace the reveal to the VOICE (perChar = audioDuration / textLength) so a cue
    // fires when the word is actually spoken — not early (typewriter default is faster).
    const run = (perChar) => {
      if (!this._cuedActive) return;
      const advance = () => {
        if (!this._cuedActive) return;
        if (n >= text.length) { this._cuedActive = false; if (onComplete) delayedCall(0.15, onComplete); return; }
        n++;
        delayedCall(perChar, step);
      };
      const step = () => {
        if (!this._cuedActive) return;
        this.box.textContent = text.substring(0, n);
        const cue = marks.find((m) => !m.fired && m.end <= n);
        if (cue) {
          cue.fired = true;
          if (item.audio) this.voice.pause();        // hold voice + typing together for the beat
          const resume = () => {                     // called when the cue's pulses finish
            if (!this._cuedActive) return;
            if (item.audio) this.voice.play().catch(() => {});
            delayedCall(cue.pause || 0, advance);
          };
          if (cue.fn) cue.fn(resume); else resume();
          return;
        }
        advance();
      };
      step();
    };
    if (item.audio) {
      this.voice.pause();
      setMediaSrc(this.voice, item.audio);
      this.voice.muted = this.audioMgr ? this.audioMgr.isMuted : false;
      let started = false;
      const begin = () => {
        if (started || !this._cuedActive) return; started = true;
        const d = this.voice.duration;
        const perChar = (isFinite(d) && d > 0) ? Math.max(d / text.length, 0.03) : this.typingSpeed;
        this.voice.play().catch(() => {});
        run(perChar);
      };
      if (isFinite(this.voice.duration) && this.voice.duration > 0) begin();
      else {
        const onMeta = () => { this.voice.removeEventListener('loadedmetadata', onMeta); begin(); };
        this.voice.addEventListener('loadedmetadata', onMeta);
        this.voice.load();
        delayedCall(0.5, begin);                     // fallback if metadata never arrives
      }
    } else {
      run(this.typingSpeed);
    }
  }
  stopAllActiveChat(clearText = true) {
    this._cuedActive = false;
    if (this._typingTween) this._typingTween.kill();
    if (this._voiceWaiter) cancelAnimationFrame(this._voiceWaiter);
    this.voice.pause();
    if (clearText && this.box) this.box.textContent = '';
    this._busy = false;
    this._queue.length = 0;
  }
}

/* =============================================================================
   Helper: create a positioned game element inside the play field.
============================================================================= */
function makeSprite(parent, src, cls) {
  const el = document.createElement('div');
  el.className = 'sprite ' + (cls || '');
  if (src) el.style.backgroundImage = `url("${src}")`;
  parent.appendChild(el);
  initTransform(el);
  return el;
}
function placeAt(el, pos) { const tf = initTransform(el); tf.x = pos.x; tf.y = pos.y; applyTransform(el); }

/* =============================================================================
   4. ITEM MANAGER  (port of ItemManager.cs)
============================================================================= */
class ItemManager {
  constructor(ctx) {
    this.ctx = ctx;                 // Level context (grid, field, chat, audio, particles)
    this.items = ctx.config.items || [];
    this.zoomScale = ctx.config.zoomScale || 4;
    this.collectionOffsetX = ctx.config.collectionOffsetX || 0;
    this.finalScreenFadeDuration = 0.5;
    this.currentItemIndex = 0;
    this._elements = [];
    this._build();
  }
  _build() {
    const g = this.ctx.grid;
    this.items.forEach((it, i) => {
      const el = makeSprite(this.ctx.field, this.ctx.assetImg(it.sprite), 'item');
      if (it.w) el.style.width = it.w + 'px';
      if (it.h) el.style.height = it.h + 'px';
      const targetCol = Math.floor(g.columns / 2) + it.colOffset;
      const targetRow = Math.floor(g.rows / 2) + it.rowOffset;
      const base = g.getCellPosition(targetCol, targetRow);
      const tf = initTransform(el);
      tf.x = base.x + (it.offsetX || 0);
      tf.y = base.y + (it.offsetY || 0);
      applyTransform(el);
      el.style.display = 'none';
      // glow child (used by AnimateCurrentItemScale) — CSS radial halo, not an image
      const glow = makeSprite(el, null, 'glow-child');
      glow.style.display = 'none';
      el._glow = glow;
      it._el = el;
      this._elements.push(el);
    });
  }
  activateNextItem() {
    if (this.currentItemIndex < this.items.length && this.items[this.currentItemIndex]._el) {
      const el = this.items[this.currentItemIndex]._el;
      el.style.display = '';
      const tf = initTransform(el); tf.scale = 1; applyTransform(el);
      // Notify controller
      if (this.ctx.controller.onNewItem) this.ctx.controller.onNewItem();
    } else if (this.currentItemIndex >= this.items.length) {
      // Final screen
      this.ctx.showFinalScreen();
    }
  }
  getCurrentTargetDirection() { return this.currentItemIndex < this.items.length ? this.items[this.currentItemIndex].direction : ''; }
  getRequiredStepsForCurrentItem() {
    if (this.currentItemIndex >= this.items.length) return 0;
    const it = this.items[this.currentItemIndex];
    return Math.abs(it.colOffset) + Math.abs(it.rowOffset);
  }
  getCurrentItemObject() { return this.currentItemIndex < this.items.length ? this.items[this.currentItemIndex]._el : null; }

  collectItem() {
    if (this.currentItemIndex < this.items.length) {
      this._animateCollection(this.items[this.currentItemIndex]);
      this.currentItemIndex++;
    }
  }
  _animateCollection(itemData) {
    // Faithful to ItemManager.AnimateCollectionDOTween: collect sound + particle
    // fade-in -> reset player -> zoom (elastic) -> hold -> particle fade-out ->
    // next item. The full-screen "zoom" presentation (dim + tinted ray-burst +
    // sparkles + glow behind the enlarged item) is built by the Level.
    this.ctx.audio.playWinSound();
    if (itemData._el) itemData._el.style.display = 'none';
    this.ctx.playCollection(itemData, () => this.activateNextItem());
  }
}

/* =============================================================================
   5. PLAYER CONTROLLER  (port of PlayerController.cs — LBD 1 & 2)
============================================================================= */
class PlayerController {
  constructor(ctx) {
    this.ctx = ctx;
    this.grid = ctx.grid;
    this.itemManager = ctx.itemManager;
    this.chat = ctx.chat;
    this.moveSpeed = 5;
    this.resetDelay = 3;
    this.idleTimeThreshold = 10;

    this.el = ctx.characterEl;
    this.currentCol = Math.floor(this.grid.columns / 2);
    this.currentRow = Math.floor(this.grid.rows / 2);
    this.isMoving = false;
    this.lastInteractionTime = now();
    this.moveCountForCurrentDirection = 0;
    this.incorrectCount = 0;
    this.isIdleTimerActive = false;

    placeAt(this.el, this.grid.getCellPosition(this.currentCol, this.currentRow));
    this._hideHints();
    this._idleLoop();
  }
  _hideHints() {
    const c = this.ctx;
    if (c.idleEl) c.idleEl.style.display = 'none';
    if (c.incorrectEl) c.incorrectEl.style.display = 'none';
    if (c.tryAgainEl) c.tryAgainEl.style.display = 'none';
    if (c.handEl) c.handEl.style.display = 'none';
  }
  start() { this.playDirectionalChat(); }
  onNewItem() { this.updateTargetRotation(); this.resetIdleTimer(); this.playDirectionalChat(); }

  _idleLoop() {
    const loop = () => {
      if (this.isIdleTimerActive && now() - this.lastInteractionTime > this.idleTimeThreshold) this.showIdleHint();
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }
  showIdleHint() {
    const c = this.ctx;
    if (c.idleEl && c.idleEl.style.display === 'none') {
      c.idleEl.style.display = '';
      c.showCharGlow(true);
      this.animateCurrentItemScale();
      this.updateTargetRotation();
      if (c.handEl && this.incorrectCount >= 0) c.handEl.style.display = '';
      this.playIdleHintChat();
    }
  }
  resetIdleTimer() {
    this.lastInteractionTime = now();
    if (this.ctx.idleEl) this.ctx.idleEl.style.display = 'none';
    if (this.ctx.handEl) this.ctx.handEl.style.display = 'none';
    this.ctx.showCharGlow(false);
  }
  moveUp()    { this.handleMove(0, 1); }
  moveDown()  { this.handleMove(0, -1); }
  moveLeft()  { this.handleMove(-1, 0); }
  moveRight() { this.handleMove(1, 0); }

  handleMove(colDelta, rowDelta) {
    if (this.isMoving) return;
    this.isIdleTimerActive = true;
    this.lastInteractionTime = now();
    if (this.ctx.idleEl) this.ctx.idleEl.style.display = 'none';
    if (this.ctx.handEl) this.ctx.handEl.style.display = 'none';

    const nextCol = this.currentCol + colDelta;
    const nextRow = this.currentRow + rowDelta;
    if (nextCol < 0 || nextCol >= this.grid.columns || nextRow < 0 || nextRow >= this.grid.rows) {
      doShake(this.el, 0.2, 10);
      return;
    }
    const targetDir = this.itemManager.getCurrentTargetDirection();
    let isCorrect = false;
    if (targetDir === 'Top' && rowDelta === 1 && colDelta === 0) isCorrect = true;
    else if (targetDir === 'Bottom' && rowDelta === -1 && colDelta === 0) isCorrect = true;
    else if (targetDir === 'Left' && colDelta === -1 && rowDelta === 0) isCorrect = true;
    else if (targetDir === 'Right' && colDelta === 1 && rowDelta === 0) isCorrect = true;

    this.currentCol = nextCol; this.currentRow = nextRow;
    const targetPos = this.grid.getCellPosition(this.currentCol, this.currentRow);

    if (isCorrect) {
      this.incorrectCount = 0;
      this.moveCountForCurrentDirection++;
      const requiredSteps = this.itemManager.getRequiredStepsForCurrentItem();
      if (this.moveCountForCurrentDirection < requiredSteps) {
        this.playMovementHintChat(requiredSteps - this.moveCountForCurrentDirection);
        this._moveTo(targetPos, false);
      } else {
        this._moveTo(targetPos, false, true);
        this.chat.playChat(27, false);
        this.ctx.audio.playLossSound(); // collect sound
      }
    } else {
      this.incorrectCount++;
      switch (targetDir) {
        case 'Top':    this.chat.playChat(28, false); break;
        case 'Bottom': this.chat.playChat(30, false); break;
        case 'Right':  this.chat.playChat(29, false); break;
        case 'Left':   this.chat.playChat(31, false); break;
      }
      this._moveTo(targetPos, true);
    }
  }
  _moveTo(target, isWrong, isWin = false) {
    this.isMoving = true;
    const dur = 1 / this.moveSpeed;
    doMove(this.el, target.x, target.y, dur, Ease.Linear, () => {
      this.isMoving = false;
      if (isWin) { this._startWinSequence(); }
      else if (isWrong) {
        const c = this.ctx;
        chain([
          (next) => delayedCall(1.0, next),
          (next) => { if (c.incorrectEl) { const ct = initTransform(this.el), it = initTransform(c.incorrectEl); it.x = ct.x; it.y = ct.y; applyTransform(c.incorrectEl); c.incorrectEl.style.display = ''; } next(); },
          (next) => delayedCall(this.resetDelay - 1, next),
          (next) => {
            if (c.incorrectEl) c.incorrectEl.style.display = 'none';
            if (c.idleEl) c.idleEl.style.display = 'none';
            if (c.handEl) c.handEl.style.display = 'none';
            this.chat.playChat(32, false, 1);   // "Oops! Try again." voice
            if (c.tryAgainEl) c.tryAgainEl.style.display = '';   // wooden Try Again sign
            next();
          },
          (next) => delayedCall(1.0, next),
          (next) => { this.resetToCenterImmediate(); next(); },
          (next) => delayedCall(4.0, next),
          (next) => {
            if (c.tryAgainEl) c.tryAgainEl.style.display = 'none';
            this.lastInteractionTime = now();
            if (this.incorrectCount >= 2) this.showIdleHint();
          },
        ]);
      }
    });
  }
  _startWinSequence() {
    this.ctx.setButtonsEnabled(false);
    chain([
      (next) => delayedCall(1.5, next),
      (next) => { this.itemManager.collectItem(); },
    ]);
  }
  resetToStart() { this.resetToCenterImmediate(); }
  resetToCenterImmediate() {
    killTweensOn(this.el);
    this.currentCol = Math.floor(this.grid.columns / 2);
    this.currentRow = Math.floor(this.grid.rows / 2);
    placeAt(this.el, this.grid.getCellPosition(this.currentCol, this.currentRow));
    this.moveCountForCurrentDirection = 0;
    this.isMoving = false;
    this.ctx.setButtonsEnabled(true);
    if (this.ctx.incorrectEl) this.ctx.incorrectEl.style.display = 'none';
    if (this.ctx.handEl) this.ctx.handEl.style.display = 'none';
  }
  updateTargetRotation() {
    const targetDir = this.itemManager.getCurrentTargetDirection();
    let z = 0, ox = 0, oy = 0; const D = 105;   // z = CSS rotation (clockwise): up=0, right=90, down=180, left=-90
    switch (targetDir) {
      case 'Top':    z = 0;   oy =  D; break;
      case 'Bottom': z = 180; oy = -D; break;
      case 'Right':  z = 90;  ox =  D; break;
      case 'Left':   z = -90; ox = -D; break;
    }
    if (this.ctx.idleEl) {
      const ctf = initTransform(this.el), itf = initTransform(this.ctx.idleEl);
      itf.x = ctf.x + ox; itf.y = ctf.y + oy;   // sit the arrow OFF the ship, in the travel direction
      doRotate(this.ctx.idleEl, z);
    }
    // Hand position over correct button (index order: Top=0, Left=1, Bottom=2, Right=3)
    if (this.ctx.handEl) {
      let bi = -1;
      switch (targetDir) { case 'Top': bi = 0; break; case 'Left': bi = 1; break; case 'Bottom': bi = 2; break; case 'Right': bi = 3; break; }
      this.ctx.positionHandOverButton(bi);
    }
  }
  // ---- chat (reconstructed indices, faithful to source switch structure) ----
  playDirectionalChat() {
    const targetDir = this.itemManager.getCurrentTargetDirection();
    const onDone = () => { this.isIdleTimerActive = true; this.lastInteractionTime = now(); this.animateCurrentItemScale(); };
    const seq = (a, b) => this.chat.playChat(a, false, 0, 0, () => { this.animateCurrentItemScale(); this.chat.playChat(b, false, 0, 0, onDone); });
    switch (targetDir) {
      case 'Top':    seq(6, 9); break;
      case 'Bottom': seq(7, 11); break;
      case 'Right':  seq(7, 10); break;
      case 'Left':   seq(8, 12); break;
    }
  }
  playIdleHintChat() {
    const targetDir = this.itemManager.getCurrentTargetDirection();
    const handShowing = this.ctx.handEl && this.incorrectCount >= 2;
    const pair = (base, follow) => handShowing
      ? this.chat.playChat(base, false, 0, (base === 13 ? 1 : 0), () => this.chat.playChat(follow, false))
      : this.chat.playChat(base, false);
    switch (targetDir) {
      case 'Top':    pair(13, 17); break;
      case 'Bottom': pair(15, 19); break;
      case 'Right':  pair(14, 18); break;
      case 'Left':   pair(16, 20); break;
    }
  }
  playMovementHintChat(remaining) {
    const targetDir = this.itemManager.getCurrentTargetDirection();
    switch (targetDir) {
      case 'Top':    if (remaining === 1) this.chat.playChat(21, false); break;
      case 'Bottom': if (remaining === 1) this.chat.playChat(24, false); break;
      case 'Right':  if (remaining === 1) this.chat.playChat(23, false); else if (remaining === 2) this.chat.playChat(22, false); break;
      case 'Left':   if (remaining === 1) this.chat.playChat(26, false); else if (remaining === 2) this.chat.playChat(25, false); break;
    }
  }
  animateCurrentItemScale() {
    const item = this.itemManager.getCurrentItemObject();
    if (item && item._glow) {
      item._glow.style.display = '';
      item.classList.add('glowing');
      doScale(item, 1.15, 0.8, Ease.OutBack, () => {
        doScale(item, 1.0, 0.8, Ease.OutQuad, () => { item._glow.style.display = 'none'; item.classList.remove('glowing'); });
      });
    }
  }
}

/* =============================================================================
   6. SHIP CONTROLLER  (port of ShipController.cs — LBD 3, with BFS pathfinding)
============================================================================= */
class ShipController {
  constructor(ctx) {
    this.ctx = ctx;
    this.grid = ctx.grid;
    this.itemManager = ctx.itemManager;
    this.chat = ctx.chat;
    this.moveSpeed = 5;
    this.resetDelay = 3;
    this.idleTimeThreshold = 15;

    this.el = ctx.characterEl;
    const cfg = ctx.config;
    this.startOffset = cfg.startOffset;
    this.targetOffset = cfg.targetOffset;

    const centerCol = Math.floor(this.grid.columns / 2);
    const centerRow = Math.floor(this.grid.rows / 2);
    this.stonePositions = (cfg.obstacles || []).map(o => ({ x: centerCol + o.colOffset, y: centerRow + o.rowOffset }));
    this.currentCol = centerCol + this.startOffset.x;
    this.currentRow = centerRow + this.startOffset.y;
    this.startCol = this.currentCol; this.startRow = this.currentRow;
    this.absoluteTarget = { x: centerCol + this.targetOffset.x, y: centerRow + this.targetOffset.y };

    placeAt(this.el, this.grid.getCellPosition(this.currentCol, this.currentRow));
    this.isMoving = false; this.isWinMove = false;
    this.lastInteractionTime = now();
    this.incorrectCount = 0;

    this._drawObstaclesAndTarget();
    this._hideHints();
    this._idleLoop();
  }
  _drawObstaclesAndTarget() {
    const c = this.ctx;
    // Target island — skipped when it's already painted into the map image.
    if (!c.config.bakedIsland && c.config.island) {
      const isl = makeSprite(c.field, c.assetImg(c.config.island), 'island');
      placeAt(isl, this.grid.getCellPosition(this.absoluteTarget.x, this.absoluteTarget.y));
    }
    // Stones (obstacles) — drawn unless the map already has them painted in.
    if (!c.config.bakedRocks) {
      this.stonePositions.forEach(s => {
        const st = makeSprite(c.field, c.assetImg(c.config.obstacleSprite), 'obstacle');
        placeAt(st, this.grid.getCellPosition(s.x, s.y));
      });
    }
  }
  _dirArrowsHide() { if (this.ctx.dirArrows) for (const k in this.ctx.dirArrows) this.ctx.dirArrows[k].style.display = 'none'; }
  _hideHints() {
    const c = this.ctx;
    if (c.idleEl) c.idleEl.style.display = 'none';
    this._dirArrowsHide();
    if (c.incorrectEl) c.incorrectEl.style.display = 'none';
    if (c.tryAgainEl) c.tryAgainEl.style.display = 'none';
    if (c.handEl) c.handEl.style.display = 'none';
    if (c.arrowEl) c.arrowEl.style.display = 'none';
  }
  start() {
    this.resetIdleTimer();   // idle clock starts when gameplay begins, not at build time
    // Intro instruction, synced to the voice: the pause lands ON "ship" (the reveal is
    // paced to the audio), the ship glows + pulses TWICE with a sound; then on "island"
    // the treasure pulses TWICE with a sound. Buttons stay locked until "Tap the buttons".
    const cues = [
      { word: 'ship',   pause: 0.15, fn: (done) => this._emphasizeShip(done) },
      { word: 'island', pause: 0.15, fn: (done) => this._pulseTarget(done) },
    ];
    this.chat.playChatCued(0, cues, () => {
      // The moment "Tap the buttons to move the ship." appears, the buttons activate
      // AND pulse (with sound) — not after the line finishes.
      this.ctx.setButtonsEnabled(true);
      this._pulseButtons();
      this.chat.playChat(1, false, 0, 0, () => {
        delayedCall(1.5, () => this.resetIdleTimer());   // idle countdown starts after the pulse/line
      });
    });
  }
  // Gentle one-shot double-pulse of the four direction buttons, a sound per pulse.
  _pulseButtons() {
    const btns = this.ctx.dpadButtons && this.ctx.dpadButtons();
    if (!btns) return;
    for (const k in btns) { if (btns[k]) { btns[k].classList.remove('tap-pulse'); void btns[k].offsetWidth; btns[k].classList.add('tap-pulse'); } }
    if (this.ctx.audio) this.ctx.audio.playButtonClick();                 // sound on pulse 1
    delayedCall(0.65, () => { if (this.ctx.audio) this.ctx.audio.playButtonClick(); });   // sound on pulse 2
    delayedCall(1.4, () => { for (const k in btns) btns[k] && btns[k].classList.remove('tap-pulse'); });
  }
  // Two pulses, each kicked off with a sound; `cb` fires when both finish.
  _pulseTwice(el, cb) {
    if (!el || el.style.display === 'none') { if (cb) cb(); return; }
    const base = (initTransform(el).scale) || 1;
    const onePulse = (done) => {
      // No SFX here — the pulse alone is the emphasis; a chime overlapped/ducked the VO.
      doScale(el, base * 1.24, 0.42, Ease.InOutSine, () =>    // gentle, unhurried swell
        doScale(el, base, 0.40, Ease.InOutSine, done));
    };
    onePulse(() => onePulse(cb));
  }
  _emphasizeShip(cb) {
    this.ctx.showCharGlow(true);               // green halo behind the ship on the word "ship"
    this._pulseTwice(this.el, () => { this.ctx.showCharGlow(false); if (cb) cb(); });
  }
  _pulseTarget(cb) {
    // The island's treasure is a real sprite on the target cell (the island itself is
    // painted into the map), so pulse the treasure chest twice with a sound.
    const treasure = this.itemManager && this.itemManager.getCurrentItemObject();
    this._pulseTwice(treasure, cb);
  }
  onNewItem() { this.resetIdleTimer(); }

  _idleLoop() {
    const loop = () => {
      const idle = (now() - this.lastInteractionTime) > this.idleTimeThreshold;
      // Input-locked = mid-move / recovery / collect / tutorial / win. The idle clock
      // keeps running through those (blocked presses never refresh lastInteractionTime),
      // but the breathe is suppressed until input is free again.
      const locked = this.isMoving || (this.ctx.buttonsEnabled && this.ctx.buttonsEnabled() === false);
      if (idle && !locked) this._startIdleBreathe(); else this._stopIdleBreathe();
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }
  _startIdleBreathe() {
    if (this._idleBreathing) return;
    this._idleBreathing = true;
    const btns = this.ctx.dpadButtons && this.ctx.dpadButtons();
    if (btns) for (const k in btns) btns[k] && btns[k].classList.add('idle-breathe');
  }
  _stopIdleBreathe() {
    if (!this._idleBreathing) return;
    this._idleBreathing = false;
    const btns = this.ctx.dpadButtons && this.ctx.dpadButtons();
    if (btns) for (const k in btns) btns[k] && btns[k].classList.remove('idle-breathe');
  }
  resetIdleTimer() {
    this.lastInteractionTime = now();
    this._hintOn = false;
    this._stopIdleBreathe();                              // any press stops the idle breathe
    if (this.ctx.idleEl) this.ctx.idleEl.style.display = 'none';
    this._dirArrowsHide();
    if (this.ctx.handEl) this.ctx.handEl.style.display = 'none';   // streak resets only on a correct move
    this.ctx.showCharGlow(false);
  }
  moveUp()    { this.handleMove(0, 1); }
  moveDown()  { this.handleMove(0, -1); }
  moveLeft()  { this.handleMove(-1, 0); }
  moveRight() { this.handleMove(1, 0); }

  handleMove(colDelta, rowDelta) {
    if (this.isMoving) return;
    this.resetIdleTimer();
    const nextCol = this.currentCol + colDelta;
    const nextRow = this.currentRow + rowDelta;
    const outOfBounds = (nextCol < 0 || nextCol >= this.grid.columns || nextRow < 0 || nextRow >= this.grid.rows);
    // Any blocked move (edge OR rock) => same wrong flow: red box + Try Again sign + retry.
    if (outOfBounds || this.isObstacle(nextCol, nextRow)) {
      this.incorrectCount++;
      doShake(this.el, 0.2, outOfBounds ? 10 : 15);
      this._triggerMistake();                // "Wrong direction" text+VO -> "Try again" VO + wooden sign -> "Tap the buttons"
      return;
    }
    this.incorrectCount = 0;                  // a correct move breaks the consecutive-wrong streak
    this._stopWrongVO();                      // silence any lingering "wrong / try again" VO
    this.ctx.showCharGlow(false);
    this.currentCol = nextCol; this.currentRow = nextRow;
    const targetPos = this.grid.getCellPosition(this.currentCol, this.currentRow);
    this.isWinMove = (this.currentCol === this.absoluteTarget.x && this.currentRow === this.absoluteTarget.y);
    this._moveTo(targetPos, this.isWinMove);
  }
  // Wrong attempt: play "Oh no, wrong direction. Try again." as VO ONLY (non-blocking),
  // keep the on-screen text as the repeating instruction "Tap the buttons to move the
  // ship." (NOT spoken), and let the player move again immediately (only a brief lock
  // for the shake). Escalating help by consecutive-wrong streak.
  _triggerMistake() {
    const c = this.ctx;
    this.isMoving = true;                                     // brief lock, just for the shake
    if (c.incorrectEl) {                                      // wrong-cell marker on the ship's cell
      const ct = initTransform(this.el), it = initTransform(c.incorrectEl);
      it.x = ct.x; it.y = ct.y; applyTransform(c.incorrectEl); c.incorrectEl.style.display = '';
    }
    this._playWrongVO();                                      // VO only: "Oh no wrong direction. Try again."
    this.chat.showText('Tap the buttons to move the ship.');  // text only — repeating instruction, no VO
    // Escalating help: 1st wrong = instruction only; 2nd = + goal-ward arrows; 3rd+ = + hand nudge.
    if (c.idleEl) c.idleEl.style.display = 'none';
    this._dirArrowsHide();
    if (c.handEl) c.handEl.style.display = 'none';
    if (this.incorrectCount >= 2) { this.ctx.showCharGlow(true); this.updateHint(); }
    if (this.incorrectCount >= 3) this._showHandOnCorrectButton();
    delayedCall(0.3, () => {                                  // unlock right after the shake -> play again
      if (c.incorrectEl) c.incorrectEl.style.display = 'none';
      this.isMoving = false;
    });
  }
  // "Oh no, wrong direction." then "Try again." — audio only, no on-screen text, and it
  // never blocks input. A new wrong attempt interrupts any still-playing wrong VO.
  _stopWrongVO() {
    if (this._wrongVoice) { try { this._wrongVoice.pause(); } catch (e) {} this._wrongVoice = null; }
  }
  _playWrongVO() {
    this._stopWrongVO();
    const repo = this.chat.repository || {};
    const url1 = repo[2] && repo[2].audio, url2 = repo[3] && repo[3].audio;
    if (!url1) return;
    const muted = this.ctx.audio ? this.ctx.audio.isMuted : false;
    const play = (url, onEnd) => {
      const a = new Audio(); a.muted = muted; setMediaSrc(a, url);
      if (onEnd) a.addEventListener('ended', onEnd);
      a.play().catch(() => {});
      this._wrongVoice = a; return a;
    };
    play(url1, () => { if (url2) play(url2); });
  }
  // Hand nudge over the correct (goal-ward) direction button. buttonOrder for the
  // ship is [up, down, left, right] -> indices 0..3.
  _showHandOnCorrectButton() {
    const dir = (this.getProgressDirs() || [])[0];
    if (!dir || !this.ctx.handEl || !this.ctx.positionHandOverButton) return;
    const bi = { up: 0, down: 1, left: 2, right: 3 }[dir];
    if (bi === undefined) return;
    this.ctx.positionHandOverButton(bi);
    this.ctx.handEl.style.display = '';
  }
  isObstacle(col, row) { return this.stonePositions.some(s => s.x === col && s.y === row); }
  _moveTo(target, isWin) {
    this.isMoving = true;
    const dur = 1 / this.moveSpeed;
    doMove(this.el, target.x, target.y, dur, Ease.Linear, () => {
      this.isMoving = false;
      if (isWin) { this.chat.playChat(5, false); this.ctx.audio.playLossSound(); this._startWinSequence(); }
    });
  }
  _startWinSequence() {
    this.ctx.setButtonsEnabled(false);
    chain([ (next) => delayedCall(1.0, next), (next) => { this.itemManager.collectItem(); } ]);
  }
  // Shortest-path distance from a cell to the target (steps), or null if blocked.
  _dist(cell) { const p = this.findPath(cell, this.absoluteTarget); return p ? p.length - 1 : null; }
  // Every neighbour that lies on a shortest path (i.e. gets one step closer).
  getProgressDirs() {
    const cur = { x: this.currentCol, y: this.currentRow };
    const dcur = this._dist(cur);
    if (dcur === null) return [];
    const dirs = { up: {x:0,y:1}, down: {x:0,y:-1}, left: {x:-1,y:0}, right: {x:1,y:0} };
    const out = [];
    for (const name in dirs) {
      const d = dirs[name], nx = cur.x + d.x, ny = cur.y + d.y;
      if (nx < 0 || nx >= this.grid.columns || ny < 0 || ny >= this.grid.rows) continue;
      if (this.isObstacle(nx, ny)) continue;
      if (this._dist({ x: nx, y: ny }) === dcur - 1) out.push(name);
    }
    return out;
  }
  // Every direction the ship can actually move into (in-bounds and not a rock).
  getValidMoveDirs() {
    const cur = { x: this.currentCol, y: this.currentRow };
    const dirs = { up: {x:0,y:1}, down: {x:0,y:-1}, left: {x:-1,y:0}, right: {x:1,y:0} };
    const out = [];
    for (const name in dirs) {
      const d = dirs[name], nx = cur.x + d.x, ny = cur.y + d.y;
      if (nx < 0 || nx >= this.grid.columns || ny < 0 || ny >= this.grid.rows) continue;
      if (this.isObstacle(nx, ny)) continue;
      out.push(name);
    }
    return out;
  }
  updateHint() {
    // Show arrows ONLY in the correct direction(s) that lead toward the goal.
    // If two directions both make progress, show both; else fall back to any open move.
    let valid = this.getProgressDirs();
    if (valid.length === 0) valid = this.getValidMoveDirs();
    const D = 105;
    const rot = { up: 0, down: 180, left: -90, right: 90 };
    const off = { up: {x:0,y:D}, down: {x:0,y:-D}, left: {x:-D,y:0}, right: {x:D,y:0} };
    const bi  = { up: 0, down: 1, left: 2, right: 3 };
    const ctf = initTransform(this.el);
    let firstBi = -1;
    ['up','down','left','right'].forEach(name => {
      const a = this.ctx.dirArrows && this.ctx.dirArrows[name];
      if (!a) return;
      if (valid.indexOf(name) >= 0) {
        const t = initTransform(a); t.x = ctf.x + off[name].x; t.y = ctf.y + off[name].y; t.rot = rot[name]; applyTransform(a);
        a.style.display = '';
        if (firstBi < 0) firstBi = bi[name];
      } else a.style.display = 'none';
    });
    if (this.ctx.handEl) this.ctx.handEl.style.display = 'none';   // ship: arrows only, no hand nudge
  }
  // BFS pathfinding — identical to ShipController.FindPath
  findPath(start, end) {
    const key = p => p.x + ',' + p.y;
    const queue = [start];
    const parent = {}; parent[key(start)] = start;
    const dirs = [{x:0,y:1},{x:0,y:-1},{x:-1,y:0},{x:1,y:0}];
    while (queue.length) {
      const cur = queue.shift();
      if (cur.x === end.x && cur.y === end.y) {
        const path = []; let t = end;
        while (!(t.x === start.x && t.y === start.y)) { path.push(t); t = parent[key(t)]; }
        path.push(start); path.reverse(); return path;
      }
      for (const d of dirs) {
        const nx = cur.x + d.x, ny = cur.y + d.y, n = { x: nx, y: ny };
        if (nx >= 0 && nx < this.grid.columns && ny >= 0 && ny < this.grid.rows) {
          if (!this.isObstacle(nx, ny) && !(key(n) in parent)) { parent[key(n)] = cur; queue.push(n); }
        }
      }
    }
    return null;
  }
  resetToStart() { this.resetToStartingPosition(); }
  resetToStartingPosition() {
    killTweensOn(this.el);
    const centerCol = Math.floor(this.grid.columns / 2), centerRow = Math.floor(this.grid.rows / 2);
    this.currentCol = centerCol + this.startOffset.x;
    this.currentRow = centerRow + this.startOffset.y;
    placeAt(this.el, this.grid.getCellPosition(this.currentCol, this.currentRow));
    this.isMoving = false;
    this.ctx.setButtonsEnabled(true);
    this.resetIdleTimer();
  }
}

/* =============================================================================
   7. PARTICLE BURST  (replacement for EpicVictoryEffects — Canvas 2D)
============================================================================= */
class Particles {
  constructor(canvas) { this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.parts = []; this._running = false; this._alpha = 1; }
  _resize() { this.canvas.width = this.canvas.clientWidth; this.canvas.height = this.canvas.clientHeight; }
  burst(color) {
    this._resize();
    this._alpha = 1;
    const cx = this.canvas.width / 2, cy = this.canvas.height / 2;
    this.parts = [];
    for (let i = 0; i < 90; i++) {
      const a = Math.random() * Math.PI * 2, sp = 60 + Math.random() * 260;
      this.parts.push({ x: cx, y: cy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, size: 3 + Math.random() * 6, color });
    }
    if (!this._running) { this._running = true; this._last = null; requestAnimationFrame(t => this._loop(t)); }
  }
  fade() { this._fading = true; }
  _loop(t) {
    if (this._last === null) this._last = t;
    const dt = Math.min((t - this._last) / 1000, 0.05); this._last = t;
    const c = this.ctx; c.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (this._fading) this._alpha = Math.max(0, this._alpha - dt * 2);
    for (const p of this.parts) {
      p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 240 * dt; p.life -= dt * 0.5;
      if (p.life > 0) {
        c.globalAlpha = Math.max(0, p.life) * this._alpha; c.fillStyle = p.color;
        c.beginPath(); c.arc(p.x, p.y, p.size, 0, Math.PI * 2); c.fill();
      }
    }
    c.globalAlpha = 1;
    if ((this.parts.some(p => p.life > 0) && this._alpha > 0)) requestAnimationFrame(tt => this._loop(tt));
    else { this._running = false; this._fading = false; c.clearRect(0, 0, this.canvas.width, this.canvas.height); }
  }
}

/* =============================================================================
   8. TUTORIAL MANAGER  (port of TutorialManager.cs)
============================================================================= */
class TutorialManager {
  constructor(ctx, onFinish) {
    this.ctx = ctx; this.onFinish = onFinish;
    this.directionalClips = ctx.config.tutorialClips || []; // 4 audio srcs (Up,Down,Right,Left)
  }
  start() {
    // 1. start chat
    this.ctx.chat.playChat(0, true, 0, 0, () => this._playZoom());
  }
  _playZoom() {
    const items = this.ctx.tutorialZoomItems || [];
    if (!items.length) { this._onStartChatComplete(); return; }
    let i = 0;
    const step = () => {
      if (i >= items.length) { this._onStartChatComplete(); return; }
      const it = items[i++];
      doScale(it, 1.5, 1, Ease.OutBack, () => {
        if (it._glow) it._glow.style.display = '';
        doScale(it, 1.0, 1, Ease.InBack, () => { delayedCall(1.5, step); });
      });
    };
    step();
  }
  _onStartChatComplete() {
    const g = this.ctx.guideScreenEl;
    if (g) { g.style.display = ''; doFade(g, 1, 0.5, () => this.ctx.chat.playChat(1, false, 0, 0, () => this._playDirectional())); }
    else this._playDirectional();
  }
  _playDirectional() {
    const inds = this.ctx.directionalIndicators || [];
    inds.forEach(o => o && (o.style.display = 'none'));
    let i = 0;
    const audio = new Audio();
    const step = () => {
      if (i >= this.directionalClips.length) { this._finish(); return; }
      const ind = inds[i], clipSrc = this.directionalClips[i];
      if (ind) ind.style.display = '';
      if (clipSrc) { audio.src = clipSrc; audio.muted = this.ctx.audio.isMuted; audio.play().catch(()=>{}); }
      const dur = 1.4;
      delayedCall(dur, () => { if (ind) ind.style.display = 'none'; i++; delayedCall(1.0, step); });
    };
    step();
  }
  _finish() { delayedCall(2.0, () => this.onFinish && this.onFinish()); }
}

/* =============================================================================
   9. UTIL
============================================================================= */
function now() { return performance.now() / 1000; }
// Sequential runner mirroring DOTween.Sequence callback chaining.
// Each step is a function that receives `next` and must call it to advance.
function chain(steps) {
  let i = 0;
  const next = () => { if (i < steps.length) { const s = steps[i++]; s(next); } };
  next();
}

/* =============================================================================
   ASSET PRELOADER  (byte-accurate loading bar; audio served from blob: URLs)
   - Streams every asset with a Reader so progress is real bytes, not file count.
   - Weights each file by its true on-disk size (window.ASSET_MANIFEST), refined
     by Content-Length. Bar is monotonic. Concurrency-limited, smallest-first.
   - Failure-safe: any failed / stalled / aborted fetch (or file:// where fetch
     is blocked) still counts as fully "done" so the bar can never stall.
   Browser support for the Ogg/Opus + WebP assets: Chrome/Edge/Firefox + Safari 15+.
============================================================================= */
window.__ASSET_BLOBS = window.__ASSET_BLOBS || {};
// Resolve an asset URL to its local blob: URL once preloaded (else the original).
function assetSrc(url) { return (url && window.__ASSET_BLOBS[url]) || url; }
// Point a media element at an asset, arming a one-time revert-to-original fallback
// if the blob URL ever fails to decode (task: blob elements need an error path).
function setMediaSrc(el, rawUrl) {
  if (!el || !rawUrl) return;
  const resolved = assetSrc(rawUrl);
  if (resolved !== rawUrl && !el._blobFallbackArmed) {
    el._blobFallbackArmed = true;
    el.addEventListener('error', () => {
      if ((el.src || '').startsWith('blob:')) {           // blob went bad -> original file, resume
        el.src = rawUrl;
        const p = el.play && el.play(); if (p && p.catch) p.catch(() => {});
      }
    });
  }
  el.src = resolved;
}

class Preloader {
  constructor(manifest) {
    this.items = (manifest || []).slice().sort((a, b) => (a.bytes || 1) - (b.bytes || 1)); // smallest-first
    this.totalBytes = this.items.reduce((s, i) => s + (i.bytes || 1), 0) || 1;
    this.loaded = 0;
    this._monoPct = 0;          // enforce a monotonic bar
    this.concurrency = 5;
    this.perFileTimeoutMs = 20000;
    this._cb = null;
  }
  onProgress(cb) { this._cb = cb; return this; }
  _emit() {
    let pct = Math.min(100, Math.floor((this.loaded / this.totalBytes) * 100));
    if (pct < this._monoPct) pct = this._monoPct; else this._monoPct = pct;
    if (this._cb) this._cb(pct);
  }
  async _fetchOne(item) {
    const declared = item.bytes || 1;
    let counted = 0;
    const bump = (n) => { counted += n; this.loaded += n; this._emit(); };
    let ctrl = null, timer = null;
    try {
      ctrl = new AbortController();
      timer = setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, this.perFileTimeoutMs);
      const res = await fetch(item.url, { signal: ctrl.signal, cache: 'force-cache' });
      if (!res.ok) throw new Error('status ' + res.status);
      const cl = parseInt(res.headers.get('Content-Length') || '0', 10);
      const realTotal = cl > 0 ? cl : declared;
      if (res.body && res.body.getReader) {
        const reader = res.body.getReader();
        const chunks = [];
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          bump((value.length / realTotal) * declared);   // progress weighted by size table
        }
        window.__ASSET_BLOBS[item.url] = URL.createObjectURL(new Blob(chunks));
      } else {                                            // no streaming support: still cache-warm
        const blob = await res.blob();
        window.__ASSET_BLOBS[item.url] = URL.createObjectURL(blob);
      }
    } catch (e) {
      /* failure-safe: swallow — the element keeps its original src */
    } finally {
      if (timer) clearTimeout(timer);
      if (counted < declared) bump(declared - counted);   // always finalize to full weight
    }
  }
  async run() {
    const q = this.items.slice();                          // already smallest-first
    const worker = async () => { while (q.length) await this._fetchOne(q.shift()); };
    const n = Math.max(1, Math.min(this.concurrency, q.length || 1));
    await Promise.all(Array.from({ length: n }, worker));
    this._monoPct = 100; if (this._cb) this._cb(100);
  }
}

/* expose engine to Level module (next section) */
window.__ENGINE__ = {
  Ease, Tween, Sequence, delayedCall, doMove, doScale, doRotate, doFade, doShake, killTweensOn,
  Grid, AudioManager, ChatManager, ItemManager, PlayerController, ShipController, Particles,
  TutorialManager, makeSprite, placeAt, initTransform, applyTransform, now,
  Preloader, assetSrc, setMediaSrc,
};

})();


/* =============================================================================
   PART 2 — LEVEL CONFIG, LEVEL ORCHESTRATOR & BOOTSTRAP
   ---------------------------------------------------------------------------
   Data-driven config per Unity scene (Game_1 / Game_2 / Game_3).
   Image/audio filenames are the originals, copied verbatim into /assets.
   Layout rects are transcribed from the Unity RectTransforms and converted to
   a 1920x1080 design surface (Unity CanvasScaler: ScaleWithScreenSize, Expand).
============================================================================= */
(function () {
"use strict";
const E = window.__ENGINE__;

const IMG = (lvl, name) => `assets/images/${lvl}/${encodeURIComponent(name)}`;
const AUD = (lvl, name) => `assets/audio/${lvl}/${encodeURIComponent(name)}`;
const COMMON = (name) => `assets/images/common/${encodeURIComponent(name)}`;

/* ---- reconstructed chat repositories (index -> {text, audio}) ------------- */
function repoLBD3() {
  const a = n => AUD('lbd3', n);
  return {
    0:{text:"Let us guide the ship to the island.", audio:a("Let us guide the ship to the island.ogg")},
    1:{text:"Tap the buttons to move the ship.",    audio:a("Tap the buttons to move the ship.ogg")},
    2:{text:"Wrong direction.",                     audio:a("Oh no Wrong direction.ogg")},
    3:{text:"Try again.",                           audio:a("Try again.ogg")},
    4:{text:"Tap the buttons to move the ship.",    audio:a("Tap buttons to move the ship.ogg")},
    5:{text:"Hooray! You reached the island.",      audio:a("Hooray You reached the island.ogg")},
    40:{text:"Hurry ! We did it.",                  audio:a("Hooray We did it.ogg")},
  };
}

const GOLD = 'rgba(255,184,0,0.85)';

/* ---- per-level configuration (with exact 1920x1080 layout rects) ---------- */
const LEVELS = {
  lbd3: {
    id:'lbd3', title:'Guide the Ship to the Island', type:'ship',
    grid:{cols:7, rows:5}, hasTutorial:false, zoomScale:4, collectionOffsetX:250,
    bakedIsland:true, bakedRocks:true,   // island + rocks painted into MAP Background Group.webp
    drawGrid:true,                        // that map has no grid, so we draw the 7x5 grid (full, edge-to-edge)
    startOffset:{x:3, y:-2}, targetOffset:{x:0, y:2},
    obstacles:[
      {colOffset:0, rowOffset:0}, {colOffset:2, rowOffset:-1}, {colOffset:2, rowOffset:1},
      {colOffset:-1,rowOffset:-1},{colOffset:-3,rowOffset:0}, {colOffset:-2,rowOffset:1},
      {colOffset:3, rowOffset:2}, {colOffset:-1,rowOffset:2}, {colOffset:1, rowOffset:2},
    ],
    img:{
      bg:IMG('lbd3','Blue water image  bg  LBD3.webp'),
      base:IMG('lbd3','MAP Background Group.webp'),   // parchment + ocean + island + rocks + right panel
      character:COMMON('ship.webp'),
      chatbox:COMMON('chatbox.webp'),
      splash:IMG('lbd3','Game Start Page.webp'),
      goButton:COMMON('Play button.svg'),
      compass:COMMON('compass-g3.webp'),
      island:IMG('lbd3','Top Island image 1.webp'),
      obstacle:IMG('lbd3','Rock obstacles.webp'),
      btnUp:COMMON('btn-up.webp'), btnDown:COMMON('btn-down.webp'),
      btnLeft:COMMON('btn-left.webp'), btnRight:COMMON('btn-right.webp'),
    },
    layout:{
      base:{l:68,t:135,w:1784,h:913},
      field:{l:190,t:197,w:1045,h:747},   // left edge back out 10px (right kept fixed at 1235)
      chat:{l:93,t:12,w:1734,h:178},
      compass:{l:1396,t:460,w:215,h:215},
      buttons:{ up:{l:1423,t:310,w:156,h:147}, down:{l:1436,t:683,w:149,h:138}, left:{l:1238,t:480,w:163,h:176}, right:{l:1611,t:492,w:157,h:152} },
    },
    items:[ {direction:'Top', colOffset:0, rowOffset:2, offsetX:0, offsetY:-16, color:GOLD,   // treasure nudged 16px down
             sprite:IMG('lbd3','Teasure image 1.webp'), w:150, h:118,
             collectBg:IMG('lbd3','Top Island image 1.webp') } ],  // collect screen: whole island + chest
    island:IMG('lbd3','Top Island image 1.webp'),
    obstacleSprite:IMG('lbd3','Rock obstacles.webp'),
    // Win screen composed from separate pieces over the ship-scene background.
    finalBg:IMG('lbd3','Last screen.webp'),
    finalLayers:[
      {sprite:IMG('lbd3','last screen boy.webp'),      l:10,   t:340, w:527, h:740},  // Aarav, bottom-left
      {sprite:IMG('lbd3','last screen treasure.webp'), l:480,  t:857, w:400, h:208},  // treasure, bottom-centre
      {sprite:IMG('lbd3','crab.webp'),                 l:1360, t:815, w:560, h:256},  // crab chef, bottom-right
    ],
    repo:repoLBD3(),
  },
};

/* =============================================================================
   LEVEL — builds the 1920x1080 stage for one scene and wires the controllers.
============================================================================= */
const STAGE_W = 1920, STAGE_H = 1080;

class Level {
  constructor(cfg, root, shared) {
    this.config = cfg;
    this.root = root;
    this.audio = shared.audio;
    this.onExit = shared.onExit;
    this._buttonsEnabled = true;
    this._build();
  }
  assetImg(name) { return name; }

  _abs(el, r) { el.style.left = r.l + 'px'; el.style.top = r.t + 'px'; el.style.width = r.w + 'px'; el.style.height = r.h + 'px'; }

  _build() {
    const cfg = this.config, L = cfg.layout;
    this.root.innerHTML = '';
    this.root.className = 'level level-' + cfg.id;

    // ----- outer bg (fills viewport) -----
    const bg = document.createElement('div');
    bg.className = 'bg';
    bg.style.backgroundImage = `url("${cfg.img.bg}")`;
    this.root.appendChild(bg);

    // ----- 1920x1080 stage (scaled to fit) -----
    const stage = document.createElement('div');
    stage.className = 'stage';
    stage.style.width = STAGE_W + 'px';
    stage.style.height = STAGE_H + 'px';
    this.root.appendChild(stage);
    this.stage = stage;
    this._fit();
    this._resizeHandler = () => this._fit();
    window.addEventListener('resize', this._resizeHandler);

    // ----- base map image -----
    const base = document.createElement('div');
    base.className = 'base-map';
    base.style.backgroundImage = `url("${cfg.img.base}")`;
    this._abs(base, L.base);
    stage.appendChild(base);

    // ----- play field (grid) -----
    const field = document.createElement('div');
    field.className = 'play-field';
    this._abs(field, L.field);
    // Optional field background image (e.g. LBD3's baked grid+island map).
    if (cfg.img.fieldImg) { field.style.backgroundImage = `url("${cfg.img.fieldImg}")`; field.style.backgroundSize = '100% 100%'; field.style.backgroundRepeat = 'no-repeat'; }
    stage.appendChild(field);
    this.field = field;
    this.grid = new E.Grid(field, cfg.grid.cols, cfg.grid.rows);
    // Draw our own grid only when neither the base map nor the field image has one baked in.
    if (cfg.drawGrid) this._drawGridLines();

    // ----- particles canvas over field -----
    const canvas = document.createElement('canvas');
    canvas.className = 'particles';
    this._abs(canvas, L.field);
    stage.appendChild(canvas);
    this.particles = new E.Particles(canvas);

    // ----- character / ship (with a glow shown during the idle hint) -----
    this.charGlowEl = E.makeSprite(field, null, 'char-glow');   // CSS radial glow (Glow.webp is actually binoculars art)
    this.charGlowEl.style.display = 'none';
    this.characterEl = E.makeSprite(field, cfg.img.character, 'character');
    if (cfg.type === 'ship') { E.initTransform(this.characterEl).flipX = true; E.applyTransform(this.characterEl); }  // ship faces right

    // ----- idle hint arrow: the provided "Arrow direction.svg" (5 chevrons),
    //        inlined so each chevron can light up one-by-one (marching). -----
    const CHEVRON_SVG =
      '<svg viewBox="0 0 38 182" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg" fill="none">' +
      '<path d="M3.00121 177.936L19.204 158.1L34.9996 178.262" stroke="#F5FB30" stroke-width="6" stroke-linecap="round"/>' +
      '<path d="M3.00121 139.612L19.204 119.776L34.9996 139.937" stroke="#F5FB30" stroke-width="6" stroke-linecap="round"/>' +
      '<path d="M3.00121 101.287L19.204 81.4504L34.9996 101.612" stroke="#F5FB30" stroke-width="6" stroke-linecap="round"/>' +
      '<path d="M3.00121 62.9623L19.204 43.1262L34.9996 63.288" stroke="#F5FB30" stroke-width="6" stroke-linecap="round"/>' +
      '<path d="M3.00121 24.6381L19.204 4.80199L34.9996 24.9638" stroke="#F5FB30" stroke-width="6" stroke-linecap="round"/>' +
      '</svg>';
    const mkChevron = () => { const el = document.createElement('div'); el.className = 'sprite hint-arrow'; el.innerHTML = CHEVRON_SVG; field.appendChild(el); E.initTransform(el); el.style.display = 'none'; return el; };
    this.idleEl = mkChevron();
    // Ship shows chevrons on EVERY valid move direction at once (e.g. "Tap north or east").
    this.dirArrows = (cfg.type === 'ship') ? { up: mkChevron(), down: mkChevron(), left: mkChevron(), right: mkChevron() } : null;

    // Wrong-move marker: a red highlight over the cell the character landed on
    // (matches the original "Incorrect" child that tints the character's cell).
    this.incorrectEl = document.createElement('div');
    this.incorrectEl.className = 'cell-wrong';
    field.appendChild(this.incorrectEl);
    E.initTransform(this.incorrectEl);
    this.incorrectEl.style.display = 'none';

    // Try Again prompt screen removed per design — no wooden sign / dim overlay.
    this.tryAgainEl = null;

    this.handEl = document.createElement('div');
    this.handEl.className = 'hand-hint';
    this.handEl.style.backgroundImage = `url("assets/images/common/${encodeURIComponent('hand nudge.webp')}")`;
    stage.appendChild(this.handEl);
    this.handEl.style.display = 'none';

    // ShipController "aerrow": wooden arrow above the island — removed per design (no goal marker).
    this.arrowEl = null;

    // ----- chat box -----
    const chatWrap = document.createElement('div');
    chatWrap.className = 'chat-box';
    if (cfg.img.chatbox) chatWrap.style.backgroundImage = `url("${cfg.img.chatbox}")`;
    this._abs(chatWrap, L.chat);
    const chatText = document.createElement('div');
    chatText.className = 'chat-text';
    chatWrap.appendChild(chatText);
    stage.appendChild(chatWrap);
    this.chat = new E.ChatManager(chatText, this.audio);
    this.chat.setRepository(cfg.repo);

    // ----- compass background (behind D-pad, if any) -----
    if (L.compass && cfg.img.compass) {
      const comp = document.createElement('div');
      comp.className = 'compass-bg';
      comp.style.backgroundImage = `url("${cfg.img.compass}")`;
      this._abs(comp, L.compass);
      stage.appendChild(comp);
    }

    // ----- D-pad buttons (absolute) -----
    this._buildDpad(stage, L.buttons);

    // (No top bar / mute / hamburger in the original scenes — omitted.)

    // ----- managers / controller -----
    this.itemManager = new E.ItemManager(this._ctx());
    this._ctx().itemManager = this.itemManager;
    if (cfg.type === 'player') this.controller = new E.PlayerController(this._ctx());
    else                       this.controller = new E.ShipController(this._ctx());
    this._ctx().controller = this.controller;

    // buttonOrder matches each controller's movementButtons list order:
    //  PlayerController -> [Top, Left, Bottom, Right]; ShipController -> [Up, Down, Left, Right]
    this.buttonOrder = (cfg.type === 'player')
      ? [this.btn.up, this.btn.left, this.btn.down, this.btn.right]
      : [this.btn.up, this.btn.down, this.btn.left, this.btn.right];

    this._buildSplash();
    this._buildFinalScreen();
    this.showSplash();
  }

  _fit() {
    const s = Math.min(window.innerWidth / STAGE_W, window.innerHeight / STAGE_H);
    this.stage.style.transform = `translate(-50%, -50%) scale(${s})`;
  }

  _drawGridLines() {
    const g = this.grid, holder = document.createElement('div');
    holder.className = 'grid-lines';
    // Optional inset (px) so the drawn grid can be smaller than the play area
    // WITHOUT moving the ship/rocks/items (which use the full field for cells).
    const gi = this.config.gridInset || {};
    holder.style.left = (gi.l || 0) + 'px'; holder.style.top = (gi.t || 0) + 'px';
    holder.style.right = (gi.r || 0) + 'px'; holder.style.bottom = (gi.b || 0) + 'px';
    for (let i = 0; i <= g.columns; i++) { const v = document.createElement('div'); v.className = 'gl gl-v'; v.style.left = (i / g.columns * 100) + '%'; holder.appendChild(v); }
    for (let i = 0; i <= g.rows; i++)    { const h = document.createElement('div'); h.className = 'gl gl-h'; h.style.top = (i / g.rows * 100) + '%'; holder.appendChild(h); }
    this.field.appendChild(holder);
  }

  _buildDpad(stage, B) {
    const cfg = this.config;
    const mk = (dir, img, rect, label) => {
      const b = document.createElement('button');
      b.className = 'dbtn dbtn-' + dir;
      if (img) b.style.backgroundImage = `url("${img}")`;
      b.setAttribute('aria-label', label); b.dataset.dir = dir;
      this._abs(b, rect);
      stage.appendChild(b);
      return b;
    };
    this.btn = {
      up:    mk('up',    cfg.img.btnUp,    B.up,    'Up'),
      down:  mk('down',  cfg.img.btnDown,  B.down,  'Down'),
      left:  mk('left',  cfg.img.btnLeft,  B.left,  'Left'),
      right: mk('right', cfg.img.btnRight, B.right, 'Right'),
    };
    const press = (dir) => {
      if (!this._buttonsEnabled) return;
      this.audio.playButtonClick();
      const c = this.controller;
      if (dir==='up') c.moveUp(); else if (dir==='down') c.moveDown(); else if (dir==='left') c.moveLeft(); else if (dir==='right') c.moveRight();
    };
    Object.entries(this.btn).forEach(([dir, b]) => b.addEventListener('click', () => press(dir)));
    this._keyHandler = (e) => {
      const map = { ArrowUp:'up', ArrowDown:'down', ArrowLeft:'left', ArrowRight:'right', w:'up', s:'down', a:'left', d:'right', W:'up', S:'down', A:'left', D:'right' };
      const dir = map[e.key];
      if (dir) { e.preventDefault(); press(dir); }
    };
    window.addEventListener('keydown', this._keyHandler);
  }

  _ctx() {
    if (this._ctxObj) return this._ctxObj;
    const self = this;
    this._ctxObj = {
      config: this.config, grid: this.grid, field: this.field, chat: this.chat,
      audio: this.audio, particles: this.particles,
      characterEl: this.characterEl, idleEl: this.idleEl, incorrectEl: this.incorrectEl,
      tryAgainEl: this.tryAgainEl, handEl: this.handEl, arrowEl: this.arrowEl, dirArrows: this.dirArrows,
      assetImg: (n) => n, controller: null, itemManager: null,
      dpadButtons: () => self.btn,                       // the four direction buttons (idle breathe)
      buttonsEnabled: () => self._buttonsEnabled,        // input-lock state (collect/tutorial/win)
      setButtonsEnabled: (on) => { self._buttonsEnabled = on; self.stage.classList.toggle('buttons-off', !on); },
      positionHandOverButton: (index) => {
        if (index < 0 || !self.buttonOrder || index >= self.buttonOrder.length) return;
        const b = self.buttonOrder[index]; if (!b) return;
        self.handEl.style.left = (b.offsetLeft + b.offsetWidth / 2) + 'px';
        self.handEl.style.top  = (b.offsetTop - 6) + 'px';
      },
      showFinalScreen: () => self.showFinalScreen(),
      playCollection: (itemData, onDone) => self.playCollection(itemData, onDone),
      showCharGlow: (on) => {
        if (!self.charGlowEl) return;
        if (on) {
          const ct = E.initTransform(self.characterEl), gt = E.initTransform(self.charGlowEl);
          gt.x = ct.x; gt.y = ct.y; E.applyTransform(self.charGlowEl);
          self.charGlowEl.style.display = '';
        } else self.charGlowEl.style.display = 'none';
      },
    };
    return this._ctxObj;
  }

  // Full-screen collection "zoom" presentation (the "Gem found!" screen):
  // dim backdrop + tinted radiating ray-burst + sparkles + soft glow, with the
  // collected item enlarged in the centre (elastic pop). Faithful to the Unity
  // AnimateCollectionDOTween ordering; the ray/sparkle art replaces the Unity
  // particle system.
  playCollection(itemData, onDone) {
    if (this.controller.resetToStart) this.controller.resetToStart();  // reset as zoom begins
    const COMMON = (n) => `assets/images/common/${encodeURIComponent(n)}`;

    const ov = document.createElement('div'); ov.className = 'collect-overlay'; ov.style.opacity = 0;
    // Full-screen blur.webp is the dim backdrop (bottom layer), then rays, sparkles, item.
    const glow = document.createElement('div'); glow.className = 'collect-glow';
    glow.style.backgroundImage = `url("${COMMON('blur.webp')}")`; ov.appendChild(glow);
    const rays = document.createElement('div'); rays.className = 'collect-rays';
    rays.style.setProperty('--ray', itemData.color || '#ffd34d'); ov.appendChild(rays);
    const spark = document.createElement('div'); spark.className = 'collect-spark';
    for (let i = 0; i < 11; i++) {
      const s = document.createElement('div'); s.className = 'spk';
      s.style.backgroundImage = `url("${COMMON('sparkle.webp')}")`;
      s.style.left = (12 + Math.random() * 76) + '%';
      s.style.top = (14 + Math.random() * 70) + '%';
      s.style.animationDelay = (Math.random() * 1.1) + 's';
      const sz = 16 + Math.random() * 30; s.style.width = sz + 'px'; s.style.height = sz + 'px';
      spark.appendChild(s);
    }
    ov.appendChild(spark);
    const item = document.createElement('div'); item.className = 'collect-item';
    // If a collectBg is given (LBD3 island), show it big with the item (chest) on top.
    item.style.backgroundImage = `url("${itemData.collectBg || itemData.sprite}")`;
    if (itemData.collectBg) {
      const fg = document.createElement('div'); fg.className = 'collect-item-fg';
      fg.style.backgroundImage = `url("${itemData.sprite}")`;
      item.appendChild(fg);
    }
    ov.appendChild(item);
    this.stage.appendChild(ov);

    const itf = E.initTransform(item); itf.baseCenter = true; itf.scale = 0.55; E.applyTransform(item);
    E.doFade(ov, 1, 0.35, () => {
      E.doScale(item, 1, 0.8, E.Ease.OutElastic, () => {   // grows from ~half to full (never tiny)
        E.delayedCall(1.3, () => {
          E.doFade(ov, 0, 0.4, () => { if (ov.parentNode) this.stage.removeChild(ov); if (onDone) onDone(); });
        });
      });
    });
  }

  // ----- splash -----
  showSplash() { /* built in _buildSplash; splash shown by default */ }
  _buildSplash() {
    const cfg = this.config;
    const s = document.createElement('div');
    s.className = 'overlay splash';
    s.style.backgroundImage = `url("${cfg.img.splash}")`;

    // Start button — hidden until every asset is fetched (revealed with a pop-in).
    const go = document.createElement('button');
    go.className = 'go-btn';
    go.style.display = 'none';
    if (cfg.img.goButton) go.style.backgroundImage = `url("${cfg.img.goButton}")`; else go.textContent = "Let's Go!";
    s.appendChild(go);

    // Themed loading bar occupying the start button's spot until 100% loaded.
    const load = document.createElement('div');
    load.className = 'load-wrap';
    const track = document.createElement('div'); track.className = 'load-track';
    const fill = document.createElement('div');  fill.className = 'load-fill';
    const pct  = document.createElement('div');   pct.className = 'load-pct'; pct.textContent = 'Loading… 0%';
    track.appendChild(fill); load.appendChild(track); load.appendChild(pct);
    s.appendChild(load);

    this.stage.appendChild(s);
    this.splashEl = s;
    this.goBtn = go; this.loadWrap = load; this.loadFill = fill; this.loadPct = pct;
    this._assetsReady = false;

    go.onclick = () => this.onGoClicked();
  }
  setLoadProgress(pct) {
    pct = Math.max(0, Math.min(100, pct | 0));
    if (this.loadFill) this.loadFill.style.width = pct + '%';
    if (this.loadPct)  this.loadPct.textContent = 'Loading… ' + pct + '%';
  }
  onAssetsReady() {
    if (this._assetsReady) return;
    this._assetsReady = true;
    if (this.loadWrap) this.loadWrap.style.display = 'none';
    const go = this.goBtn;
    if (!go) return;
    go.style.display = '';
    go.classList.add('is-ready');
    E.delayedCall(0.5, () => {                  // wait out the pop-in: both use `transform`
      go.classList.remove('is-ready');
      const gtf = E.initTransform(go);
      gtf.baseCenter = false;
      gtf.scale = 0.9;
      E.applyTransform(go);
      this._goPulse = E.doScale(go, 1.0, 1.0, E.Ease.InOutSine).setLoops(-1, 'yoyo');
    });
  }
  onGoClicked() {
    if (!this._assetsReady) return;   // guard: keyboard/programmatic starts wait for assets too
    if (this._goPulse) { this._goPulse.kill(); this._goPulse = null; }
    this.audio.playButtonClick();
    this.audio.playBackgroundMusic();
    // "Wave wash" transition: water rises over the splash, and once it fully covers the
    // screen we swap to the game underneath, then the water sweeps up to reveal it.
    this._playWaveTransition(() => {
      this.splashEl.style.display = 'none';
      if (this.config.hasTutorial) this.startTutorial(); else this.startGameplay();
    });
  }
  _playWaveTransition(onCovered) {
    const wrap = document.createElement('div'); wrap.className = 'wave-transition';
    const water = document.createElement('div'); water.className = 'wave-water';
    wrap.appendChild(water);
    this.stage.appendChild(wrap);
    void water.offsetWidth;                                  // flush initial transform before animating
    water.style.animation = 'wave-cover 0.6s cubic-bezier(.45,0,.2,1) forwards';
    E.delayedCall(0.6, () => {
      if (onCovered) onCovered();                            // fully covered -> swap splash → game
      water.style.animation = 'wave-exit 0.75s cubic-bezier(.6,0,.35,1) forwards';
      E.delayedCall(0.85, () => { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); });
    });
  }

  // Faithful port of TutorialManager: show the full-screen guide (parchment +
  // direction buttons / compass), then highlight each direction in sequence
  // (grey -> gold overlay) with its "This is <dir>" voice-over, then play.
  startTutorial() {
    const T = this.config.tutorial;
    if (!T) { this.startGameplay(); return; }
    this._tutorialActive = true;
    this.setButtonsEnabledPublic(false);   // buttons disabled (grayed) for the WHOLE tutorial
    // No skipping: buttons only become active after the tutorial completes.
    // Phase A: frame diagram (all items on the map + "Let us collect the
    // objects" + zoom each). Phase B: guide screen (buttons/compass + demo).
    this._tutorialFrameDiagram(() => { if (this._tutorialActive) this._tutorialGuideScreen(T); });
  }
  _tutorialFrameDiagram(done) {
    const items = this.itemManager._elements.slice();
    items.forEach(el => el.style.display = '');
    this.chat.playChat(0, true, 0, 0, () => {
      let i = 0;
      const step = () => {
        if (i >= items.length) {
          E.delayedCall(0.5, () => {
            items.forEach(el => { el.style.display = 'none'; const tf = E.initTransform(el); tf.scale = 1; E.applyTransform(el); });
            done();
          });
          return;
        }
        const el = items[i++];
        if (el._glow) el._glow.style.display = '';
        el.classList.add('glowing');
        E.doScale(el, 1.5, 0.7, E.Ease.OutBack, () => {
          E.doScale(el, 1.0, 0.7, E.Ease.InBack, () => { if (el._glow) el._glow.style.display = 'none'; el.classList.remove('glowing'); E.delayedCall(0.35, step); });
        });
      };
      step();
    });
  }
  _tutorialGuideScreen(T) {
    const guide = document.createElement('div');
    guide.className = 'overlay guide-screen';
    guide.style.backgroundImage = `url("${T.guide}")`;
    guide.style.opacity = 0;

    const hl = {};
    ['up', 'down', 'left', 'right'].forEach(d => {
      const c = document.createElement('div');
      c.className = 'guide-hl guide-hl-' + d;
      c.style.backgroundImage = `url("${T.hl[d]}")`;
      this._abs(c, T.pos[d]);
      c.style.display = 'none';
      guide.appendChild(c);
      hl[d] = c;
    });
    this.stage.appendChild(guide);
    this._guideEl = guide;

    E.doFade(guide, 1, 0.5, () => {
      if (!this._tutorialActive) return;
      this.chat.playChat(1, false, 0, 0, () => {
        if (!this._tutorialActive) return;
        this._runGuideSequence(hl, () => {
          if (!this._tutorialActive) return;
          E.doFade(guide, 0, 0.5, () => this.startGameplay());
        });
      });
    });
  }
  _runGuideSequence(hl, done) {
    const order = ['up', 'down', 'right', 'left'];   // matches tutorialClips order
    const clips = this.config.tutorialClips || [];
    const audio = new Audio();
    const N = E.now;
    let i = 0;
    const step = () => {
      if (i >= order.length) { done(); return; }
      const d = order[i], clip = clips[i];
      hl[d].style.display = '';
      const started = N();
      if (clip) { audio.pause(); audio.src = clip; audio.muted = this.audio.isMuted; audio.play().catch(() => {}); }
      const advance = () => { hl[d].style.display = 'none'; i++; E.delayedCall(0.45, step); };
      // Wait until this clip finishes (so "This is North" isn't cut off), but keep
      // each highlight on screen at least 1s, and cap the wait as a safety net.
      const wait = () => {
        const cap = (clip && isFinite(audio.duration) && audio.duration > 0) ? audio.duration + 0.5 : 5;
        const playing = clip && !audio.paused && !audio.ended;
        if ((playing && (N() - started) < cap) || (N() - started) < 1.0) { requestAnimationFrame(wait); return; }
        advance();
      };
      requestAnimationFrame(wait);
    };
    step();
  }

  startGameplay() {
    if (this._gameplayStarted) return;   // guard against tutorial callbacks + skip both firing
    this._gameplayStarted = true;

    // tear down any tutorial state (skip or natural end)
    this._tutorialActive = false;
    if (this._skipHandler) { this.stage.removeEventListener('click', this._skipHandler); this._skipHandler = null; }
    this.chat.stopAllActiveChat(true);
    if (this._guideEl && this._guideEl.parentNode) { this.stage.removeChild(this._guideEl); this._guideEl = null; }
    // hide any tutorial-shown items (gameplay re-activates the current one)
    this.itemManager._elements.forEach(el => { el.style.display = 'none'; const t = E.initTransform(el); t.scale = 1; E.applyTransform(el); });

    this.stage.classList.add('playing');
    this.setButtonsEnabledPublic(false);   // locked during the intro line; unlocked when "Tap the buttons" shows
    this.itemManager.currentItemIndex = 0;
    this.itemManager.activateNextItem();
    if (this.controller.start) this.controller.start();
  }
  setButtonsEnabledPublic(on) { this._buttonsEnabled = on; this.stage.classList.toggle('buttons-off', !on); }

  // ----- final screen -----
  _buildFinalScreen() {
    const cfg = this.config;
    const f = document.createElement('div');
    f.className = 'overlay final-screen';
    if (cfg.finalBg) f.style.backgroundImage = `url("${cfg.finalBg}")`;        // scene background (composed win screen)
    else if (cfg.img.final) f.style.backgroundImage = `url("${cfg.img.final}")`;

    // Separate character/treasure pieces layered over the scene (LBD3).
    this.finalLayerEls = [];
    if (cfg.finalLayers) {
      cfg.finalLayers.forEach(ly => {
        const el = document.createElement('div'); el.className = 'final-layer';
        el.style.backgroundImage = `url("${ly.sprite}")`;
        this._abs(el, ly);
        f.appendChild(el);
        this.finalLayerEls.push(el);
      });
    }

    // Win banner ("Hurray! We did it.")
    if (cfg.winBanner) {
      const banner = document.createElement('div'); banner.className = 'win-banner';
      banner.style.backgroundImage = `url("${cfg.winBanner}")`;
      this._abs(banner, { l: 325, t: 80, w: 1270, h: 181 });
      f.appendChild(banner);
      this.winBannerEl = banner;
    }
    // Collected-item collage on the board (each pops in)
    this.collageEls = [];
    if (cfg.finalCollage) {
      cfg.finalCollage.forEach(it => {
        const card = document.createElement('div'); card.className = 'collage-item';
        card.style.backgroundImage = `url("${it.sprite}")`;
        this._abs(card, it);
        f.appendChild(card);
        this.collageEls.push(card);
      });
    }

    // (No Replay/Menu buttons on the final screen — removed per request.)

    f.style.display = 'none'; f.style.opacity = 0;
    this.stage.appendChild(f);
    this.finalEl = f;
  }
  showFinalScreen() {
    this.finalEl.style.display = '';
    this.particles.burst('#ffd34d');
    this.chat.playChatText('Hurry ! We did it.', false);
    this.audio.playWinSound();
    // banner + each collage item pop in (scale 0 -> 1), faithful to the DOTween
    // scale-in on the Unity FinalScreen children.
    if (this.winBannerEl) { const t = E.initTransform(this.winBannerEl); t.baseCenter = false; t.scale = 0; E.applyTransform(this.winBannerEl); }
    this.collageEls.forEach(el => { const t = E.initTransform(el); t.baseCenter = false; t.scale = 0; E.applyTransform(el); });
    // composed win-screen pieces (LBD3): start hidden, pop in one by one
    (this.finalLayerEls || []).forEach(el => { const t = E.initTransform(el); t.baseCenter = false; t.scale = 0; E.applyTransform(el); });
    E.doFade(this.finalEl, 1, this.config.hasTutorial ? 0.8 : 0.5, () => {
      if (this.winBannerEl) E.doScale(this.winBannerEl, 1, 0.6, E.Ease.OutBack);
      this.collageEls.forEach((el, i) => E.delayedCall(0.25 + i * 0.35, () => E.doScale(el, 1, 0.6, E.Ease.OutBack)));
      (this.finalLayerEls || []).forEach((el, i) => E.delayedCall(0.2 + i * 0.3, () => E.doScale(el, 1, 0.6, E.Ease.OutBack)));
    });
  }

  destroyAndExit() {
    window.removeEventListener('keydown', this._keyHandler);
    window.removeEventListener('resize', this._resizeHandler);
    this.chat.stopAllActiveChat(true);
    this.audio.stopBackgroundMusic();
    if (this.onExit) this.onExit();
  }
}

/* =============================================================================
   BOOTSTRAP — level-select menu + launcher
============================================================================= */
function boot() {
  const gameRoot = document.getElementById('game-root');
  const audio = new E.AudioManager();
  // Looping background music + dedicated SFX. Audio is Ogg/Opus
  // (Chrome/Edge/Firefox + Safari 15+/iOS 15+). PlayLossSound == the collect sound.
  const AC = (n) => `assets/audio/common/${encodeURIComponent(n)}`;
  audio.setClips({
    bg:   AC('background-music.ogg'),
    win:  AC('win.ogg'),        // prize screen
    loss: AC('collect.ogg'),    // collect
    click:AC('click.ogg'),      // ship movement / button tap
  });

  // Single-level deploy (window.LBD_LEVEL is set by index.html).
  const levelId = (window.LBD_LEVEL && LEVELS[window.LBD_LEVEL]) ? window.LBD_LEVEL : 'lbd3';
  gameRoot.style.display = '';
  const current = new Level(LEVELS[levelId], gameRoot, { audio, onExit: () => location.reload() });

  // Preload every asset behind the loading bar before revealing the start button.
  const manifest = window.ASSET_MANIFEST || [];
  const pre = new E.Preloader(manifest).onProgress((pct) => current.setLoadProgress(pct));
  const finish = () => current.onAssetsReady();
  // Watchdog: the button MUST become reachable even if preloading hangs/never resolves.
  const watchdog = setTimeout(finish, 30000);
  const done = () => { clearTimeout(watchdog); finish(); };
  if (manifest.length) pre.run().then(done).catch(done);
  else done();   // no manifest -> don't trap the user behind an empty bar
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

})();
