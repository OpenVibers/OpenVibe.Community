'use strict';
/**
 * The forum's Markdown renderer: the supported subset renders, and nothing a post contains can
 * become markup of its own — raw HTML, dangerous link schemes, attribute breakouts, entity tricks.
 */
const assert = require('assert');
const { renderMarkdown: md, markdownToText } = require('../server/render/markdown');
const { check, done } = require('./helpers/app');

(async () => {
    await check('the supported subset renders', () => {
        assert.strictEqual(md('Hello **bold**, *em*, _em_, ~~gone~~ and `x < y`'), '<p>Hello <strong>bold</strong>, <em>em</em>, <em>em</em>, <del>gone</del> and <code>x &lt; y</code></p>');
        assert.strictEqual(md('line one\nline two'), '<p>line one<br>\nline two</p>');
        assert.strictEqual(md('# Title\n## Sub'), '<h3>Title</h3>\n<h4>Sub</h4>', 'headings demoted so the page keeps one h1');
        assert.strictEqual(md('> quoted\n> more'), '<blockquote><p>quoted<br>\nmore</p></blockquote>');
        assert.strictEqual(md('- a\n- b\n  continued'), '<ul><li>a</li><li>b<br>\ncontinued</li></ul>');
        assert.strictEqual(md('3. c\n4. d'), '<ol start="3"><li>c</li><li>d</li></ol>');
        assert.strictEqual(md('---'), '<hr>');
        assert.strictEqual(md('```\n<b>raw</b>\n```'), '<pre class="md-code"><code class="hljs language-plaintext">&lt;b&gt;raw&lt;/b&gt;</code></pre>');
        assert.ok(md('```python\ndef f(): pass\n```').includes('<span class="hljs-keyword">def</span>'));
        assert.strictEqual(md('[OpenVibe](https://openvibe.network/a?b=1&c=2)'), '<p><a href="https://openvibe.network/a?b=1&amp;c=2" rel="nofollow ugc noopener">OpenVibe</a></p>');
        assert.strictEqual(md('see https://openvibe.live/x.'), '<p>see <a href="https://openvibe.live/x" rel="nofollow ugc noopener">https://openvibe.live/x</a>.</p>');
        assert.strictEqual(md('[home](/s/general) [top](#post-1) [mail](mailto:a@b.c)'), '<p><a href="/s/general" rel="nofollow ugc noopener">home</a> <a href="#post-1" rel="nofollow ugc noopener">top</a> <a href="mailto:a@b.c" rel="nofollow ugc noopener">mail</a></p>');
        assert.strictEqual(md('snake_case_name stays'), '<p>snake_case_name stays</p>');
        assert.strictEqual(md('**`code` in bold**'), '<p><strong><code>code</code> in bold</strong></p>');
    });

    await check('pipe tables: header, alignment, inline formatting, escaped pipes; scrolling region', () => {
        const t = md('Intro line\n| Delay | Test | **Result** |\n|:---|:-:|--:|\n| queue | `code` | ok \\| fine |\n| pipe | [x](https://a.b) |');
        assert.strictEqual(t, '<p>Intro line</p>\n<div class="md-table" tabindex="0" role="region" aria-label="Table"><table><thead><tr>'
            + '<th class="al-l">Delay</th><th class="al-c">Test</th><th class="al-r"><strong>Result</strong></th></tr></thead><tbody>'
            + '<tr><td class="al-l">queue</td><td class="al-c"><code>code</code></td><td class="al-r">ok | fine</td></tr>'
            + '<tr><td class="al-l">pipe</td><td class="al-c"><a href="https://a.b" rel="nofollow ugc noopener">x</a></td><td class="al-r"></td></tr>'
            + '</tbody></table></div>', 'a short row gets empty cells');
        // Without a delimiter row, or with cells that do not match it, pipes are just text.
        assert.strictEqual(md('a | b\nc | d'), '<p>a | b<br>\nc | d</p>');
        assert.strictEqual(md('| a | b |\n| --- |'), '<p>| a | b |<br>\n| --- |</p>');
        // Cells are escaped like any text.
        assert.ok(!md('| x |\n| - |\n| <script>alert(1)</script> |').includes('<script>'));
    });

    await check('a document numbers the heading levels it uses in order; a post keeps the fixed demotion', () => {
        assert.strictEqual(md('# T\n### A\n#### B\n### C', { headingShift: 1, document: true }), '<h2>T</h2>\n<h3>A</h3>\n<h4>B</h4>\n<h3>C</h3>');
        assert.strictEqual(md('### only', { headingShift: 1, document: true }), '<h2>only</h2>');
        // A # inside a fence is code, not a heading level.
        assert.strictEqual(md('```\n# not a heading\n```\n### Real', { headingShift: 1, document: true }).endsWith('<h2>Real</h2>'), true);
        assert.strictEqual(md('# T\n### A'), '<h3>T</h3>\n<h5>A</h5>', 'forum posts unchanged');
    });

    await check('lists nest by indenting; continuation lines stay in their item', () => {
        assert.strictEqual(md('- a\n  - a1\n  - a2\n- b'), '<ul><li>a<ul><li>a1</li><li>a2</li></ul></li><li>b</li></ul>');
        assert.strictEqual(md('1. one\n   - x\n     more x\n2. two'), '<ol><li>one<ul><li>x<br>\nmore x</li></ul></li><li>two</li></ol>');
        assert.strictEqual(md('- a\n    - deep\n- b'), '<ul><li>a<ul><li>deep</li></ul></li><li>b</li></ul>');
        assert.strictEqual(md('- code:\n  ```\n  x < 1\n  ```'), '<ul><li>code:<pre class="md-code"><code class="hljs language-plaintext">x &lt; 1</code></pre></li></ul>');
        // Past MAX_DEPTH the rest is shown as text, never deeper markup.
        const deep = md(Array.from({ length: 12 }, (_, k) => `${'  '.repeat(k)}- l${k}`).join('\n'));
        assert.ok((deep.match(/<ul>/g) || []).length <= 5, deep);
        assert.ok(deep.includes('l11'), 'nothing is dropped');
    });

    await check('raw HTML is text, never markup', () => {
        for (const evil of ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '<a href="javascript:alert(1)">x</a>', '<iframe src="//evil">', '<svg onload=alert(1)>', '<!-- x -->']) {
            const out = md(evil);
            assert.ok(!/<(script|img|iframe|svg|a )|<!--/i.test(out.replace(/<a href="[^"]*" rel="nofollow ugc noopener">/g, '')), `${evil} → ${out}`);
            assert.ok(out.includes('&lt;'), 'escaped');
        }
    });

    await check('links: only http(s), mailto, same-site paths and fragments; no attribute breakouts', () => {
        for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:x', '//evil.example/x', '/\\evil.example', 'java&#115;cript:alert(1)']) {
            const out = md(`[click](${bad})`);
            assert.ok(!out.includes('<a '), `${bad} must not become a link: ${out}`);
        }
        const quote = md('[x](https://a.b/"onmouseover="alert(1))');
        assert.ok(!/\sonmouseover\s*=/i.test(quote) && !/href="[^"]*"[^ >]/.test(quote), `quotes stay inside the attribute: ${quote}`);
        const bare = md('https://a.b/"><script>alert(1)</script>');
        assert.ok(!bare.includes('<script>'), bare);
        assert.ok(!/href="[^"]*"[^ >]/.test(bare), bare);
        const nul = md('a\u0000b');
        assert.strictEqual(nul, '<p>ab</p>');
    });

    await check('pathological posts render in linear time (no ReDoS)', () => {
        let codeRuns = '';
        for (let k = 1; codeRuns.length < 39000; k++) codeRuns += `a${'`'.repeat(k)}`;
        const cases = {
            heading: `# a${' '.repeat(6000)}x`,
            fence: `\`\`\`${' '.repeat(39000)}!`,
            strong: '**x '.repeat(10000),
            underscore: ' __x'.repeat(10000),
            strike: '~~x '.repeat(10000),
            codeRuns,
            wideTable: `${'|a'.repeat(20000)}|\n${'|-'.repeat(20000)}|\n${'|b'.repeat(20000)}|`,
            tallTable: `| a | b |\n| - | - |\n${'| x | y |\n'.repeat(20000)}`,
            pipes: `${'| '.repeat(20000)}\n${'|-'.repeat(20000)}`,
            nested: Array.from({ length: 4000 }, (_, k) => `${' '.repeat(k % 40)}- item ${k}`).join('\n'),
        };
        for (const [name, src] of Object.entries(cases)) {
            const started = Date.now();
            md(src);
            const ms = Date.now() - started;
            assert.ok(ms < 1000, `renderMarkdown ${name} took ${ms}ms`);
        }
        const started = Date.now();
        markdownToText('['.repeat(40000));
        assert.ok(Date.now() - started < 1000, `markdownToText took ${Date.now() - started}ms`);
        assert.strictEqual(md('# Title ##  '), '<h3>Title</h3>');
        assert.strictEqual(md('``a`b`` and `c` ``d`'), '<p><code>a`b</code> and <code>c</code> `<code>d</code></p>');
        assert.strictEqual(md('**a** **b **c** ~~d~~ x__y__ __z__'), '<p><strong>a</strong> <strong>b **c</strong> <del>d</del> x__y__ <strong>z</strong></p>');
    });

    await check('markdownToText strips the syntax for descriptions and feeds', () => {
        assert.strictEqual(markdownToText('# Hi\n**b** [l](http://x) `c`\n\n- item'), 'Hi b l c item');
        assert.strictEqual(markdownToText('x'.repeat(50), 10), `${'x'.repeat(9)}…`);
        assert.strictEqual(markdownToText('<script>'), '<script>', 'plain text: the caller escapes it');
    });

    done();
})();
