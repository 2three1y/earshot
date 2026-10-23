// Earshot text tools: turn pasted text, Markdown, HTML or a web page into
// a clean list of paragraphs and sentences that can be read aloud.

const ABBREV = ['mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'e.g', 'i.e', 'inc', 'ltd', 'co', 'mt', 'no', 'fig', 'approx', 'dept', 'est', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec', 'u.s', 'u.k'];

export function splitSentences(text) {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return [];
  const out = [];
  let start = 0;
  const re = /([.!?…]+)(["'”’)\]]*)\s+(?=["'“‘(\[]?[A-Z0-9])/g;
  let m;
  while ((m = re.exec(t))) {
    const end = m.index + m[1].length + m[2].length;
    const before = t.slice(start, m.index);
    const lastWord = (before.split(' ').pop() || '').toLowerCase().replace(/^[("'“‘\[]+/, '');
    if (m[1] === '.' && (ABBREV.includes(lastWord) || /^[a-z]$/i.test(lastWord))) continue;
    out.push(t.slice(start, end).trim());
    start = end;
  }
  if (start < t.length) out.push(t.slice(start).trim());
  // Very long "sentences" (lists, code, no punctuation) are split so each chunk stays speakable.
  const final = [];
  for (const s of out) {
    if (s.length <= 320) { final.push(s); continue; }
    let rest = s;
    while (rest.length > 320) {
      let cut = -1;
      for (const ch of [';', ':', ',', ' — ', ' - ', ' ']) {
        const i = rest.lastIndexOf(ch, 300);
        if (i > 120) { cut = i + ch.length; break; }
      }
      if (cut < 1) cut = 300;
      final.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) final.push(rest);
  }
  return final.filter(Boolean);
}

export function plainToBlocks(text) {
  const norm = text.replace(/\r\n?/g, '\n');
  const raw = norm.split(/\n\s*\n+/);
  const blocks = [];
  for (const chunk of raw) {
    const lines = chunk.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    // Keep list-like lines as separate paragraphs; join wrapped prose lines.
    const listy = lines.filter((l) => /^([-*•]|\d+[.)])\s/.test(l)).length >= Math.max(2, lines.length / 2);
    if (listy) { for (const l of lines) blocks.push({ kind: 'p', text: l.replace(/^([-*•])\s+/, '') }); }
    else blocks.push({ kind: 'p', text: lines.join(' ') });
  }
  return blocks;
}

export function markdownToBlocks(md) {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let para = [];
  let inCode = false;
  const flush = () => { if (para.length) { blocks.push({ kind: 'p', text: cleanInline(para.join(' ')) }); para = []; } };
  for (let line of lines) {
    if (/^\s*(```|~~~)/.test(line)) { flush(); inCode = !inCode; if (inCode) blocks.push({ kind: 'p', text: 'Code block.' }); continue; }
    if (inCode) continue;
    if (/^\s*$/.test(line)) { flush(); continue; }
    const h = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) { flush(); blocks.push({ kind: 'h', level: h[1].length, text: cleanInline(h[2]) }); continue; }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); continue; }
    if (/^\s*\|?\s*:?-{3,}/.test(line)) continue; // table separator rows
    const li = line.match(/^\s*([-*+]|\d+[.)])\s+(.*)$/);
    if (li) { flush(); blocks.push({ kind: 'p', text: cleanInline(li[2]) }); continue; }
    const bq = line.match(/^\s*>\s?(.*)$/);
    if (bq) line = bq[1];
    if (/^\s*\|/.test(line)) { flush(); blocks.push({ kind: 'p', text: cleanInline(line.split('|').map((c) => c.trim()).filter(Boolean).join(', ')) }); continue; }
    para.push(line.trim());
  }
  flush();
  return blocks.filter((b) => b.text);
}

function cleanInline(s) {
  return s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (m, alt) => (alt ? 'Image: ' + alt : ''))
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(\S.*?\S|\S)\1/g, '$2')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'IFRAME', 'NAV', 'FOOTER', 'ASIDE', 'FORM', 'BUTTON', 'SELECT', 'INPUT', 'TEXTAREA', 'HEAD']);
const BLOCK_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE', 'PRE', 'TD', 'TH', 'DT', 'DD', 'FIGCAPTION', 'CAPTION', 'SUMMARY']);

export function htmlToDoc(html, fallbackTitle) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  let title = (doc.querySelector('meta[property="og:title"]')?.getAttribute('content') || doc.title || '').trim();
  // Prefer the main content when the page marks it.
  const root = doc.querySelector('main, article, [role="main"], #content, #mw-content-text, .markdown-body') || doc.body || doc.documentElement;
  root.querySelectorAll('.mw-editsection, .reference, .navbox, .infobox, .sidebar, .hatnote, .mw-jump-link, sup.reference, [aria-hidden="true"], [hidden]').forEach((n) => n.remove());
  const blocks = [];
  const walk = (el) => {
    for (const node of el.children) {
      if (SKIP_TAGS.has(node.tagName)) continue;
      if (/^H[1-6]$/.test(node.tagName)) {
        const t = node.textContent.replace(/\s+/g, ' ').trim();
        if (t) blocks.push({ kind: 'h', level: +node.tagName[1], text: t });
      } else if (BLOCK_TAGS.has(node.tagName)) {
        const hasBlockChild = [...node.children].some((c) => BLOCK_TAGS.has(c.tagName) || /^H[1-6]$/.test(c.tagName));
        if (hasBlockChild) { walk(node); continue; }
        const t = node.textContent.replace(/\s+/g, ' ').trim();
        if (t) blocks.push({ kind: 'p', text: t });
      } else if (node.tagName === 'IMG') {
        const alt = (node.getAttribute('alt') || '').trim();
        if (alt) blocks.push({ kind: 'p', text: 'Image: ' + alt });
      } else if (node.children.length) {
        walk(node);
      } else {
        const t = node.textContent.replace(/\s+/g, ' ').trim();
        if (t && t.length > 1) blocks.push({ kind: 'p', text: t });
      }
    }
  };
  walk(root);
  if (!blocks.length) {
    const t = (root.textContent || '').trim();
    if (t) blocks.push(...plainToBlocks(t));
  }
  if (!title) { const h = blocks.find((b) => b.kind === 'h'); title = h ? h.text : (fallbackTitle || 'Web page'); }
  return { title, blocks };
}

export function buildDoc(title, blocks) {
  const paragraphs = [];
  const sentences = [];
  for (const b of blocks) {
    const ss = b.kind === 'h' ? [b.text.replace(/\s+/g, ' ').trim()] : splitSentences(b.text);
    if (!ss.length) continue;
    const pi = paragraphs.length;
    const first = sentences.length;
    for (const s of ss) sentences.push({ text: s, p: pi });
    paragraphs.push({ kind: b.kind, level: b.level || 0, text: ss.join(' '), first, count: ss.length });
  }
  const words = sentences.reduce((n, s) => n + s.text.split(/\s+/).length, 0);
  return { title: (title || 'Untitled').trim().slice(0, 200), paragraphs, sentences, words };
}

export function docFromText(text, name) {
  const n = (name || '').toLowerCase();
  if (/\.(html?|xhtml)$/.test(n) || /^\s*<(!doctype|html|body|article|div|p)\b/i.test(text)) {
    const d = htmlToDoc(text, name);
    return buildDoc(d.title, d.blocks);
  }
  if (/\.(md|markdown|mdown)$/.test(n) || (!/\.txt$/.test(n) && looksLikeMarkdown(text))) {
    const blocks = markdownToBlocks(text);
    const h = blocks.find((b) => b.kind === 'h');
    return buildDoc(name ? stripExt(name) : (h ? h.text : 'Pasted text'), blocks);
  }
  const blocks = plainToBlocks(text);
  const firstLine = (text.trim().split('\n')[0] || '').trim();
  const title = name ? stripExt(name) : (firstLine.length && firstLine.length < 80 ? firstLine : 'Pasted text');
  return buildDoc(title, blocks);
}

function looksLikeMarkdown(t) {
  let score = 0;
  if (/^\s{0,3}#{1,6}\s/m.test(t)) score += 2;
  if (/\[[^\]]+\]\([^)]+\)/.test(t)) score += 1;
  if (/^\s*```/m.test(t)) score += 2;
  if (/(\*\*|__)[^*_]+\1/.test(t)) score += 1;
  return score >= 2;
}

function stripExt(n) { return n.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ').trim() || n; }

// Rewrite some well-known URLs to versions that allow cross-site reading (CORS).
export function corsFriendlyUrl(input) {
  let u;
  try { u = new URL(input); } catch (e) { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const wiki = u.hostname.match(/^([a-z\-]+)\.(m\.)?wikipedia\.org$/);
  if (wiki && u.pathname.startsWith('/wiki/')) {
    const title = u.pathname.slice(6);
    return { url: 'https://' + wiki[1] + '.wikipedia.org/api/rest_v1/page/html/' + title, kind: 'html', note: 'Wikipedia' };
  }
  if (u.hostname === 'github.com') {
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length === 2) return { url: 'https://api.github.com/repos/' + parts[0] + '/' + parts[1] + '/readme', kind: 'github-readme', note: 'GitHub README' };
    if (parts.length > 4 && parts[2] === 'blob') return { url: 'https://raw.githubusercontent.com/' + parts[0] + '/' + parts[1] + '/' + parts.slice(3).join('/'), kind: 'auto', note: 'GitHub file' };
  }
  return { url: u.href, kind: 'auto', note: '' };
}
