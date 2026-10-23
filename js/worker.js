// Earshot neural worker: runs every on-device model off the main thread,
// so the page (and VoiceOver) stays responsive while models load and think.
// Runtime: Transformers.js (vendored, Apache-2.0) + ONNX Runtime Web (vendored, MIT).
// Kokoro phonemes: eSpeak NG compiled to WebAssembly (vendored, GPL-3.0).

let T = null;               // transformers module
let phonemizeFn = null;     // espeak-ng phonemizer
let cfg = { base: '', remoteHost: 'https://huggingface.co/', flavor: 'plain', device: 'wasm' };
const models = {};          // tts, stt, embed, llm

const KOKORO_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const STYLE_DIM = 256;
const SAMPLE_RATE = 24000;
const voiceCache = new Map();

function post(msg, transfer) { self.postMessage(msg, transfer || []); }

function progressHandler(what) {
  const files = {};
  let lastPct = -1;
  return (p) => {
    if (!p || !p.file) return;
    if (p.status === 'progress' || p.status === 'download' || p.status === 'initiate') {
      const f = files[p.file] || (files[p.file] = { loaded: 0, total: 0 });
      if (typeof p.loaded === 'number') f.loaded = p.loaded;
      if (typeof p.total === 'number') f.total = p.total;
    } else if (p.status === 'done') {
      const f = files[p.file] || (files[p.file] = { loaded: 0, total: 0 });
      if (f.total) f.loaded = f.total;
    } else { return; }
    let loaded = 0, total = 0;
    for (const k in files) { loaded += files[k].loaded; total += files[k].total; }
    const pct = total ? Math.floor((loaded / total) * 100) : 0;
    if (pct !== lastPct) { lastPct = pct; post({ type: 'progress', what, loaded, total, file: p.file }); }
  };
}

async function fetchParts(base, parts, totalSize, what) {
  const out = new Uint8Array(totalSize);
  let offset = 0;
  for (let i = 0; i < parts.length; i++) {
    const r = await fetch(base + parts[i]);
    if (!r.ok) throw new Error('Could not download the speech engine (part ' + (i + 1) + ' of ' + parts.length + ').');
    const buf = new Uint8Array(await r.arrayBuffer());
    out.set(buf, offset);
    offset += buf.length;
    post({ type: 'progress', what, loaded: offset, total: totalSize, file: 'engine' });
  }
  if (offset !== totalSize) throw new Error('The speech engine download was incomplete.');
  return out.buffer;
}

async function init(options) {
  Object.assign(cfg, options || {});
  if (T) return { ok: true };
  const vendor = cfg.base + 'vendor/';
  T = await import(vendor + 'transformers/transformers.min.js');
  const env = T.env;
  env.allowLocalModels = false;
  env.allowRemoteModels = true;
  env.remoteHost = cfg.remoteHost;
  env.useBrowserCache = true;
  // Never let the runtime reach a CDN: the WebAssembly engine ships with this site.
  const manifest = await (await fetch(vendor + 'ort/manifest.json')).json();
  const flavor = manifest[cfg.flavor] ? cfg.flavor : 'plain';
  const m = manifest[flavor];
  const binary = await fetchParts(vendor + 'ort/' + flavor + '/', m.parts, m.size, 'engine');
  const wasm = env.backends.onnx.wasm;
  wasm.wasmPaths = { mjs: new URL(vendor + 'ort/' + m.mjs, self.location.href).href };
  wasm.wasmBinary = binary;
  wasm.numThreads = 1;           // GitHub Pages is not cross-origin isolated
  wasm.proxy = false;
  return { ok: true, flavor };
}

async function loadPhonemizer() {
  if (phonemizeFn) return;
  const mod = await import(cfg.base + 'vendor/phonemizer/phonemizer.js');
  phonemizeFn = mod.phonemize;
}


// Some quantized model files trip a graph optimisation in this ONNX Runtime build
// ("Can't create a session"). When that happens, try again with lighter optimisation.
async function withSessionFallback(load) {
  const levels = [null, 'basic', 'disabled'];
  let lastErr = null;
  for (const level of levels) {
    try { return await load(level ? { graphOptimizationLevel: level } : undefined); }
    catch (err) {
      lastErr = err;
      const msg = String((err && err.message) || err);
      if (!/create a session|TransposeDQ|qdq|Missing required scale/i.test(msg)) throw err;
    }
  }
  throw lastErr;
}

// ---------- Kokoro ----------
const PUNCT = ';:,.!?¡¿—…"«»“”(){}[]';
const PUNCT_RE = new RegExp('(\\s*[' + PUNCT.replace(/[\]\[\\^-]/g, '\\$&') + ']+\\s*)+', 'g');

