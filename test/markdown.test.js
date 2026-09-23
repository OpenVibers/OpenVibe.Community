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

    await check('markdownToText strips the syntax for descriptions and feeds', () => {
        assert.strictEqual(markdownToText('# Hi\n**b** [l](http://x) `c`\n\n- item'), 'Hi b l c item');
        assert.strictEqual(markdownToText('x'.repeat(50), 10), `${'x'.repeat(9)}…`);
        assert.strictEqual(markdownToText('<script>'), '<script>', 'plain text: the caller escapes it');
    });

    done();
})();
