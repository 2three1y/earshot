// Earshot main app. Plain modules, no framework. Everything runs on this device.
import { docFromText, buildDoc, corsFriendlyUrl, splitSentences } from './text.js';
import { PassageIndex, extractSummary, topKeywords } from './search.js';
import { interpret } from './intents.js';
import { KOKORO_VOICES, SAMPLE_TEXT } from './data.js';

const $ = (id) => document.getElementById(id);
const BASE = new URL('../', import.meta.url).href;
const TEST = window.__EARSHOT_TEST__ || {};

// ---------------------------------------------------------------- settings
const SETTINGS_KEY = 'earshot-settings-v1';
const DOC_KEY = 'earshot-doc-v1';
const settings = Object.assign({
  engine: 'device', neuralVoice: 'af_heart', deviceVoice: '', speed: 1,
  shortcuts: true, announce: true, autostop: true, earcons: true, follow: true,
  stt: true, sttModel: 'onnx-community/whisper-tiny.en', tts: true, embed: false, llm: false,
}, readJSON(SETTINGS_KEY) || {});
function readJSON(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* private mode */ } }

// ---------------------------------------------------------------- announcer
// One polite live region. It never talks over Earshot's own voice: while Earshot is
// speaking, messages wait, and only the newest one is said when speech stops.
const announcer = {
  el: null, last: '', lastAt: 0, pending: null, timer: 0,
  say(msg, { important = false } = {}) {
    if (!msg) return;
    if (!settings.announce && !important) return;
    if (isSpeaking() && !important) { this.pending = msg; return; }
    if (msg === this.last && Date.now() - this.lastAt < 4000) return;
    this.last = msg; this.lastAt = Date.now();
    clearTimeout(this.timer);
    this.el.textContent = '';
    this.timer = setTimeout(() => { this.el.textContent = msg; }, 80);
  },
  flush() { if (this.pending) { const m = this.pending; this.pending = null; this.say(m); } },
};

// ---------------------------------------------------------------- audio helpers
let audioCtx = null;
function ctx() {
  if (!audioCtx) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) audioCtx = new AC(); }
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  return audioCtx;
}
function earcon(kind) {
  if (!settings.earcons) return;
  const c = ctx(); if (!c) return;
  const now = c.currentTime;
  const notes = { listen: [523.25, 783.99], stop: [783.99, 523.25], error: [330, 247], ready: [523.25, 659.25, 783.99] }[kind] || [600];
  notes.forEach((f, i) => {
    const o = c.createOscillator(); const g = c.createGain();
    o.type = 'sine'; o.frequency.value = f;
    const t = now + i * 0.11;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.18, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
    o.connect(g).connect(c.destination); o.start(t); o.stop(t + 0.12);
  });
}
function wavBlob(samples, rate) {
  const buf = new ArrayBuffer(44 + samples.length * 2); const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, samples.length * 2, true);
  let o = 44; for (let i = 0; i < samples.length; i++, o += 2) { const s = Math.max(-1, Math.min(1, samples[i])); v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
  return new Blob([buf], { type: 'audio/wav' });
}
const SILENT_WAV = URL.createObjectURL(wavBlob(new Float32Array(2400), 24000));
let audioUnlocked = false;
function unlockAudio() {
  // iOS only lets audio start inside a tap. Play a tiny silence now so later sentences can play.
  ctx();
  const a = $('audio');
  if (!audioUnlocked && a) {
    a.src = SILENT_WAV; const p = a.play(); if (p && p.then) p.then(() => { audioUnlocked = true; }).catch(() => {});
  }
  if ('speechSynthesis' in window && !unlockAudio.ss) {
    unlockAudio.ss = true;
    try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); } catch (e) { /* ignore */ }
  }
}

// ---------------------------------------------------------------- worker client
let worker = null, workerFlavor = null, reqId = 0;
const pending = new Map();
const loaded = { tts: false, stt: false, embed: false, llm: false };
let progressSink = null;
function startWorker(flavor) {
  if (worker && workerFlavor === flavor) return;
  if (worker) { worker.terminate(); for (const k in loaded) loaded[k] = false; }
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  workerFlavor = flavor;
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'progress') { if (progressSink) progressSink(m); return; }
    if (m.type === 'result') { const p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.error ? p.reject(new Error(m.error)) : p.resolve(m); }
  };
  worker.onerror = (e) => { for (const [, p] of pending) p.reject(new Error(e.message || 'The model worker stopped.')); pending.clear(); };
}
function call(type, payload = {}, transfer = []) {
  return new Promise((resolve, reject) => { const id = ++reqId; pending.set(id, { resolve, reject }); worker.postMessage({ type, id, ...payload }, transfer); });
}

// ---------------------------------------------------------------- the document
let doc = null, index = null, cursor = 0, lastAnswer = null;
function setDoc(newDoc, { announce = true, position = 0 } = {}) {
  if (!newDoc || !newDoc.sentences.length) { announcer.say('That text looks empty. Nothing was loaded.', { important: true }); return false; }
  reader.stop(true);
  doc = newDoc; index = null; lastAnswer = null; reader.atEnd = false; cursor = Math.min(position, doc.sentences.length - 1);
  renderDoc();
  persistDoc();
  updateNowTitle();
  showNowReading();
  if (announce) announcer.say('Loaded "' + doc.title + '". ' + doc.paragraphs.length + ' paragraphs, about ' + minutes(doc.words) + '. Press Read to start.', { important: true });
  return true;
}
function minutes(words) { const m = Math.max(1, Math.round(words / 160 / (settings.speed || 1))); return m + (m === 1 ? ' minute' : ' minutes'); }
function renderDoc() {
  const box = $('doc'); box.textContent = '';
  const frag = document.createDocumentFragment();
  doc.paragraphs.forEach((p, i) => {
    const el = document.createElement(p.kind === 'h' ? 'h' + Math.min(6, 2 + Math.max(1, p.level)) : 'p');
    el.id = 'para-' + i; el.tabIndex = -1; el.textContent = p.text;
    frag.appendChild(el);
  });
  box.appendChild(frag);
  $('doc-meta').textContent = '"' + doc.title + '": ' + doc.paragraphs.length + ' paragraphs, ' + doc.sentences.length + ' sentences, about ' + minutes(doc.words) + ' of listening.';
}
function persistDoc() {
  if (!doc) return;
  try { localStorage.setItem(DOC_KEY, JSON.stringify({ title: doc.title, blocks: doc.paragraphs.map((p) => ({ kind: p.kind, level: p.level, text: p.text })), cursor })); }
  catch (e) { /* too big for storage: fine */ }
}
let saveTimer = 0;
function savePosition() { clearTimeout(saveTimer); saveTimer = setTimeout(persistDoc, 800); }
function updateNowTitle() {
  if (!doc) return;
  const s = doc.sentences[cursor];
  $('now-title').textContent = '"' + doc.title + '", paragraph ' + (s.p + 1) + ' of ' + doc.paragraphs.length + '.';
}
let currentParaEl = null;
function showNowReading() {
  if (!doc) return;
  const s = doc.sentences[cursor];
  $('now-reading').textContent = s.text;
  const el = document.getElementById('para-' + s.p);
  if (currentParaEl && currentParaEl !== el) currentParaEl.classList.remove('current');
  if (el && settings.follow) { el.classList.add('current'); currentParaEl = el; scrollDocTo(el); }
  updateNowTitle();
}
function scrollDocTo(el) {
  // Only follow along when the text is on screen, so the page never jumps away from where you are.
  const r = $('doc').getBoundingClientRect();
  if (r.bottom < 0 || r.top > window.innerHeight) return;
  const er = el.getBoundingClientRect();
  if (er.top >= 80 && er.bottom <= window.innerHeight - 40) return;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
}
function where() {
  if (!doc) return 'No text is loaded yet.';
  const s = doc.sentences[cursor];
  const pct = Math.round((cursor / Math.max(1, doc.sentences.length - 1)) * 100);
  return 'In "' + doc.title + '", paragraph ' + (s.p + 1) + ' of ' + doc.paragraphs.length + ', sentence ' + (cursor + 1) + ' of ' + doc.sentences.length + '. About ' + pct + ' percent through.';
}

