// Earshot passage finder: a small BM25 keyword search that runs on this device.
// It finds the passage that best matches a question; it never invents an answer.

const STOP = new Set('a an and are as at be been but by can could did do does for from had has have he her his how i if in into is it its me my not of on or our she so than that the their them then there these they this to too us was we were what when where which who whom why will with would you your about tell say said please read find show give passage part section text document article story'.split(' '));

export function tokenize(s) {
  return (s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').match(/[a-z0-9]+(?:'[a-z]+)?/g) || [])
    .map((w) => w.replace(/'s$/, ''))
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map(stem);
}

function stem(w) {
  if (w.length > 5 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

// Passages: windows of up to 3 sentences inside one paragraph, so answers are short enough to hear.
export function buildPassages(doc) {
  const passages = [];
  for (let pi = 0; pi < doc.paragraphs.length; pi++) {
    const p = doc.paragraphs[pi];
    for (let k = 0; k < p.count; k += 2) {
      const first = p.first + k;
      const last = Math.min(p.first + p.count - 1, first + 2);
      const text = doc.sentences.slice(first, last + 1).map((s) => s.text).join(' ');
      passages.push({ first, last, p: pi, text });
      if (last === p.first + p.count - 1) break;
    }
  }
  return passages;
}

export class PassageIndex {
  constructor(doc) {
    this.doc = doc;
    this.passages = buildPassages(doc);
    this.tf = [];
    this.df = new Map();
    let total = 0;
    for (const ps of this.passages) {
      const toks = tokenize(ps.text);
      total += toks.length;
      const m = new Map();
      for (const t of toks) m.set(t, (m.get(t) || 0) + 1);
      this.tf.push({ m, len: toks.length });
      for (const t of m.keys()) this.df.set(t, (this.df.get(t) || 0) + 1);
    }
    this.avg = this.passages.length ? total / this.passages.length : 1;
    this.vectors = null; // filled by smarter matching
  }

  keywordScores(query) {
    const q = tokenize(query);
    const N = this.passages.length;
    const k1 = 1.4, b = 0.75;
    const scores = new Float64Array(N);
    if (!q.length) return { scores, terms: q };
    for (let i = 0; i < N; i++) {
      const { m, len } = this.tf[i];
      let s = 0;
      for (const t of q) {
        const f = m.get(t);
        if (!f) continue;
        const df = this.df.get(t) || 0;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * len / this.avg));
      }
      scores[i] = s;
    }
    return { scores, terms: q };
  }

  search(query, { queryVector = null, limit = 5 } = {}) {
    const { scores, terms } = this.keywordScores(query);
    let combined = Array.from(scores);
    let mode = 'keywords';
    if (queryVector && this.vectors) {
      mode = 'meaning';
      const maxK = Math.max(...combined, 0) || 1;
      combined = combined.map((s, i) => {
        const v = this.vectors[i];
        let dot = 0; for (let j = 0; j < v.length; j++) dot += v[j] * queryVector[j];
        return 0.7 * dot + 0.3 * (s / maxK);
      });
    }
    const order = combined.map((s, i) => [s, i]).filter(([s]) => s > (mode === 'meaning' ? 0.15 : 0)).sort((a, b) => b[0] - a[0]);
    const seen = new Set();
    const results = [];
    for (const [score, i] of order) {
      const ps = this.passages[i];
      const key = ps.first;
      if (seen.has(key) || seen.has(key - 1) || seen.has(key + 1)) continue;
      seen.add(key);
      results.push({ ...ps, score });
      if (results.length >= limit) break;
    }
    return { results, terms, mode };
  }
}

// A quick extract (not an AI summary): the most representative sentences, in order.
export function extractSummary(doc, n = 3) {
  const sents = doc.sentences.filter((s) => doc.paragraphs[s.p].kind !== 'h');
  if (!sents.length) return [];
  const freq = new Map();
  for (const s of sents) for (const t of tokenize(s.text)) freq.set(t, (freq.get(t) || 0) + 1);
  const scored = sents.map((s, i) => {
    const toks = tokenize(s.text);
    const sc = toks.reduce((a, t) => a + (freq.get(t) || 0), 0) / Math.sqrt(toks.length + 4);
    return { i, s, sc: sc + (i < 3 ? 1.5 : 0) };
  });
  return scored.sort((a, b) => b.sc - a.sc).slice(0, n).sort((a, b) => a.i - b.i).map((x) => x.s.text);
}

export function topKeywords(doc, n = 6) {
  const freq = new Map();
  for (const s of doc.sentences) for (const t of tokenize(s.text)) if (t.length > 3) freq.set(t, (freq.get(t) || 0) + 1);
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([t]) => t);
}
