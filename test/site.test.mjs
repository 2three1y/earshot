import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(SITE, p), 'utf8');
const html = read('index.html');

test('page basics: title, one h1, viewport, landmarks, live region', () => {
  assert.match(html, /<title>Earshot[^<]+<\/title>/);
  assert.equal((html.match(/<h1[\s>]/g) || []).length, 1);
  assert.match(html, /name="viewport" content="width=device-width, initial-scale=1"/);
  assert.match(html, /<main id="main">/);
  assert.equal((html.match(/aria-live=/g) || []).length, 1, 'exactly one live region');
  assert.doesNotMatch(html, /<dl[\s>]|<table[\s>]|aria-actions|aria-describedby/);
});

test('core controls exist and are real buttons', () => {
  for (const id of ['btn-read', 'btn-pause', 'btn-stop', 'btn-talk', 'btn-load', 'btn-fetch', 'btn-sample']) {
    assert.match(html, new RegExp('<button type="(button|submit)" id="' + id + '"'), id);
  }
  assert.match(html, /<input type="range" id="speed"/);
  assert.match(html, /<select id="neural-voice">/);
  assert.match(html, /<select id="device-voice">/);
  assert.match(html, /id="engine-vo" value="vo"/);
});

test('every local asset referenced exists (no CDN at runtime)', () => {
  const refs = [...html.matchAll(/(?:src|href)="([^"#:]+)"/g)].map((m) => m[1]);
  for (const r of refs) assert.ok(existsSync(join(SITE, r)), 'missing ' + r);
  for (const f of ['js/app.js', 'js/worker.js', 'js/text.js', 'js/search.js', 'js/intents.js', 'js/data.js', 'sw.js']) {
    const src = read(f);
    assert.doesNotMatch(src, /cdn\.jsdelivr|unpkg\.com|cdnjs/, f + ' must not use a CDN');
  }
});

test('vendored speech engine parts add up to the manifest', () => {
  const m = JSON.parse(read('vendor/ort/manifest.json'));
  for (const flavor of ['plain', 'asyncify']) {
    const h = createHash('sha256'); let size = 0;
    for (const p of m[flavor].parts) { const b = readFileSync(join(SITE, 'vendor/ort', flavor, p)); h.update(b); size += b.length; assert.ok(b.length <= 1000000); }
    assert.equal(size, m[flavor].size, flavor + ' size');
    assert.equal(h.digest('hex'), m[flavor].sha256, flavor + ' hash');
    assert.ok(existsSync(join(SITE, 'vendor/ort', m[flavor].mjs)));
  }
});

test('no model weights are stored in the repo', () => {
  const files = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); e.isDirectory() ? walk(p) : files.push(p); } };
  walk(SITE);
  const weights = files.filter((f) => /\.(onnx|onnx_data|safetensors|gguf)$/.test(f) || (/\.bin$/.test(f) && !/vendor[\\/]ort[\\/]/.test(f)));
  assert.deepEqual(weights, []);
  const total = files.reduce((n, f) => n + statSync(f).size, 0);
  assert.ok(total < 45 * 1024 * 1024, 'site stays small: ' + total);
});

test('size warning and download consent are visible before loading', () => {
  assert.match(html, /id="size-warning"/);
  assert.match(html, /Use Wi-Fi/);
  const app = read('js/app.js');
  assert.match(app, /Download size: about/);
  assert.match(app, /quarter > lastSpoken/, 'progress announced only at quarters');
  assert.match(app, /btn-load'\)\.addEventListener\('click', loadModels\)/, 'models load only from the button');
});

test('credits and licenses present, no private names', () => {
  const credits = read('credits.html');
  for (const r of ['nico-martin/gemma4-browser-extension', 'pinguy/kokoro-tts-addon', 'openai/whisper', 'huggingface/distil-whisper', 'espeak-ng/espeak-ng']) assert.ok(credits.includes(r), r);
  for (const f of ['vendor/transformers/LICENSE', 'vendor/ort/LICENSE', 'vendor/phonemizer/LICENSE', 'vendor/phonemizer/ESPEAK-NG-COPYING']) assert.ok(statSync(join(SITE, f)).size > 500, f);
  const all = html + credits + read('js/app.js') + read('js/data.js');
  assert.doesNotMatch(all, /Hasan|Altameemi|Looscid|TODO|lorem ipsum/i);
  assert.match(html, /Carter \(2three1y\)/);
});