// ---------------------------------------------------------------- voices
function effectiveEngine() {
  if (settings.engine === 'neural' && loaded.tts) return 'neural';
  if (settings.engine === 'vo') return 'vo';
  if ('speechSynthesis' in window) return 'device';
  return loaded.tts ? 'neural' : 'vo';
}
function isSpeaking() { return reader.speaking || replyVoice.active; }

const deviceVoice = {
  voices: [],
  refresh() {
    if (!('speechSynthesis' in window)) return;
    const all = speechSynthesis.getVoices();
    if (!all.length) return;
    const en = all.filter((v) => /^en/i.test(v.lang));
    const rest = all.filter((v) => !/^en/i.test(v.lang));
    const rank = (v) => (/(premium|enhanced|natural|neural|siri)/i.test(v.name) ? 0 : 1) + (v.localService ? 0 : 0.5) + (/^en[-_]US/i.test(v.lang) ? 0 : 0.2);
    en.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    this.voices = [...en, ...rest];
    const sel = $('device-voice'); const keep = settings.deviceVoice;
    sel.textContent = '';
    const def = document.createElement('option'); def.value = ''; def.textContent = 'Default voice'; sel.appendChild(def);
    for (const v of this.voices) {
      const o = document.createElement('option'); o.value = v.voiceURI;
      o.textContent = v.name + ' (' + v.lang + ')' + (v.localService ? '' : ', online');
      sel.appendChild(o);
    }
    sel.value = this.voices.some((v) => v.voiceURI === keep) ? keep : '';
  },
  pick() { return this.voices.find((v) => v.voiceURI === settings.deviceVoice) || null; },
  speak(text, rate) {
    return new Promise((resolve, reject) => {
      const u = new SpeechSynthesisUtterance(text);
      const v = this.pick(); if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'en-US';
      u.rate = Math.max(0.5, Math.min(2, rate));
      let done = false;
      const finish = (ok) => { if (done) return; done = true; clearInterval(keep); ok ? resolve() : reject(new Error('cancelled')); };
      u.onend = () => finish(true);
      u.onerror = (e) => finish(e.error === 'interrupted' || e.error === 'canceled' ? false : true);
      // Chrome sometimes stalls long speech; a gentle nudge keeps it going.
      const keep = setInterval(() => { if (!speechSynthesis.speaking) finish(true); }, 4000);
      speechSynthesis.speak(u);
      this.cancelCurrent = () => finish(false);
    });
  },
  cancel() { if ('speechSynthesis' in window) speechSynthesis.cancel(); if (this.cancelCurrent) this.cancelCurrent(); },
};

const neuralVoice = {
  cache: new Map(),         // key -> Promise<url>
  key(i, text) { return settings.neuralVoice + '|' + settings.speed + '|' + i + '|' + text.length; },
  synth(text, i) {
    const k = this.key(i, text);
    if (!this.cache.has(k)) {
      const p = call('speak', { text, voice: settings.neuralVoice, speed: settings.speed }).then((r) => URL.createObjectURL(wavBlob(r.audio, r.sampleRate)));
      p.catch(() => this.cache.delete(k));
      this.cache.set(k, p);
      if (this.cache.size > 8) { const first = this.cache.keys().next().value; const old = this.cache.get(first); this.cache.delete(first); old.then((u) => setTimeout(() => URL.revokeObjectURL(u), 60000)).catch(() => {}); }
    }
    return this.cache.get(k);
  },
  clear() { for (const p of this.cache.values()) p.then((u) => setTimeout(() => URL.revokeObjectURL(u), 60000)).catch(() => {}); this.cache.clear(); },
  play(url) {
    return new Promise((resolve, reject) => {
      const a = $('audio');
      const cleanup = () => { a.onended = null; a.onerror = null; this.cancelCurrent = null; };
      a.onended = () => { cleanup(); resolve(); };
      a.onerror = () => { cleanup(); reject(new Error('Audio playback failed.')); };
      this.cancelCurrent = () => { cleanup(); reject(new Error('cancelled')); };
      a.src = url; a.playbackRate = 1;
      const p = a.play(); if (p && p.catch) p.catch((err) => { cleanup(); reject(err); });
    });
  },
  cancel() { const a = $('audio'); try { a.pause(); } catch (e) { /* */ } if (this.cancelCurrent) this.cancelCurrent(); },
};

// A reply (assistant answer) spoken with the chosen voice, or handed to VoiceOver.
const replyVoice = {
  active: false, token: 0,
  async say(text) {
    const engine = effectiveEngine();
    if (engine === 'vo') { announcer.say(text, { important: true }); return; }
    const tok = ++this.token; this.active = true;
    try {
      const parts = text.length > 280 ? splitSentences(text) : [text];
      for (let i = 0; i < parts.length; i++) {
        if (tok !== this.token) return;
        if (engine === 'neural') { const url = await neuralVoice.synth(parts[i], 'reply-' + tok + '-' + i); if (tok !== this.token) return; await neuralVoice.play(url); }
        else await deviceVoice.speak(parts[i], settings.speed);
      }
    } catch (e) { /* cancelled */ }
    finally { if (tok === this.token) { this.active = false; announcer.flush(); } }
  },
  cancel() { if (!this.active) return; this.token++; this.active = false; neuralVoice.cancel(); deviceVoice.cancel(); },
};

