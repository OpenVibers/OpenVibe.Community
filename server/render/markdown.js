'use strict';

/**
 * A small, safe Markdown renderer for forum posts.
 *
 * Safety model: the source is never trusted as HTML. Every piece of text is HTML-escaped first;
 * the only tags in the output are the fixed ones this file writes (p, br, h3–h6, blockquote,
 * ul/ol/li, hr, pre/code, strong, em, del, a). Raw HTML in a post is shown as text. Links keep
 * only http(s), mailto, same-site paths and #fragments, and carry rel="nofollow ugc noopener".
 * Fenced code blocks go through the same highlight.js wrapper pastes use (which escapes).
 *
 * Supported: paragraphs (single newlines are line breaks), # headings (demoted two levels so
 * the page keeps one h1), > quotes, - / * / + and 1. lists (one level), ---, ``` fences with an
 * optional language, `code`, **bold**, __bold__, *em*, _em_, ~~strike~~, [text](url) and bare
 * https:// links. No images, tables, footnotes or raw HTML.
 */
const { escapeHtml: esc, highlight } = require('./highlight');

const MAX_SOURCE = 100_000;
const MAX_QUOTE_DEPTH = 3;
const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]{0,32})\s*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const HR = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
const UL = /^ {0,3}[-*+]\s+(.*)$/;
const OL = /^ {0,3}(\d{1,9})[.)]\s+(.*)$/;
const SAFE_URL = /^(https?:\/\/|mailto:|\/(?![/\\])|#)/i;

function unescapeEntities(s) {
    return s.replace(/&(amp|lt|gt|quot|#39);/g, (_m, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[e]));
}

/** Inline formatting over one block's text (raw, unescaped in; safe HTML out). */
function inline(raw) {
    const slots = [];
    const hold = (html) => `\u0000${slots.push(html) - 1}\u0000`;
    // 1. code spans keep their content literal
    let s = String(raw).replace(/(`+)([^`\n]|[^`\n][\s\S]*?[^`\n])\1(?!`)/g, (_m, _t, code) => hold(`<code>${esc(code)}</code>`));
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
    return s
        .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1<strong>$2</strong>')
        .replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![*\w])/g, '$1<em>$2</em>')
        .replace(/(^|[^\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/g, '$1<em>$2</em>')
        .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
}

function isBlockStart(line) {
    return FENCE.test(line) || HEADING.test(line) || QUOTE.test(line) || HR.test(line) || UL.test(line) || OL.test(line);
}

function blocks(lines, depth) {
    const out = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        if (!line.trim()) { i++; continue; }

        let m = line.match(FENCE);
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
        m = line.match(HEADING);
        if (m) { const level = Math.min(m[1].length + 2, 6); out.push(`<h${level}>${inline(m[2])}</h${level}>`); i++; continue; }
        if (QUOTE.test(line)) {
            const inner = [];
            while (i < lines.length && lines[i].trim() && QUOTE.test(lines[i])) inner.push(lines[i++].match(QUOTE)[1]);
            out.push(depth < MAX_QUOTE_DEPTH ? `<blockquote>${blocks(inner, depth + 1)}</blockquote>` : `<blockquote><p>${inline(inner.join('\n'))}</p></blockquote>`);
            continue;
        }
        if (UL.test(line) || OL.test(line)) {
            const ordered = !UL.test(line);
            const re = ordered ? OL : UL;
            const start = ordered ? parseInt(line.match(OL)[1], 10) : 1;
            const items = [];
            while (i < lines.length && lines[i].trim()) {
                const mm = lines[i].match(re);
                if (mm) items.push(ordered ? mm[2] : mm[1]);
                else if (/^\s+\S/.test(lines[i]) && items.length) items[items.length - 1] += `\n${lines[i].trim()}`;
                else break;
                i++;
            }
            const tag = ordered ? 'ol' : 'ul';
            out.push(`<${tag}${ordered && start !== 1 ? ` start="${start}"` : ''}>${items.map((it) => `<li>${inline(it)}</li>`).join('')}</${tag}>`);
            continue;
        }
        const para = [];
        while (i < lines.length && lines[i].trim() && (!para.length || !isBlockStart(lines[i]))) para.push(lines[i++]);
        out.push(`<p>${inline(para.join('\n'))}</p>`);
    }
    return out.join('\n');
}

/** Markdown source → safe HTML (see the header for what is supported). */
function renderMarkdown(source) {
    const text = String(source == null ? '' : source).slice(0, MAX_SOURCE).replace(/\u0000/g, '').replace(/\r\n?/g, '\n');
    return blocks(text.split('\n'), 0);
}

/** Markdown source → plain text (descriptions, JSON-LD, feeds). The caller escapes it. */
function markdownToText(source, max = 300) {
    const t = String(source == null ? '' : source).replace(/\u0000/g, '')
        .replace(/^ {0,3}(`{3,}|~{3,}).*$/gm, '')
        .replace(/\[([^\]\n]*)\]\([^)\s]*\)/g, '$1')
        .replace(/^ {0,3}(#{1,6}|>|[-*+]|\d{1,9}[.)])\s+/gm, '')
        .replace(/(\*\*|__|~~|`)/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

module.exports = { renderMarkdown, markdownToText };