function normalizeForSpeech(text) {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/https?:\/\/\S+/g, ' link ')
    .replace(/\bDr\.(?=\s+[A-Z])/g, 'Doctor')
    .replace(/\bMr\.(?=\s)/g, 'Mister')
    .replace(/\bMrs\.(?=\s)/g, 'Missus')
    .replace(/\bMs\.(?=\s)/g, 'Miz')
    .replace(/\bvs\.(?=\s)/gi, 'versus')
    .replace(/\be\.g\.(?=\s)/gi, 'for example')
    .replace(/\bi\.e\.(?=\s)/gi, 'that is')
    .replace(/\betc\.(?=\s|$)/gi, 'et cetera')
    .replace(/&/g, ' and ')
    .replace(/(\d),(?=\d{3}\b)/g, '$1')
    .replace(/[\u2013]/g, '-')
    .replace(/[*_#`~^<>|\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function phonemize(text, lang) {
  await loadPhonemizer();
  const espeakLang = lang === 'b' ? 'en' : 'en-us';
  text = normalizeForSpeech(text);
  const pieces = [];
  let last = 0;
  for (const m of text.matchAll(PUNCT_RE)) {
    if (m.index > last) pieces.push({ punct: false, text: text.slice(last, m.index) });
    pieces.push({ punct: true, text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) pieces.push({ punct: false, text: text.slice(last) });
  const out = [];
  for (const p of pieces) {
    if (p.punct) { out.push(p.text); continue; }
    if (!p.text.trim()) { out.push(p.text); continue; }
    const ipa = await phonemizeFn(p.text, espeakLang);
    out.push(ipa.join(' '));
  }
  let ps = out.join('');
  ps = ps
    .replace(/kəkˈoːɹoʊ/g, 'kˈoʊkəɹoʊ')
    .replace(/kəkˈɔːɹəʊ/g, 'kˈəʊkəɹəʊ')
    .replace(/ʲ/g, 'j')
    .replace(/r/g, 'ɹ')
    .replace(/x/g, 'k')
    .replace(/ɬ/g, 'l')
    .replace(/([a-zɹː])(hˈʌndɹɪd)/g, '$1 $2')
    .replace(/ z(?=[;:,.!?¡¿—…"«»“” ]|$)/g, 'z');
  if (lang !== 'b') ps = ps.replace(/(nˈaɪn)ti(?!ː)/g, '$1di');
  return ps.trim();
}

async function loadVoice(voice) {
  if (voiceCache.has(voice)) return voiceCache.get(voice);
  const url = cfg.remoteHost + KOKORO_ID + '/resolve/main/voices/' + voice + '.bin';
  let res = null, cache = null;
  try { cache = await caches.open('earshot-voices-v1'); res = await cache.match(url); } catch (e) { cache = null; }
  if (!res) {
    res = await fetch(url);
    if (!res.ok) throw new Error('Could not download the voice "' + voice + '".');
    if (cache) { try { await cache.put(url, res.clone()); } catch (e) { /* storage full: still works */ } }
  }
  const data = new Float32Array(await res.arrayBuffer());
  voiceCache.set(voice, data);
  return data;
}

async function loadTTS(opts) {
  if (models.tts) return;
  const prog = progressHandler('tts');
  const dtype = opts.dtype || 'q8';
  const [tokenizer, model] = await Promise.all([
    T.AutoTokenizer.from_pretrained(KOKORO_ID, { progress_callback: prog }),
    withSessionFallback((so) => T.StyleTextToSpeech2Model.from_pretrained(KOKORO_ID, { dtype, device: cfg.device, progress_callback: prog, ...(so ? { session_options: so } : {}) })),
  ]);
  await loadPhonemizer();
  await loadVoice(opts.voice || 'af_heart');
  models.tts = { tokenizer, model };
}

// Kokoro handles up to 510 phoneme tokens. Split long text into safe pieces.
function splitForKokoro(ps) {
  const MAX = 400;
  if (ps.length <= MAX) return [ps];
  const parts = [];
  let rest = ps;
  while (rest.length > MAX) {
    let cut = -1;
    for (const ch of ['.', '!', '?', ';', ':', ',', ' ']) {
      const i = rest.lastIndexOf(ch, MAX);
      if (i > MAX * 0.4) { cut = i + 1; break; }
    }
    if (cut < 1) cut = MAX;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut);
  }
  if (rest.trim()) parts.push(rest.trim());
  return parts;
}

async function speak({ text, voice, speed }) {
  if (!models.tts) throw new Error('Neural voice is not loaded yet.');
  const lang = (voice || 'a')[0] === 'b' ? 'b' : 'a';
  const ps = await phonemize(text, lang);
  if (!ps) return new Float32Array(0);
  const style = await loadVoice(voice || 'af_heart');
  const chunks = [];
  for (const piece of splitForKokoro(ps)) {
    const { input_ids } = models.tts.tokenizer(piece, { truncation: true });
    const n = Math.min(Math.max(input_ids.dims[input_ids.dims.length - 1] - 2, 0), 509);
    const offset = n * STYLE_DIM;
    const styleVec = style.slice(offset, offset + STYLE_DIM);
    const out = await models.tts.model({
      input_ids,
      style: new T.Tensor('float32', styleVec, [1, STYLE_DIM]),
      speed: new T.Tensor('float32', [Math.max(0.5, Math.min(2, speed || 1))], [1]),
    });
    chunks.push(out.waveform.data);
  }
  let len = 0; for (const c of chunks) len += c.length;
  const audio = new Float32Array(len);
  let o = 0; for (const c of chunks) { audio.set(c, o); o += c.length; }
  return audio;
}

// ---------- Whisper ----------
// The 8-bit merged decoders fail to start in this ONNX Runtime build (tied embedding weights),
// so the decoder runs in fp16 and the encoder in 8-bit. Tested with a tiny Whisper on WebAssembly.
const WHISPER_DTYPE = { encoder_model: 'q8', decoder_model_merged: 'fp16' };
async function loadSTT(opts) {
  if (models.stt && models.stt.id === opts.model) return;
  const prog = progressHandler('stt');
  const pipe = await withSessionFallback((so) => T.pipeline('automatic-speech-recognition', opts.model, {
    dtype: opts.dtype || WHISPER_DTYPE, device: cfg.device, progress_callback: prog, ...(so ? { session_options: so } : {}),
  }));
  models.stt = { id: opts.model, pipe };
}

async function transcribe({ audio }) {
  if (!models.stt) throw new Error('Whisper is not loaded yet.');
  const out = await models.stt.pipe(audio, { chunk_length_s: 30, stride_length_s: 5, max_new_tokens: 128 });
  const text = Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text;
  return (text || '').trim();
}

// ---------- Embeddings (smarter matching) ----------
async function loadEmbed(opts) {
  if (models.embed) return;
  const prog = progressHandler('embed');
  models.embed = await withSessionFallback((so) => T.pipeline('feature-extraction', opts.model, {
    dtype: opts.dtype || 'q8', device: cfg.device, progress_callback: prog, ...(so ? { session_options: so } : {}),
  }));
}

async function embed({ texts }) {
  if (!models.embed) throw new Error('Smarter matching is not loaded yet.');
  const vectors = [];
  const BATCH = 16;
  for (let i = 0; i < texts.length; i += BATCH) {
    const out = await models.embed(texts.slice(i, i + BATCH), { pooling: 'mean', normalize: true });
    for (const v of out.tolist()) vectors.push(v);
    if (texts.length > BATCH) post({ type: 'progress', what: 'index', loaded: Math.min(i + BATCH, texts.length), total: texts.length, file: 'index' });
  }
  return vectors;
}

// ---------- Small language model (answers in its own words) ----------
async function loadLLM(opts) {
  if (models.llm) return;
  const prog = progressHandler('llm');
  models.llm = await withSessionFallback((so) => T.pipeline('text-generation', opts.model, {
    dtype: opts.dtype || 'q4', device: opts.device || 'webgpu', progress_callback: prog, ...(so ? { session_options: so } : {}),
  }));
}

async function generate({ messages, max_new_tokens }) {
  if (!models.llm) throw new Error('The answer model is not loaded yet.');
  const opts = { max_new_tokens: max_new_tokens || 160, do_sample: false };
  let out;
  try {
    out = await models.llm(messages, opts);
  } catch (err) {
    if (!/chat_template/i.test(String(err && err.message))) throw err;
    // No chat template on this model: fall back to a plain prompt.
    const prompt = messages.map((m) => (m.role === 'system' ? 'Instructions: ' : m.role === 'user' ? 'User: ' : 'Assistant: ') + m.content).join('\n\n') + '\n\nAssistant:';
    out = await models.llm(prompt, { ...opts, return_full_text: false });
  }
  const gen = out[0].generated_text;
  if (Array.isArray(gen)) { const last = gen[gen.length - 1]; return (last && last.content || '').trim(); }
  return String(gen || '').trim();
}

const handlers = {
  init: (m) => init(m.options),
  load: async (m) => {
    if (m.what === 'tts') await loadTTS(m.options || {});
    else if (m.what === 'stt') await loadSTT(m.options || {});
    else if (m.what === 'embed') await loadEmbed(m.options || {});
    else if (m.what === 'llm') await loadLLM(m.options || {});
    return { loaded: m.what };
  },
  speak: async (m) => { const audio = await speak(m); return { audio, sampleRate: SAMPLE_RATE, __transfer: [audio.buffer] }; },
  phonemize: async (m) => ({ phonemes: await phonemize(m.text, m.lang) }),
  transcribe: async (m) => ({ text: await transcribe(m) }),
  embed: async (m) => ({ vectors: await embed(m) }),
  generate: async (m) => ({ text: await generate(m) }),
  status: async () => ({ loaded: Object.keys(models) }),
};

self.onmessage = async (e) => {
  const m = e.data || {};
  const h = handlers[m.type];
  if (!h) { post({ type: 'result', id: m.id, error: 'Unknown request ' + m.type }); return; }
  try {
    const res = await h(m) || {};
    const transfer = res.__transfer; delete res.__transfer;
    post({ type: 'result', id: m.id, ...res }, transfer);
  } catch (err) {
    post({ type: 'result', id: m.id, error: (err && err.message) || String(err) });
  }
};