// ---------------------------------------------------------------- reader
const reader = {
  state: 'idle', token: 0, speaking: false, warnedNeural: false,
  async play() {
    if (!doc) { announcer.say('Nothing to read yet. Paste text, open a file, or load the welcome sample.', { important: true }); $('paste').focus(); return; }
    replyVoice.cancel();
    const engine = effectiveEngine();
    if (settings.engine === 'neural' && !loaded.tts && !this.warnedNeural) { this.warnedNeural = true; announcer.say('The neural voice is not loaded yet, so I will use your device voice. Load it under Load voices.', { important: true }); }
    if (engine === 'vo') { this.state = 'idle'; focusParagraph(true); return; }
    if (this.state === 'paused' && engine === 'neural' && $('audio').src && !$('audio').ended && this.pausedAt === cursor) {
      this.state = 'playing'; this.speaking = true; setMediaState();
      $('audio').play().catch(() => {}); return;
    }
    if (cursor >= doc.sentences.length || this.atEnd) { cursor = 0; this.atEnd = false; }
    const tok = ++this.token; this.state = 'playing'; setMediaState();
    this.loop(tok, engine);
  },
  async loop(tok, engine) {
    while (tok === this.token && cursor < doc.sentences.length) {
      const i = cursor; const s = doc.sentences[i];
      showNowReading(); savePosition();
      try {
        this.speaking = true;
        if (engine === 'neural') {
          const url = await neuralVoice.synth(s.text, i);
          for (let k = 1; k <= 2 && i + k < doc.sentences.length; k++) neuralVoice.synth(doc.sentences[i + k].text, i + k);
          if (tok !== this.token) return;
          await neuralVoice.play(url);
        } else {
          await deviceVoice.speak(s.text, settings.speed);
        }
      } catch (e) {
        if (tok !== this.token) return;
        if (e && e.message !== 'cancelled') { this.speaking = false; this.state = 'idle'; announcer.say('Reading stopped: ' + e.message, { important: true }); earcon('error'); return; }
        return;
      }
      if (tok !== this.token) return;
      if (cursor === i) cursor = i + 1;
    }
    if (tok === this.token) {
      this.speaking = false; this.state = 'idle'; cursor = Math.max(0, doc.sentences.length - 1); this.atEnd = true; setMediaState();
      announcer.say('End of the text.');
    }
  },
  pause() {
    if (this.state !== 'playing') { if (effectiveEngine() === 'vo') announcer.say('In VoiceOver mode, VoiceOver does the reading. Tap with two fingers to pause it.', { important: true }); return; }
    this.state = 'paused'; this.speaking = false; this.pausedAt = cursor;
    if (effectiveEngine() === 'neural') { try { $('audio').pause(); } catch (e) { /* */ } }
    else { this.token++; deviceVoice.cancel(); }
    setMediaState(); announcer.say('Paused.');
  },
  stop(silent) {
    const was = this.state;
    this.token++; this.state = 'idle'; this.speaking = false;
    neuralVoice.cancel(); deviceVoice.cancel();
    if (!silent) { cursor = 0; showNowReading(); savePosition(); setMediaState(); if (was !== 'idle' || doc) announcer.say('Stopped. Back to the start.'); }
  },
  toggle() { this.state === 'playing' ? this.pause() : this.play(); },
  jumpTo(i, { speakIdle = true, unit = 's' } = {}) {
    if (!doc) { announcer.say('No text loaded yet.', { important: true }); return; }
    cursor = Math.max(0, Math.min(doc.sentences.length - 1, i)); this.atEnd = false;
    const engine = effectiveEngine();
    if (this.state === 'playing') { this.token++; neuralVoice.cancel(); deviceVoice.cancel(); const tok = ++this.token; this.loop(tok, engine); return; }
    if (this.state === 'paused') { this.token++; neuralVoice.cancel(); deviceVoice.cancel(); this.state = 'idle'; this.speaking = false; setMediaState(); }
    showNowReading(); savePosition();
    if (engine === 'vo' && unit === 'p') { focusParagraph(false); return; }
    if (speakIdle) announcer.say('Sentence ' + (cursor + 1) + ' of ' + doc.sentences.length + ': ' + doc.sentences[cursor].text, { important: true });
  },
  move(kind, dir, opts = {}) {
    if (!doc) { announcer.say('No text loaded yet.', { important: true }); return; }
    if (kind === 's') return this.jumpTo(cursor + dir, { ...opts, unit: 's' });
    const p = doc.sentences[cursor].p;
    let target = p + dir;
    if (dir < 0 && this.state === 'playing' && cursor > doc.paragraphs[p].first) target = p; // restart this paragraph first
    target = Math.max(0, Math.min(doc.paragraphs.length - 1, target));
    this.jumpTo(doc.paragraphs[target].first, { ...opts, unit: 'p' });
  },
};
function focusParagraph(firstTime) {
  if (!doc) return;
  const el = document.getElementById('para-' + doc.sentences[cursor].p);
  if (!el) return;
  showNowReading();
  el.focus({ preventScroll: false });
  if (firstTime && !focusParagraph.hinted) { focusParagraph.hinted = true; setTimeout(() => announcer.say('VoiceOver mode. Swipe right to keep reading, or use the read-all gesture.'), 1500); }
}

// ---------------------------------------------------------------- media session (lock screen, headphones)
function setMediaState() {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({ title: doc ? doc.title : 'Earshot', artist: 'Earshot', album: 'Read aloud' });
    navigator.mediaSession.playbackState = reader.state === 'playing' ? 'playing' : reader.state === 'paused' ? 'paused' : 'none';
  } catch (e) { /* */ }
}
function wireMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const h = { play: () => reader.play(), pause: () => reader.pause(), stop: () => reader.stop(), previoustrack: () => reader.move('s', -1), nexttrack: () => reader.move('s', 1) };
  for (const k in h) { try { navigator.mediaSession.setActionHandler(k, h[k]); } catch (e) { /* unsupported action */ } }
}

