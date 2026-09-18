/* OpenVibe.Community — progressive enhancement. Every page works without this file;
   it adds copy buttons, in-place browsing, deletes, and the create form's upload path. */
(function () {
  'use strict';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  // A silent sign-in that found no session leaves ?sso=none behind — tidy the address bar.
  if (/[?&]sso=none\b/.test(location.search) && history.replaceState) {
    var u = new URL(location.href); u.searchParams.delete('sso');
    history.replaceState(null, '', u.pathname + (u.search || '') + u.hash);
  }

  // A dead avatar URL (old Live avatars, offline Media) falls back to the letter badge.
  document.addEventListener('error', function (e) {
    var img = e.target;
    if (!img || img.tagName !== 'IMG' || !img.classList.contains('avatar')) return;
    var name = (img.parentNode && img.parentNode.textContent || '?').trim();
    var span = document.createElement('span'); span.className = 'avatar avatar-letter'; span.setAttribute('aria-hidden', 'true'); span.textContent = (name[0] || '?').toUpperCase();
    img.replaceWith(span);
  }, true);

  function flash(btn, text) {
    if (!btn) return;
    var old = btn.innerHTML; btn.innerHTML = '<i class="fa-solid fa-check" aria-hidden="true"></i> ' + text;
    setTimeout(function () { btn.innerHTML = old; }, 1600);
  }
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.top = '-1000px';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy') ? resolve() : reject(new Error('copy failed')); } catch (e) { reject(e); }
      document.body.removeChild(ta);
    });
  }
  function api(path, opts) {
    opts = opts || {};
    var headers = opts.headers || {};
    if (opts.json !== undefined) { headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(opts.json); }
    return fetch(path, { method: opts.method || 'GET', headers: headers, body: opts.body, credentials: 'same-origin' })
      .then(function (r) { return r.text().then(function (t) { var d = null; try { d = t ? JSON.parse(t) : null; } catch (e) { d = { error: t.slice(0, 200) }; } if (!r.ok) { var err = new Error((d && d.error) || ('Request failed (' + r.status + ')')); err.status = r.status; err.data = d; throw err; } return d; }); });
  }

  // ── Paste page ──────────────────────────────────────────────
  document.addEventListener('click', function (e) {
    var t = e.target.closest ? e.target.closest('[data-copy-content],[data-copy-link],[data-delete]') : null;
    if (!t) return;
    if (t.hasAttribute('data-copy-content')) {
      var code = $('#paste-content');
      copyText(code ? code.textContent : '').then(function () { flash(t, 'Copied'); api('/api/pastes/' + encodeURIComponent(t.getAttribute('data-copy-content')) + '/copy', { method: 'POST', json: {} }).catch(function () {}); }).catch(function () { flash(t, 'Select and copy'); });
    } else if (t.hasAttribute('data-copy-link')) {
      copyText(t.getAttribute('data-copy-link')).then(function () { flash(t, 'Link copied'); }).catch(function () {});
    } else if (t.hasAttribute('data-delete')) {
      if (!confirm('Delete this paste? There is no undo.')) return;
      t.disabled = true;
      api('/api/pastes/' + encodeURIComponent(t.getAttribute('data-delete')), { method: 'DELETE' })
        .then(function () { location.href = '/my'; })
        .catch(function (err) { t.disabled = false; alert(err.message); });
    }
  });
  var shot = $('.shot.nsfw');
  if (shot) shot.addEventListener('click', function (e) { if (!shot.classList.contains('revealed')) { e.preventDefault(); shot.classList.add('revealed'); } });
  var codeWrap = $('[data-code]');
  if (codeWrap) {
    var wrapBtn = document.createElement('button'); wrapBtn.type = 'button'; wrapBtn.className = 'btn btn-sm'; wrapBtn.innerHTML = '<i class="fa-solid fa-text-width" aria-hidden="true"></i> Wrap';
    wrapBtn.addEventListener('click', function () { codeWrap.classList.toggle('wrap'); });
    var actions = $('.actions'); if (actions) actions.appendChild(wrapBtn);
  }

  // ── Browse: filters + pagination without a full reload ──────
  var browseForm = $('form[data-browse]');
  if (browseForm && window.fetch && history.pushState) {
    var results = $('[data-results]');
    function load(url, push) {
      results.classList.add('loading');
      fetch(url, { headers: { Accept: 'text/html' }, credentials: 'same-origin' }).then(function (r) { return r.text(); }).then(function (html) {
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var next = doc.querySelector('[data-results]');
        if (next) results.innerHTML = next.innerHTML;
        var head = doc.querySelector('.page-head'); var mine = $('.page-head'); if (head && mine) mine.innerHTML = head.innerHTML;
        document.title = doc.title;
        if (push) history.pushState({ browse: url }, '', url);
        results.classList.remove('loading');
      }).catch(function () { location.href = url; });
    }
    browseForm.addEventListener('submit', function (e) { e.preventDefault(); var qs = new URLSearchParams(new FormData(browseForm)); ['sort', 'lang', 'q'].forEach(function (k) { if (!qs.get(k) || (k === 'sort' && qs.get(k) === 'new')) qs.delete(k); }); var s = qs.toString(); load('/pastes' + (s ? '?' + s : ''), true); });
    $$('select', browseForm).forEach(function (sel) { sel.addEventListener('change', function () { browseForm.requestSubmit ? browseForm.requestSubmit() : browseForm.dispatchEvent(new Event('submit', { cancelable: true })); }); });
    results.addEventListener('click', function (e) { var a = e.target.closest ? e.target.closest('.pager a') : null; if (!a) return; e.preventDefault(); load(a.getAttribute('href'), true); window.scrollTo({ top: results.offsetTop - 80, behavior: 'smooth' }); });
    window.addEventListener('popstate', function (e) { if (e.state && e.state.browse) load(e.state.browse, false); else if (location.pathname === '/pastes') load(location.pathname + location.search, false); });
  }

  // ── New paste: tabs + API submit (text → JSON, screenshot → multipart) ──
  var form = $('form[data-new-paste]');
  if (form && window.fetch && window.FormData) {
    var status = $('[data-status]', form);
    var tabs = $$('.tab', form); var mode = 'text';
    tabs.forEach(function (t) { t.hidden = false; });
    function setMode(m) {
      mode = m;
      tabs.forEach(function (t) { var on = t.getAttribute('data-tab') === m; t.classList.toggle('active', on); t.setAttribute('aria-selected', on ? 'true' : 'false'); });
      $$('[data-pane]', form).forEach(function (p) { p.hidden = p.getAttribute('data-pane') !== m; });
      var content = form.elements.content, file = form.elements.screenshot, lang = form.elements.language;
      if (content) content.required = m === 'text';
      if (file) { file.disabled = m !== 'image'; file.required = m === 'image'; }
      if (lang) lang.closest('.field').style.display = m === 'image' ? 'none' : '';
    }
    tabs.forEach(function (t) { t.addEventListener('click', function () { setMode(t.getAttribute('data-tab')); }); });
    setMode('text');
    // Dropping or pasting an image anywhere on the form switches to the screenshot mode.
    function takeFile(f) { if (!f || !/^image\//.test(f.type)) return; var dt = new DataTransfer(); dt.items.add(f); setMode('image'); form.elements.screenshot.files = dt.files; if (!form.elements.title.value) form.elements.title.value = f.name.replace(/\.[^.]+$/, ''); }
    form.addEventListener('dragover', function (e) { e.preventDefault(); });
    form.addEventListener('drop', function (e) { if (e.dataTransfer && e.dataTransfer.files[0]) { e.preventDefault(); takeFile(e.dataTransfer.files[0]); } });
    document.addEventListener('paste', function (e) { var items = e.clipboardData && e.clipboardData.items; if (!items) return; for (var i = 0; i < items.length; i++) { if (items[i].kind === 'file') { takeFile(items[i].getAsFile()); e.preventDefault(); return; } } });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var btn = $('button[type="submit"]', form); btn.disabled = true; status.className = 'form-status'; status.textContent = 'Creating…';
      var el = form.elements; var p;
      var common = { title: el.title.value, visibility: el.visibility.value, burn_after_read: el.burn_after_read.checked, is_nsfw: el.is_nsfw.checked };
      if (mode === 'image') {
        var fd = new FormData();
        fd.append('screenshot', el.screenshot.files[0]);
        fd.append('title', common.title || 'Screenshot'); fd.append('description', el.description.value); fd.append('visibility', common.visibility);
        if (common.is_nsfw) fd.append('is_nsfw', '1');
        p = api('/api/pastes/screenshot', { method: 'POST', body: fd });
      } else {
        p = api('/api/pastes', { method: 'POST', json: Object.assign({ content: el.content.value, language: el.language.value }, common) });
      }
      p.then(function (out) {
        var slug = out && (out.slug || (out.paste && out.paste.slug));
        if (!slug) throw new Error('No paste came back');
        status.textContent = 'Done — opening your paste…';
        location.href = '/p/' + encodeURIComponent(slug);
      }).catch(function (err) {
        btn.disabled = false; status.className = 'form-status error';
        status.textContent = err.status === 429 && err.data && err.data.cooldown ? 'Slow down — try again in ' + err.data.cooldown + 's.' : err.message;
      });
    });
  }
})();
