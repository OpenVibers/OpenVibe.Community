'use strict';

/**
 * A small, safe Markdown renderer for forum posts and Markdown pastes.
 *
 * Safety model: the source is never trusted as HTML. Every piece of text is HTML-escaped first;
 * the only tags in the output are the fixed ones this file writes (p, br, h3–h6, blockquote,
 * ul/ol/li, hr, pre/code, strong, em, del, a, table/thead/tbody/tr/th/td in a scrolling div).
 * Raw HTML in a post is shown as text. Links keep only http(s), mailto, same-site paths and
 * #fragments, and carry rel="nofollow ugc noopener". Fenced code blocks go through the same
 * highlight.js wrapper pastes use (which escapes).
 *
 * Supported: paragraphs (single newlines are line breaks), # headings (demoted two levels so
 * the page keeps one h1), > quotes, - / * / + and 1. lists (nested by indenting, MAX_DEPTH deep),
 * ---, ``` fences with an optional language, | pipe | tables | with :--: alignment, `code`,
 * **bold**, __bold__, *em*, _em_, ~~strike~~, [text](url) and bare https:// links. No images,
 * footnotes or raw HTML.
 */
const { escapeHtml: esc, highlight } = require('./highlight');

const MAX_SOURCE = 100_000;
const MAX_QUOTE_DEPTH = 3;
// Quotes and lists nest inside each other this deep; anything deeper is shown as text.
const MAX_DEPTH = 4;
const MAX_TABLE_ROWS = 1000;
const MAX_TABLE_COLS = 64;
// Every pattern here runs on untrusted text on each page view, so none may backtrack
// super-linearly: trailing whitespace/#s are trimmed in code, not by competing \s* groups.
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]{0,32})$/;
const FENCE = { test: (line) => FENCE_RE.test(line.trimEnd()) };
const HEADING_RE = /^ {0,3}(#{1,6})\s+([\s\S]*)$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const HR = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
const UL = /^ {0,3}[-*+]\s+(.*)$/;
const OL = /^ {0,3}(\d{1,9})[.)]\s+(.*)$/;
const SAFE_URL = /^(https?:\/\/|mailto:|\/(?![/\\])|#)/i;

/** [, hashes, text] for an ATX heading (text without the optional closing #s), or null. */
function headingMatch(line) {
    const m = line.match(HEADING_RE);
    if (!m) return null;
    const text = m[2].trimEnd().replace(/#+$/, '').trimEnd();
    return /[\u2028\u2029]/.test(text) ? null : [m[0], m[1], text];
}
const HEADING = { test: (line) => headingMatch(line) !== null };

/**
 * Same result as s.replace(/<open>([\s\S]*?\S)<close>/g, …) for a delimiter pair, in linear time:
 * the lazy regex rescans to the end of the text for every opener that has no closer (quadratic).
 * Content runs from the end of an opener to the first closer after it; once one opener finds no
 * closer, no later opener can either, so the scan stops.
 */
function pairUp(s, open, close, wrap) {
    const o = new RegExp(open.source, 'g');
    const c = new RegExp(close.source, 'g');
    let out = '';
    let pos = 0;
    for (;;) {
        o.lastIndex = pos;
        const m = o.exec(s);
        if (!m) break;
        const start = m.index + m[0].length;
        c.lastIndex = start;
        const k = c.exec(s);
        if (!k) break;
        const end = k.index + 1; // the closer pattern starts with the content's last (non-space) character
        out += s.slice(pos, m.index) + wrap(m, s.slice(start, end));
        pos = k.index + k[0].length;
    }
    return out + s.slice(pos);
}

/**
 * Same result as s.replace(/(`+)([^`\n]|[^`\n][\s\S]*?[^`\n])\1(?!`)/g, …) in O(n log n): an opener
 * is the tail of a backtick run (longest first, as the regex tries it), its closer the next whole
 * run of exactly that length not preceded by a newline, with non-empty content not starting with one.
 */
function codeSpans(s, onCode) {
    const runs = [];
    const byLen = new Map();
    const re = /`+/g;
    let m;
    while ((m = re.exec(s))) {
        runs.push([m.index, m[0].length]);
        if (s[m.index - 1] !== '\n') {
            if (!byLen.has(m[0].length)) byLen.set(m[0].length, []);
            byLen.get(m[0].length).push(m.index);
        }
    }
    const nextAt = (list, from) => {
        let lo = 0;
        let hi = list.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid] < from) lo = mid + 1; else hi = mid; }
        return lo < list.length ? list[lo] : -1;
    };
    let out = '';
    let pos = 0;
    for (const [at, len] of runs) {
        if (at < pos) continue;
        const contentStart = at + len;
        if (contentStart >= s.length || s[contentStart] === '\n') continue;
        for (let n = len; n >= 1; n--) {
            const list = byLen.get(n);
            const close = list ? nextAt(list, contentStart + 1) : -1;
            if (close < 0) continue;
            out += s.slice(pos, at + len - n) + onCode(s.slice(contentStart, close));
            pos = close + n;
            break;
        }
    }
    return out + s.slice(pos);
}

function unescapeEntities(s) {
    return s.replace(/&(amp|lt|gt|quot|#39);/g, (_m, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[e]));
}

/** Inline formatting over one block's text (raw, unescaped in; safe HTML out). */
function inline(raw) {
    const slots = [];
    const hold = (html) => `\u0000${slots.push(html) - 1}\u0000`;
    // 1. code spans keep their content literal
    let s = codeSpans(String(raw), (code) => hold(`<code>${esc(code)}</code>`));
    // 2. everything else is escaped before any tag is written
    s = esc(s);
    // 3. [text](url) — only safe schemes; the rest stays as text
    s = s.replace(/\[([^\]\n]{1,300})\]\(([^\s()]{1,2000})\)/g, (m, text, url) => {
        if (!SAFE_URL.test(unescapeEntities(url))) return m;
        return hold(`<a href="${url}" rel="nofollow ugc noopener">${emphasis(text)}</a>`);
    });
    // 4. bare links
    s = s.replace(/\bhttps?:\/\/[^\s<>\u0000]+/gi, (m) => {
        let url = m, tail = '';
        while (/[.,;:!?)\]'"]$/.test(url) || /&(quot|#39|gt|lt);$/.test(url)) {
            const ent = url.match(/&(quot|#39|gt|lt);$/);
            const cut = ent ? ent[0].length : 1;
            tail = url.slice(-cut) + tail; url = url.slice(0, -cut);
        }
        return url.length > 8 ? hold(`<a href="${url}" rel="nofollow ugc noopener">${url}</a>`) + tail : m;
    });
    s = emphasis(s);
    s = s.replace(/\n/g, '<br>\n');
    // Restore held pieces (a link's text may itself hold a code span).
    for (let i = 0; i < 3 && s.includes('\u0000'); i++) s = s.replace(/\u0000(\d+)\u0000/g, (_m, n) => slots[Number(n)] || '');
    return s;
}

/** Bold / italic / strike over already-escaped text. */
function emphasis(s) {
    s = pairUp(s, /\*\*(?=\S)/, /\S\*\*/, (_m, t) => `<strong>${t}</strong>`);
    s = pairUp(s, /(^|[^\w])__(?=\S)/, /\S__(?!\w)/, (m, t) => `${m[1]}<strong>${t}</strong>`);
    s = s
        .replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![*\w])/g, '$1<em>$2</em>')
        .replace(/(^|[^\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/g, '$1<em>$2</em>');
    return pairUp(s, /~~(?=\S)/, /\S~~/, (_m, t) => `<del>${t}</del>`);
}

function isBlockStart(line) {
    return FENCE.test(line) || HEADING.test(line) || QUOTE.test(line) || HR.test(line) || UL.test(line) || OL.test(line);
}

/** Leading whitespace as columns (a tab counts 4). */
function indentOf(line) {
    let n = 0;
    for (const ch of line) {
        if (ch === ' ') n++;
        else if (ch === '\t') n += 4;
        else break;
    }
    return n;
}

/** A table row's cells: split on pipes not escaped as \|, one optional outer pipe each side. */
function rowCells(line) {
    let t = line.trim();
    if (t.startsWith('|')) t = t.slice(1);
    if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
    const cells = [];
    let cur = '';
    for (let k = 0; k < t.length; k++) {
        if (t[k] === '\\' && t[k + 1] === '|') { cur += '|'; k++; continue; }
        if (t[k] === '|') { cells.push(cur.trim()); cur = ''; continue; }
        cur += t[k];
    }
    cells.push(cur.trim());
    return cells;
}

/** The alignments of a table's delimiter row (| --- | :-: | --: |), or null when the line is not one. */
function delimiterRow(line) {
    if (!line || !line.includes('|') || !/^[\s|:-]+$/.test(line)) return null;
    const cells = rowCells(line);
    const aligns = [];
    for (const c of cells) {
        if (!/^:?-+:?$/.test(c)) return null;
        aligns.push(c.startsWith(':') && c.endsWith(':') ? 'c' : c.endsWith(':') ? 'r' : c.startsWith(':') ? 'l' : '');
    }
    return aligns;
}

/** A pipe table starting at lines[i]: a header row whose cells match the delimiter row under it. */
function tableAt(lines, i) {
    if (!lines[i].includes('|')) return null;
    const aligns = delimiterRow(lines[i + 1]);
    if (!aligns || aligns.length > MAX_TABLE_COLS) return null;
    const head = rowCells(lines[i]);
    return head.length === aligns.length ? { head, aligns } : null;
}

function blocks(lines, depth, level = (n) => n + 2) {
    const out = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        if (!line.trim()) { i++; continue; }

        let m = line.trimEnd().match(FENCE_RE);
        if (m) {
            const fence = m[1], lang = m[2];
            const closing = new RegExp(`^ {0,3}\\${fence[0]}{${fence.length},}\\s*$`);
            const body = [];
            i++;
            while (i < lines.length && !closing.test(lines[i])) body.push(lines[i++]);
            i++; // closing fence (or end of input)
            const code = body.join('\n');
            const hl = lang ? highlight(code, lang) : { html: esc(code), language: 'plaintext' };
            out.push(`<pre class="md-code"><code class="hljs language-${esc(hl.language)}">${hl.html}</code></pre>`);
            continue;
        }
        if (HR.test(line)) { out.push('<hr>'); i++; continue; }
        m = headingMatch(line);
        if (m) { const h = Math.min(level(m[1].length), 6); out.push(`<h${h}>${inline(m[2])}</h${h}>`); i++; continue; }
        const table = tableAt(lines, i);
        if (table) {
            const { head, aligns } = table;
            const rows = [];
            i += 2;
            while (i < lines.length && lines[i].trim() && lines[i].includes('|') && !isBlockStart(lines[i]) && rows.length < MAX_TABLE_ROWS) rows.push(rowCells(lines[i++]));
            const cell = (tag, text, a) => `<${tag}${a ? ` class="al-${a}"` : ''}>${inline(text || '')}</${tag}>`;
            // A wide table scrolls inside its own box on a phone, so it is a labelled region keyboard users can reach.
            out.push(`<div class="md-table" tabindex="0" role="region" aria-label="Table"><table><thead><tr>${head.map((h, k) => cell('th', h, aligns[k])).join('')}</tr></thead>`
                + `<tbody>${rows.map((r) => `<tr>${aligns.map((a, k) => cell('td', r[k], a)).join('')}</tr>`).join('')}</tbody></table></div>`);
            continue;
        }
        if (QUOTE.test(line)) {
            const inner = [];
            while (i < lines.length && lines[i].trim() && QUOTE.test(lines[i])) inner.push(lines[i++].match(QUOTE)[1]);
            out.push(depth < MAX_QUOTE_DEPTH ? `<blockquote>${blocks(inner, depth + 1, level)}</blockquote>` : `<blockquote><p>${inline(inner.join('\n'))}</p></blockquote>`);
            continue;
        }
        if (UL.test(line) || OL.test(line)) {
            const ordered = !UL.test(line);
            const re = ordered ? OL : UL;
            const start = ordered ? parseInt(line.match(OL)[1], 10) : 1;
            const base = indentOf(line);
            // Each item: its own text, then what is indented under it from the first nested block on (a list, a fence,
            // a quote), rendered as blocks of its own.
            const items = [];
            while (i < lines.length && lines[i].trim()) {
                const l = lines[i];
                const ind = indentOf(l);
                const mm = ind < base + 2 ? l.match(re) : null;
                if (mm) {
                    const text = ordered ? mm[2] : mm[1];
                    items.push({ head: [text], sub: [], at: l.length - text.length });
                } else if (ind >= base + 2 && items.length) {
                    const it = items[items.length - 1];
                    const under = ' '.repeat(Math.max(0, ind - it.at)) + l.trim();
                    if (it.sub.length || isBlockStart(under)) it.sub.push(under);
                    else it.head.push(l.trim());
                } else break;
                i++;
            }
            const tag = ordered ? 'ol' : 'ul';
            const sub = (lines2) => (depth < MAX_DEPTH ? blocks(lines2, depth + 1, level) : `<p>${inline(lines2.map((x) => x.trim()).join('\n'))}</p>`);
            out.push(`<${tag}${ordered && start !== 1 ? ` start="${start}"` : ''}>${items.map((it) => `<li>${inline(it.head.join('\n'))}${it.sub.length ? sub(it.sub) : ''}</li>`).join('')}</${tag}>`);
            continue;
        }
        const para = [];
        while (i < lines.length && lines[i].trim() && (!para.length || (!isBlockStart(lines[i]) && !tableAt(lines, i)))) para.push(lines[i++]);
        out.push(`<p>${inline(para.join('\n'))}</p>`);
    }
    return out.join('\n');
}

/**
 * Markdown source → safe HTML (see the header for what is supported). headingShift demotes headings: 2 for a forum post
 * (# → h3, under the thread's h1 and the post's h2), 1 for a document that is the page's main content (# → h2).
 * document: the levels the source uses are numbered in order from there, so a # followed by ### reads h2 then h3
 * and the outline never skips a level (axe heading-order).
 */
function renderMarkdown(source, { headingShift = 2, document = false } = {}) {
    const text = String(source == null ? '' : source).slice(0, MAX_SOURCE).replace(/\u0000/g, '').replace(/\r\n?/g, '\n');
    const lines = text.split('\n');
    const shift = Math.max(1, Math.min(4, headingShift));
    let level = (n) => n + shift;
    if (document) {
        const used = new Set();
        let fence = null;
        for (const line of lines) {
            const f = line.trimEnd().match(FENCE_RE);
            if (f && (!fence || f[1][0] === fence[0])) { fence = fence ? null : f[1]; continue; }
            if (fence) continue;
            const m = headingMatch(line);
            if (m) used.add(m[1].length);
        }
        const rank = new Map([...used].sort((a, b) => a - b).map((n, k) => [n, k]));
        level = (n) => shift + 1 + (rank.has(n) ? rank.get(n) : n - 1);
    }
    return blocks(lines, 0, level);
}

/** Markdown source → plain text (descriptions, JSON-LD, feeds). The caller escapes it. */
function markdownToText(source, max = 300) {
    const t = String(source == null ? '' : source).replace(/\u0000/g, '')
        .split('\n').filter((l) => !(l.includes('|') && /^[\s|:-]+$/.test(l))).join('\n') // table delimiter rows
        .replace(/^ {0,3}\|/gm, '')
        .replace(/^ {0,3}(`{3,}|~{3,}).*$/gm, '')
        .replace(/\[([^[\]\n]*)\]\([^)\s]*\)/g, '$1')
        .replace(/^ {0,3}(#{1,6}|>|[-*+]|\d{1,9}[.)])\s+/gm, '')
        .replace(/(\*\*|__|~~|`)/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

module.exports = { renderMarkdown, markdownToText };