// ---------------------------------------------------------------- answers
async function ensureIndex() {
  if (!index) index = new PassageIndex(doc);
  if (loaded.embed && !index.vectors) {
    announcer.say('Indexing the text for smarter matching. One moment.');
    progressSink = null;
    const { vectors } = await call('embed', { texts: index.passages.map((p) => p.text) });
    index.vectors = vectors;
  }
  return index;
}
async function answer(question, { fromVoice = false } = {}) {
  const q = question.trim();
  if (!q) return;
  if (!doc) { const msg = 'There is no text loaded yet. Paste some text, open a file, or fetch a page first, then ask me about it.'; showAnswer(msg, null); return msg; }
  let idx;
  try { idx = await ensureIndex(); } catch (e) { idx = index || new PassageIndex(doc); }
  let qv = null;
  if (loaded.embed && idx.vectors) { try { qv = (await call('embed', { texts: [q] })).vectors[0]; } catch (e) { qv = null; } }
  const { results, mode } = idx.search(q, { queryVector: qv, limit: 5 });
  renderMatches(results.slice(1));
  if (!results.length) { const msg = 'I could not find anything about that in the text.'; showAnswer(msg, null); lastAnswer = null; return msg; }
  const top = results[0];
  lastAnswer = top;
  if (loaded.llm) {
    try {
      setAnswerBusy();
      const passages = results.slice(0, 3).map((r, i) => '[' + (i + 1) + '] ' + r.text).join('\n\n');
      const messages = [
        { role: 'system', content: 'You answer questions about a document using only the passages given. Answer in one to three short, plain sentences. If the passages do not contain the answer, say: I could not find that in the text.' },
        { role: 'user', content: 'Passages from "' + doc.title + '":\n\n' + passages + '\n\nQuestion: ' + q },
      ];
      const { text } = await call('generate', { messages, max_new_tokens: 140 });
      if (text) { const msg = text + ' (Answer written on your device by a small AI model. The source is paragraph ' + (top.p + 1) + '.)'; showAnswer(text, top, 'Written by the on-device model from paragraph ' + (top.p + 1) + '. Small models can be wrong; check the source passage.'); return msg; }
    } catch (e) { /* fall back to the passage */ }
  }
  const how = mode === 'meaning' ? 'closest match by meaning' : 'best keyword match';
  const msg = 'From paragraph ' + (top.p + 1) + ': ' + top.text;
  showAnswer(top.text, top, 'Found passage (' + how + '), paragraph ' + (top.p + 1) + ' of ' + doc.paragraphs.length + '.');
  return msg;
}
function setAnswerBusy() { const box = $('answer'); box.textContent = ''; const p = document.createElement('p'); p.textContent = 'Thinking on your device…'; box.appendChild(p); }
function showAnswer(text, passage, label) {
  const box = $('answer'); box.textContent = '';
  if (label) { const l = document.createElement('p'); l.className = 'hint'; l.textContent = label; box.appendChild(l); }
  const p = document.createElement('p'); p.textContent = text; box.appendChild(p);
  if (passage) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = 'Read from here (paragraph ' + (passage.p + 1) + ')';
    b.addEventListener('click', () => { unlockAudio(); readFrom(passage.first); });
    box.appendChild(b);
  }
}
function renderMatches(list) {
  const ol = $('matches'); ol.textContent = '';
  if (!list.length) { const li = document.createElement('li'); li.textContent = 'None.'; ol.appendChild(li); return; }
  for (const r of list) {
    const li = document.createElement('li');
    const p = document.createElement('p'); p.textContent = 'Paragraph ' + (r.p + 1) + ': ' + r.text; li.appendChild(p);
    const b = document.createElement('button'); b.type = 'button'; b.textContent = 'Read from paragraph ' + (r.p + 1);
    b.addEventListener('click', () => { unlockAudio(); readFrom(r.first); });
    li.appendChild(b); ol.appendChild(li);
  }
}
function readFrom(i) { reader.stop(true); reader.atEnd = false; cursor = i; showNowReading(); reader.play(); }

async function summarize() {
  if (!doc) return 'There is no text loaded yet.';
  if (loaded.llm) {
    try {
      const text = doc.sentences.slice(0, 40).map((s) => s.text).join(' ').slice(0, 3000);
      const { text: out } = await call('generate', { messages: [
        { role: 'system', content: 'Summarize the text in two or three plain sentences.' },
        { role: 'user', content: text },
      ], max_new_tokens: 140 });
      if (out) return '"' + doc.title + '". ' + out + ' (Summary written on your device by a small AI model.)';
    } catch (e) { /* fall back */ }
  }
  const key = extractSummary(doc, 3).join(' ');
  const kw = topKeywords(doc, 5);
  return '"' + doc.title + '", about ' + minutes(doc.words) + ' of listening. Key sentences: ' + key + (kw.length ? ' Common words: ' + kw.join(', ') + '.' : '');
}

// ---------------------------------------------------------------- conversation
function addTurn(who, text) {
  const li = document.createElement('li'); li.className = who === 'me' ? 'me' : 'bot';
  li.textContent = (who === 'me' ? 'You: ' : 'Earshot: ') + text;
  $('convo').appendChild(li);
}
async function reply(text) { addTurn('bot', text); await replyVoice.say(text); }

async function handleUtterance(raw, { resume = false } = {}) {
  const text = (raw || '').trim();
  if (!text) return;
  addTurn('me', text);
  const intent = interpret(text);
  switch (intent.action) {
    case 'read': if (intent.from === 'answer' && lastAnswer) { readFrom(lastAnswer.first); } else if (intent.from === 'start') { reader.stop(true); cursor = 0; reader.play(); } else reader.play(); addTurn('bot', 'Reading.'); return;
    case 'pause': reader.pause(); addTurn('bot', 'Paused.'); return;
    case 'stop': reader.stop(); addTurn('bot', 'Stopped.'); return;
    case 'faster': setSpeed(settings.speed + 0.2); await reply('Speed ' + fmtSpeed(settings.speed) + '.'); if (resume) reader.play(); return;
    case 'slower': setSpeed(settings.speed - 0.2); await reply('Speed ' + fmtSpeed(settings.speed) + '.'); if (resume) reader.play(); return;
    case 'next': case 'previous': {
      if (!doc) return reply('There is no text loaded yet.');
      reader.move(intent.unit, intent.action === 'next' ? 1 : -1, { speakIdle: false });
      if (resume) { reader.play(); addTurn('bot', 'Reading from there.'); return; }
      return reply(doc.sentences[cursor].text);
    }
    case 'repeat': reader.jumpTo(cursor); if (reader.state !== 'playing') reader.play(); return;
    case 'where': return reply(where());
    case 'summary': return reply(await summarize());
    case 'help': return reply('You can say read, pause, stop, faster, slower, next, back, start over, where am I, or what is this about. You can also ask a question about the text, like "who is the main character?"');
    case 'time': return reply('It is ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + '.');
    case 'date': return reply('Today is ' + new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }) + '.');
    case 'hello': return reply(doc ? 'Hi! I have "' + doc.title + '" ready. Say read, or ask me something about it.' : 'Hi! Give me something to read. Paste text, open a file, or fetch a page, then say read.');
    case 'thanks': return reply('Any time.');
    case 'voice': { const v = KOKORO_VOICES.find((x) => x.name.toLowerCase() === intent.name); if (v && loaded.tts) { settings.neuralVoice = v.id; $('neural-voice').value = v.id; saveSettings(); neuralVoice.clear(); await reply('Switched to ' + v.name + '.'); if (resume) reader.play(); return; } return reply(loaded.tts ? 'I do not have a voice by that name.' : 'Load the neural voices first, under Load voices.'); }
    default: {
      const out = await answer(intent.query || text, { fromVoice: true });
      return reply(out);
    }
  }
}

// ---------------------------------------------------------------- listening
const listener = {
  active: false, rec: null, media: null, stream: null, stopTimer: 0, raf: 0, resumeAfter: false,
  available() { return loaded.stt || !!(window.SpeechRecognition || window.webkitSpeechRecognition); },
  async toggle() { this.active ? this.stop() : this.start(); },
  async start() {
    if (this.active) return;
    unlockAudio();
    if (!this.available()) { announcer.say('Speech recognition is not available in this browser. Load Whisper under Load voices, or type to Earshot instead.', { important: true }); return; }
    this.resumeAfter = reader.state === 'playing';
    if (reader.state === 'playing') reader.pause();
    replyVoice.cancel();
    this.active = true; setTalkButton(true); earcon('listen');
    if (loaded.stt) return this.startWhisper();
    return this.startWebSpeech();
  },
  startWebSpeech() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new SR(); this.rec = rec;
    rec.lang = 'en-US'; rec.interimResults = false; rec.maxAlternatives = 1; rec.continuous = !settings.autostop;
    let heard = '';
    rec.onresult = (e) => { for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) heard += e.results[i][0].transcript + ' '; };
    rec.onerror = (e) => { if (e.error === 'not-allowed' || e.error === 'service-not-allowed') announcer.say('Microphone permission was denied. Allow the microphone for this site to talk to Earshot.', { important: true }); };
    rec.onend = () => { const was = this.active; this.finish(); if (was) { if (heard.trim()) handleUtterance(heard, { resume: this.resumeAfter }); else announcer.say('I did not catch that.'); } };
    try { rec.start(); } catch (e) { this.finish(); announcer.say('Could not start listening: ' + e.message, { important: true }); }
  },
  async startWhisper() {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) { this.finish(); announcer.say('Microphone permission was denied or no microphone was found.', { important: true }); return; }
    const chunks = [];
    const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
    const mime = window.MediaRecorder ? types.find((t) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) : null;
    try { this.media = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined); }
    catch (e) { this.finish(); announcer.say('This browser cannot record audio.', { important: true }); return; }
    this.media.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    this.media.onstop = async () => {
      const blob = new Blob(chunks, { type: this.media.mimeType || mime || 'audio/webm' });
      this.releaseMic();
      if (blob.size < 1200) { announcer.say('I did not hear anything.'); return; }
      $('listen-status').textContent = 'Transcribing on your device…';
      try {
        const audio = await decodeTo16k(blob);
        const { text } = await call('transcribe', { audio }, [audio.buffer]);
        $('listen-status').textContent = 'Listening with Whisper on your device.';
        const clean = (text || '').replace(/\[(BLANK_AUDIO|MUSIC|NOISE)\]|\((.*?)\)/gi, '').trim();
        if (clean) handleUtterance(clean, { resume: this.resumeAfter }); else announcer.say('I did not catch that.');
      } catch (err) { $('listen-status').textContent = 'Listening with Whisper on your device.'; announcer.say('Transcription failed: ' + err.message, { important: true }); earcon('error'); }
    };
    this.media.start(250);
    if (settings.autostop) this.watchSilence();
    this.stopTimer = setTimeout(() => this.stop(), 30000);
  },
  watchSilence() {
    const c = ctx(); if (!c || !this.stream) return;
    const src = c.createMediaStreamSource(this.stream); const an = c.createAnalyser(); an.fftSize = 1024; src.connect(an);
    const data = new Float32Array(an.fftSize); let speech = false, quietSince = performance.now(); const started = performance.now();
    const tick = () => {
      if (!this.active || !this.media) { try { src.disconnect(); } catch (e) { /* */ } return; }
      an.getFloatTimeDomainData(data); let sum = 0; for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      const rms = Math.sqrt(sum / data.length); const now = performance.now();
      if (rms > 0.025) { speech = true; quietSince = now; }
      if (speech && now - quietSince > 1400) { this.stop(); return; }
      if (!speech && now - started > 8000) { this.stop(); return; }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  },
  stop() {
    if (!this.active) return;
    clearTimeout(this.stopTimer); cancelAnimationFrame(this.raf);
    if (this.rec) { try { this.rec.stop(); } catch (e) { this.finish(); } return; }
    if (this.media && this.media.state !== 'inactive') { this.active = false; setTalkButton(false); earcon('stop'); this.media.stop(); return; }
    this.finish();
  },
  releaseMic() { if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; } this.media = null; },
  finish() {
    const was = this.active; this.active = false; this.rec = null; clearTimeout(this.stopTimer);
    this.releaseMic(); setTalkButton(false); if (was) earcon('stop');
  },
};
function setTalkButton(on) { const b = $('btn-talk'); b.setAttribute('aria-pressed', on ? 'true' : 'false'); b.textContent = on ? 'Listening… press to stop' : 'Talk'; }
async function decodeTo16k(blob) {
  const buf = await blob.arrayBuffer();
  const AC = window.AudioContext || window.webkitAudioContext;
  let c;
  try { c = new AC({ sampleRate: 16000 }); } catch (e) { c = new AC(); }
  const audio = await new Promise((res, rej) => { const p = c.decodeAudioData(buf, res, rej); if (p && p.then) p.then(res, rej); });
  let data = audio.getChannelData(0);
  if (audio.sampleRate !== 16000) {
    const off = new OfflineAudioContext(1, Math.ceil(audio.duration * 16000), 16000);
    const s = off.createBufferSource(); s.buffer = audio; s.connect(off.destination); s.start();
    data = (await off.startRendering()).getChannelData(0);
  }
  try { c.close(); } catch (e) { /* */ }
  return new Float32Array(data);
}

// ---------------------------------------------------------------- loading models
const SIZES = { tts: 93, stt: { 'onnx-community/whisper-tiny.en': 73, 'onnx-community/whisper-base.en': 131, 'onnx-community/distil-small.en': 252 }, embed: 23 };
let gpuInfo = { ok: false, f16: false, reason: 'checking' };
async function checkGPU() {
  const apple = isAppleWebKit();
  if (apple) { gpuInfo = { ok: false, f16: false, reason: 'not available on iPhone, iPad or Safari yet' }; return; }
  if (!navigator.gpu) { gpuInfo = { ok: false, f16: false, reason: 'this browser has no WebGPU' }; return; }
  try {
    const ad = await navigator.gpu.requestAdapter();
    if (!ad) { gpuInfo = { ok: false, f16: false, reason: 'no WebGPU graphics adapter' }; return; }
    gpuInfo = { ok: true, f16: ad.features.has('shader-f16'), reason: '' };
  } catch (e) { gpuInfo = { ok: false, f16: false, reason: 'WebGPU failed to start' }; }
}
function isAppleWebKit() {
  const ua = navigator.userAgent;
  const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const safari = (navigator.vendor || '').includes('Apple') && !/Chrome|Chromium|Edg\//.test(ua);
  return ios || safari;
}
function llmSize() { return gpuInfo.f16 ? 350 : 576; }
function selection() {
  return { tts: $('m-tts').checked, stt: $('m-stt').checked, sttModel: $('m-stt-model').value, embed: $('m-embed').checked, llm: $('m-llm').checked && (gpuInfo.ok || !!TEST.forceLLM) };
}
function updateSizes() {
  const s = selection();
  let mb = 0;
  if (s.tts && !loaded.tts) mb += SIZES.tts;
  if (s.stt && (!loaded.stt || loaded.sttModel !== s.sttModel)) mb += SIZES.stt[s.sttModel] || 73;
  if (s.embed && !loaded.embed) mb += SIZES.embed;
  if (s.llm && !loaded.llm) mb += llmSize();
  const engine = !worker ? (s.llm ? 24 : 13) : (s.llm && workerFlavor !== 'asyncify' ? 24 : 0);
  const total = mb + engine;
  $('m-llm-label').textContent = 'Answers in its own words: Granite 4.0 350M (about ' + llmSize() + ' MB, needs WebGPU' + (gpuInfo.ok ? ')' : ', ' + gpuInfo.reason + ')');
  $('m-llm').disabled = !gpuInfo.ok && !TEST.forceLLM;
  if (total === 0) { $('size-warning').textContent = 'Everything you picked is loaded.'; $('btn-load').textContent = 'Load voices'; return; }
  $('size-warning').textContent = 'Download size: about ' + total + ' MB (' + (engine ? 'includes ' + engine + ' MB speech engine from this site, ' : '') + 'models from Hugging Face). Use Wi-Fi. Models you already downloaded load from your browser without downloading again.' + cachedNote;
  $('btn-load').textContent = 'Load voices (about ' + total + ' MB)';
}

let loadingNow = false;
let cachedNote = '';
async function loadModels() {
  if (loadingNow) return;
  const s = selection();
  if (!s.tts && !s.stt && !s.embed && !s.llm) { announcer.say('Pick at least one model to load.', { important: true }); return; }
  unlockAudio();
  loadingNow = true; $('btn-load').disabled = true; $('load-box').hidden = false;
  Object.assign(settings, { tts: s.tts, stt: s.stt, sttModel: s.sttModel, embed: s.embed, llm: s.llm }); saveSettings();
  const flavor = s.llm ? 'asyncify' : (workerFlavor || 'plain');
  const steps = [];
  steps.push({ what: 'engine', label: 'Speech engine' });
  if (s.tts && !loaded.tts) steps.push({ what: 'tts', label: 'Neural voice', options: { dtype: 'q8', voice: settings.neuralVoice } });
  if (s.stt && (!loaded.stt || loaded.sttModel !== s.sttModel)) steps.push({ what: 'stt', label: 'Whisper', options: { model: s.sttModel } });
  if (s.embed && !loaded.embed) steps.push({ what: 'embed', label: 'Smarter matching', options: { model: TEST.embedModel || 'Xenova/all-MiniLM-L6-v2', dtype: TEST.embedDtype || 'q8' } });
  if (s.llm && !loaded.llm) steps.push({ what: 'llm', label: 'Answer model', options: { model: TEST.llmModel || 'onnx-community/granite-4.0-350m-ONNX-web', dtype: TEST.llmDtype || (gpuInfo.f16 ? 'q4f16' : 'q4'), device: TEST.llmDevice || 'webgpu' } });
  if (TEST.sttModel) steps.forEach((st) => { if (st.what === 'stt') { st.options.model = TEST.sttModel; if (TEST.sttDtype) st.options.dtype = TEST.sttDtype; } });
  try {
    const needRestart = !worker || workerFlavor !== flavor;
    if (needRestart) {
      const reload = Object.keys(loaded).filter((k) => loaded[k] && k !== 'sttModel');
      startWorker(flavor);
      for (const k of reload) if (!steps.some((st) => st.what === k)) steps.push(k === 'tts' ? { what: 'tts', label: 'Neural voice', options: { dtype: 'q8', voice: settings.neuralVoice } } : k === 'stt' ? { what: 'stt', label: 'Whisper', options: { model: TEST.sttModel || settings.sttModel } } : k === 'embed' ? { what: 'embed', label: 'Smarter matching', options: { model: TEST.embedModel || 'Xenova/all-MiniLM-L6-v2', dtype: TEST.embedDtype || 'q8' } } : null);
    }
    for (let n = 0; n < steps.length; n++) {
      const st = steps[n]; if (!st) continue;
      const prefix = 'Step ' + (n + 1) + ' of ' + steps.length + ', ' + st.label;
      let lastSpoken = -1;
      $('prog-label').textContent = prefix; $('prog').value = 0; $('prog-text').textContent = prefix + ': starting.';
      progressSink = (m) => {
        if (m.total) {
          const pct = Math.min(100, Math.floor((m.loaded / m.total) * 100));
          $('prog').value = pct;
          $('prog-text').textContent = prefix + ': ' + pct + ' percent (' + mbStr(m.loaded) + ' of ' + mbStr(m.total) + ').';
          const quarter = Math.floor(pct / 25) * 25;
          if (quarter > lastSpoken && quarter > 0 && quarter < 100) { lastSpoken = quarter; announcer.say(st.label + ' ' + quarter + ' percent.'); }
        }
      };
      if (st.what === 'engine') {
        if (needRestart) { announcer.say('Downloading. ' + prefix + '.'); await call('init', { options: { base: BASE, flavor, remoteHost: TEST.remoteHost || 'https://huggingface.co/', device: 'wasm' } }); }
        continue;
      }
      announcer.say(prefix + '.');
      await call('load', { what: st.what, options: st.options });
      loaded[st.what] = true; if (st.what === 'stt') loaded.sttModel = st.options.model;
      $('prog').value = 100; $('prog-text').textContent = prefix + ': ready.';
    }
    progressSink = null;
    afterLoad();
  } catch (e) {
    progressSink = null;
    $('prog-text').textContent = 'Loading stopped: ' + e.message + ' Your device voice still works.';
    announcer.say('Loading stopped: ' + e.message + ' Your device voice still works.', { important: true });
    earcon('error');
  } finally {
    loadingNow = false; $('btn-load').disabled = false; updateSizes(); updateStatus();
  }
}
function mbStr(b) { return (b / 1048576).toFixed(b > 10485760 ? 0 : 1) + ' MB'; }
function afterLoad() {
  const parts = [];
  if (loaded.tts) { if (settings.engine !== 'vo') { settings.engine = 'neural'; $('engine-neural').checked = true; } parts.push('neural voice'); }
  if (loaded.stt) parts.push('Whisper listening');
  if (loaded.embed) { parts.push('smarter matching'); if (index) index.vectors = null; }
  if (loaded.llm) parts.push('answers in its own words');
  saveSettings(); neuralVoice.clear(); updateEngineFields(); updateStatus(); updateAnswerMode();
  earcon('ready');
  const voiceName = (KOKORO_VOICES.find((v) => v.id === settings.neuralVoice) || {}).name;
  announcer.say('Ready: ' + parts.join(', ') + '.' + (loaded.tts && settings.engine === 'neural' ? ' Earshot will read with ' + voiceName + '.' : ''), { important: true });
  $('prog-text').textContent = 'Ready: ' + parts.join(', ') + '. Saved in this browser for offline use.';
}
async function forgetModels() {
  try {
    for (const name of ['transformers-cache', 'earshot-voices-v1']) await caches.delete(name);
    if (worker) { worker.terminate(); worker = null; workerFlavor = null; }
    for (const k in loaded) loaded[k] = false;
    if (settings.engine === 'neural') { settings.engine = 'device'; $('engine-device').checked = true; }
    saveSettings(); updateSizes(); updateStatus(); updateEngineFields(); updateAnswerMode();
    announcer.say('Deleted the downloaded models from this browser.', { important: true });
  } catch (e) { announcer.say('Could not delete the models: ' + e.message, { important: true }); }
}
async function markCached() {
  try {
    const c = await caches.open('transformers-cache'); const keys = (await c.keys()).map((r) => r.url);
    const has = (id) => keys.some((u) => u.includes('/' + id + '/'));
    const notes = [];
    if (has('onnx-community/Kokoro-82M-v1.0-ONNX')) notes.push('neural voice');
    if (has(settings.sttModel)) notes.push('Whisper');
    cachedNote = notes.length ? ' Already downloaded: ' + notes.join(' and ') + '.' : '';
    updateSizes();
  } catch (e) { /* no cache API */ }
}

// ---------------------------------------------------------------- status texts
function updateStatus() {
  const e = effectiveEngine();
  const v = KOKORO_VOICES.find((x) => x.id === settings.neuralVoice);
  const reading = e === 'neural' ? 'Reading with the neural voice ' + (v ? v.name : '') + '.' : e === 'vo' ? 'VoiceOver mode: your screen reader does the reading.' : 'Reading with your device\'s voice.' + (loaded.tts ? '' : ' Neural voices aren\'t loaded.');
  $('engine-status').textContent = reading;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  $('listen-status').textContent = loaded.stt ? 'Listening with Whisper on your device. Nothing leaves this device.' : SR ? 'Listening uses your device\'s speech recognition, which may send audio to Apple or Google. Load Whisper under Load voices to keep it on your device.' : 'This browser has no built-in speech recognition. Load Whisper under Load voices, or type instead.';
}
function updateAnswerMode() {
  $('answer-mode').textContent = loaded.llm
    ? 'How answers work right now: Earshot finds the best passages, then a small AI model on your device answers in its own words using only those passages. It can still be wrong, so the source passage is always one button away.'
    : loaded.embed
      ? 'How answers work right now: Earshot finds the passage closest in meaning to your question (a small model on your device) and reads it to you. It never makes things up, but it doesn\'t explain in its own words.'
      : 'How answers work right now: Earshot finds the passage that best matches your question and reads it to you. It\'s a keyword search on your device, so it never makes things up, but it can\'t explain in its own words. Turn on smarter matching or answers in its own words under Load voices.';
}
function updateEngineFields() {
  $('neural-voice-field').hidden = settings.engine !== 'neural';
  $('device-voice-field').hidden = settings.engine !== 'device';
  $('btn-preview').hidden = settings.engine === 'vo';
}
function fmtSpeed(v) { return (Math.round(v * 10) / 10).toFixed(1) + ' times'; }
function setSpeed(v) {
  v = Math.round(Math.max(0.5, Math.min(2, v)) * 10) / 10;
  settings.speed = v; saveSettings();
  const r = $('speed'); r.value = String(v); r.setAttribute('aria-valuetext', fmtSpeed(v));
  $('speed-out').textContent = v.toFixed(1) + '×';
  neuralVoice.clear();
}

// ---------------------------------------------------------------- loading text
async function loadFile(file) {
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) { announcer.say('That file is over 8 MB. Try a smaller one.', { important: true }); return; }
  const text = await file.text();
  setDoc(docFromText(text, file.name));
}
async function fetchUrl(input) {
  const spec = corsFriendlyUrl(input.trim());
  if (!spec) { announcer.say('That does not look like a web address. It should start with https://', { important: true }); return; }
  $('btn-fetch').disabled = true; announcer.say('Fetching the page.');
  try {
    const headers = spec.kind === 'github-readme' ? { Accept: 'application/vnd.github.raw+json' } : {};
    const res = await fetch(spec.url, { headers, mode: 'cors', credentials: 'omit' });
    if (!res.ok) throw new Error('The site answered with error ' + res.status + '.');
    const type = res.headers.get('content-type') || '';
    const body = await res.text();
    let name = '';
    try { const u = new URL(input); name = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || u.hostname); } catch (e) { /* */ }
    let d;
    if (spec.kind === 'github-readme') { d = docFromText(body, name + '.md'); }
    else if (/html/.test(type) || spec.kind === 'html') { d = docFromText(body, (name || 'page') + '.html'); }
    else if (/markdown/.test(type) || /\.md$/i.test(spec.url)) { d = docFromText(body, name.endsWith('.md') ? name : name + '.md'); }
    else d = docFromText(body, name);
    if (spec.kind === 'html' && spec.note === 'Wikipedia') d.title = name.replace(/_/g, ' ');
    setDoc(d);
  } catch (e) {
    const cors = e instanceof TypeError;
    announcer.say(cors ? 'That site does not let other pages read it, so I could not fetch it. Open the page, copy its text, and paste it into the Text box instead.' : 'Could not fetch the page. ' + e.message, { important: true });
  } finally { $('btn-fetch').disabled = false; }
}

// ---------------------------------------------------------------- keyboard
function onKey(e) {
  if (e.key === 'Escape') {
    let did = false;
    if (listener.active) { listener.stop(); did = true; }
    if (replyVoice.active) { replyVoice.cancel(); did = true; }
    if (reader.state === 'playing') { reader.pause(); did = true; }
    if (did) e.preventDefault();
    return;
  }
  if (!settings.shortcuts || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
  const t = e.target;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
  const k = e.key;
  const map = {
    k: () => { unlockAudio(); reader.toggle(); }, K: () => { unlockAudio(); reader.toggle(); },
    s: () => reader.stop(), S: () => reader.stop(),
    j: () => reader.move('s', -1), l: () => reader.move('s', 1),
    p: () => reader.move('p', -1), n: () => reader.move('p', 1),
    '-': () => { setSpeed(settings.speed - 0.1); if (!isSpeaking()) announcer.say('Speed ' + fmtSpeed(settings.speed)); },
    '=': () => { setSpeed(settings.speed + 0.1); if (!isSpeaking()) announcer.say('Speed ' + fmtSpeed(settings.speed)); },
    '+': () => { setSpeed(settings.speed + 0.1); if (!isSpeaking()) announcer.say('Speed ' + fmtSpeed(settings.speed)); },
    t: () => listener.toggle(), T: () => listener.toggle(),
    a: () => $('question').focus(), A: () => $('question').focus(),
    w: () => announcer.say(where(), { important: true }), W: () => announcer.say(where(), { important: true }),
    '?': () => $('keys-h').focus(),
  };
  const fn = map[k];
  if (fn) { e.preventDefault(); fn(); }
}

// ---------------------------------------------------------------- wire up
function fillNeuralVoices() {
  const sel = $('neural-voice'); sel.textContent = '';
  const groups = {};
  for (const v of KOKORO_VOICES) {
    if (!groups[v.group]) { groups[v.group] = document.createElement('optgroup'); groups[v.group].label = v.group; sel.appendChild(groups[v.group]); }
    const o = document.createElement('option'); o.value = v.id; o.textContent = v.name + ' (' + v.desc + ')'; groups[v.group].appendChild(o);
  }
  sel.value = settings.neuralVoice;
}

function init() {
  announcer.el = $('announcer');
  fillNeuralVoices();
  if (!['neural', 'device', 'vo'].includes(settings.engine)) settings.engine = 'device';
  $('engine-' + settings.engine).checked = true;
  setSpeed(settings.speed);
  for (const id of ['shortcuts', 'announce', 'autostop', 'earcons', 'follow']) {
    const el = $('s-' + id); el.checked = !!settings[id];
    el.addEventListener('change', () => { settings[id] = el.checked; saveSettings(); if (id === 'follow' && !el.checked && currentParaEl) currentParaEl.classList.remove('current'); });
  }
  $('m-tts').checked = settings.tts; $('m-stt').checked = settings.stt; $('m-stt-model').value = settings.sttModel; $('m-embed').checked = settings.embed; $('m-llm').checked = settings.llm;
  for (const id of ['m-tts', 'm-stt', 'm-stt-model', 'm-embed', 'm-llm']) $(id).addEventListener('change', updateSizes);
  updateEngineFields(); updateStatus(); updateAnswerMode();
  checkGPU().then(() => { updateSizes(); markCached(); });
  updateSizes();

  if ('speechSynthesis' in window) { deviceVoice.refresh(); speechSynthesis.addEventListener ? speechSynthesis.addEventListener('voiceschanged', () => deviceVoice.refresh()) : (speechSynthesis.onvoiceschanged = () => deviceVoice.refresh()); }
  else { $('engine-device').disabled = true; if (settings.engine === 'device') { settings.engine = 'vo'; $('engine-vo').checked = true; } }

  $('btn-read').addEventListener('click', () => { unlockAudio(); reader.play(); });
  $('btn-pause').addEventListener('click', () => reader.pause());
  $('btn-stop').addEventListener('click', () => reader.stop());
  $('btn-prev-s').addEventListener('click', () => reader.move('s', -1));
  $('btn-next-s').addEventListener('click', () => reader.move('s', 1));
  $('btn-prev-p').addEventListener('click', () => reader.move('p', -1));
  $('btn-next-p').addEventListener('click', () => reader.move('p', 1));
  $('btn-where').addEventListener('click', () => announcer.say(where(), { important: true }));
  $('speed').addEventListener('input', (e) => setSpeed(parseFloat(e.target.value)));
  document.querySelectorAll('input[name="engine"]').forEach((r) => r.addEventListener('change', () => {
    if (!r.checked) return;
    const wasPlaying = reader.state === 'playing';
    reader.stop(true); replyVoice.cancel();
    settings.engine = r.value; saveSettings(); updateEngineFields(); updateStatus();
    if (r.value === 'neural' && !loaded.tts) announcer.say('The neural voice needs to be loaded first. Go to Load voices. Until then, your device voice reads.');
    if (wasPlaying && r.value !== 'vo') reader.play();
  }));
  $('neural-voice').addEventListener('change', (e) => { settings.neuralVoice = e.target.value; saveSettings(); neuralVoice.clear(); updateStatus(); });
  $('device-voice').addEventListener('change', (e) => { settings.deviceVoice = e.target.value; saveSettings(); });
  $('btn-preview').addEventListener('click', () => {
    unlockAudio();
    const e = effectiveEngine();
    const v = KOKORO_VOICES.find((x) => x.id === settings.neuralVoice);
    const name = e === 'neural' ? (v ? v.name : 'this voice') : ((deviceVoice.pick() || {}).name || 'your device voice');
    if (settings.engine === 'neural' && !loaded.tts) announcer.say('The neural voice is not loaded yet, so this is your device voice.', { important: true });
    replyVoice.say('Hi, this is ' + name + '. This is how I sound reading to you.');
  });

  $('btn-use-paste').addEventListener('click', () => { const t = $('paste').value; if (!t.trim()) { announcer.say('The text box is empty. Type or paste something first.', { important: true }); $('paste').focus(); return; } setDoc(docFromText(t, '')); });
  $('btn-sample').addEventListener('click', () => { setDoc(docFromText(SAMPLE_TEXT, 'Welcome to Earshot.md')); });
  $('file').addEventListener('change', (e) => loadFile(e.target.files[0]).catch((err) => announcer.say('Could not open that file: ' + err.message, { important: true })));
  $('btn-fetch').addEventListener('click', () => fetchUrl($('url').value));
  $('url').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); fetchUrl($('url').value); } });

  $('btn-talk').addEventListener('click', () => listener.toggle());
  $('say-form').addEventListener('submit', (e) => { e.preventDefault(); unlockAudio(); const v = $('say').value; $('say').value = ''; handleUtterance(v); });
  $('btn-clear-convo').addEventListener('click', () => { $('convo').textContent = ''; announcer.say('Conversation cleared.'); });
  $('ask-form').addEventListener('submit', async (e) => {
    e.preventDefault(); unlockAudio();
    const q = $('question').value; if (!q.trim()) { announcer.say('Type a question first.', { important: true }); return; }
    const out = await answer(q);
    if (out) { addTurn('me', q); await reply(out); }
  });
  $('btn-load').addEventListener('click', loadModels);
  $('btn-forget').addEventListener('click', forgetModels);
  document.addEventListener('keydown', onKey);
  wireMediaSession();

  const saved = readJSON(DOC_KEY);
  if (saved && saved.blocks && saved.blocks.length) {
    const b = $('btn-resume'); b.hidden = false; b.textContent = 'Resume "' + saved.title.slice(0, 60) + '" where I left off';
    b.addEventListener('click', () => { const d = buildDoc(saved.title, saved.blocks); setDoc(d, { position: saved.cursor || 0 }); b.hidden = true; });
  }
  window.addEventListener('pagehide', persistDoc);
  if ('serviceWorker' in navigator && location.protocol === 'https:' && !TEST.noSW) navigator.serviceWorker.register('sw.js').catch(() => {});
  window.__earshot = { reader, handleUtterance, answer, get doc() { return doc; }, get cursor() { return cursor; }, loaded, setDoc, docFromText, call, effectiveEngine, announcer };
}
init();
