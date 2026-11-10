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

  // ── Forum images: the shared picker, one request per image before the form ──
  // The page loads ov-upload.js first. Each image goes to POST /api/v1/spaces/:space/attachments (Media,
  // owned by the writer, metadata stripped by the server); the form then names the returned med_ ids, so
  // the post itself is a plain urlencoded form and the old inline multipart upload is gone.
  function uploadImage(space, file, opts) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/v1/spaces/' + encodeURIComponent(space) + '/attachments');
      xhr.withCredentials = true;
      xhr.upload.onprogress = function (e) { if (e.lengthComputable && opts.onProgress) opts.onProgress({ uploadedBytes: e.loaded }); };
      xhr.onload = function () {
        var body = null; try { body = JSON.parse(xhr.responseText || 'null'); } catch (e) { body = null; }
        if (xhr.status >= 200 && xhr.status < 300 && body && body.attachment) { resolve(body); return; }
        var err = new Error((body && (body.detail || body.error)) || ('The image could not be uploaded (' + xhr.status + ').'));
        err.status = xhr.status; reject(err);
      };
      xhr.onerror = function () { reject(new Error('The connection dropped. Try that image again.')); };
      if (opts.signal) opts.signal.addEventListener('abort', function () { xhr.abort(); reject(new Error('Upload cancelled.')); }, { once: true });
      var fd = new FormData(); fd.append('file', file, file.name); xhr.send(fd);
    });
  }
  function attachmentUploads(signal) {
    $$('[data-attachment-upload]').forEach(function (root) {
      if (root.getAttribute('data-ready') || !window.OVUpload) return;
      var form = root.closest('form');
      if (!form) return;
      root.setAttribute('data-ready', '1');
      var status = form.querySelector('[data-attachment-status]');
      var space = root.getAttribute('data-space');
      var done = new Map();
      function say(text) { if (status) status.textContent = text; }
      var queue = window.OVUpload.queue(root, {
        label: 'Choose images', accept: 'image/png,image/jpeg,image/gif,image/webp', multiple: true, concurrency: 2,
        upload: function (file, opts) { return uploadImage(space, file, opts); },
        onDone: function (file, out) {
          if (out && out.attachment && out.attachment.media_id) done.set(file, out.attachment.media_id);
          say(done.size + (done.size === 1 ? ' image ready.' : ' images ready.'));
        }
      });
      form.addEventListener('submit', function (e) {
        var busy = queue.items.some(function (i) { return i.state === 'waiting' || i.state === 'sending'; });
        var failed = queue.items.some(function (i) { return i.state === 'failed'; });
        if (busy || failed) { e.preventDefault(); say(busy ? 'Wait for the images to finish uploading.' : 'Retry or remove the image that failed.'); return; }
        form.querySelectorAll('input[data-attachment-id]').forEach(function (n) { n.remove(); });
        queue.items.slice(0, 4).forEach(function (i) {
          var id = done.get(i.file);
          if (i.state !== 'done' || !id) return;
          var input = document.createElement('input'); input.type = 'hidden'; input.name = 'attachments';
          input.value = id; input.setAttribute('data-attachment-id', ''); form.appendChild(input);
        });
        if (queue.items.length > 4) say('The first 4 images go with this post.');
      }, { signal: signal, capture: true });
      say('Up to 4 images. Each is uploaded before you post.');
    });
  }

  // ── Per-page wiring ─────────────────────────────────────────
  // Runs once on load and again after openvibe-shared/boost swaps <main> (it fires ov:boost:load on
  // document), so the widgets of the page that just arrived are wired too. Each run replaces the
  // previous run's listeners (AbortController) and closes the previous event stream.
  var wired = null;
  var pulseEs = null;
  function wirePage() {
    if (wired) wired.abort();
    wired = new AbortController();
    var signal = wired.signal;
    attachmentUploads(signal);

    var shot = $('.shot.nsfw');
    if (shot) shot.addEventListener('click', function (e) { if (!shot.classList.contains('revealed')) { e.preventDefault(); shot.classList.add('revealed'); } }, { signal });
    var codeWrap = $('[data-code]');
    // A Markdown paste shows its document; its source (inside "Markdown source") already wraps.
    if (codeWrap && !codeWrap.closest('.paste-source')) {
      var wrapBtn = document.createElement('button'); wrapBtn.type = 'button'; wrapBtn.className = 'btn btn-sm'; wrapBtn.innerHTML = '<i class="fa-solid fa-align-left" aria-hidden="true"></i> Wrap';
      wrapBtn.addEventListener('click', function () { codeWrap.classList.toggle('wrap'); }, { signal });
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
      browseForm.addEventListener('submit', function (e) { e.preventDefault(); var qs = new URLSearchParams(new FormData(browseForm)); ['sort', 'lang', 'q', 'from'].forEach(function (k) { if (!qs.get(k) || (k === 'sort' && qs.get(k) === 'new') || (k === 'from' && qs.get(k) === 'people')) qs.delete(k); }); var s = qs.toString(); load('/pastes' + (s ? '?' + s : ''), true); }, { signal });
      $$('select', browseForm).forEach(function (sel) { sel.addEventListener('change', function () { browseForm.requestSubmit ? browseForm.requestSubmit() : browseForm.dispatchEvent(new Event('submit', { cancelable: true })); }, { signal }); });
      results.addEventListener('click', function (e) { var a = e.target.closest ? e.target.closest('.pager a') : null; if (!a) return; e.preventDefault(); load(a.getAttribute('href'), true); window.scrollTo({ top: results.offsetTop - 80, behavior: 'smooth' }); }, { signal });
      window.addEventListener('popstate', function (e) { if (e.state && e.state.browse) load(e.state.browse, false); else if (location.pathname === '/pastes') load(location.pathname + location.search, false); }, { signal });
    }

    // ── New paste: tabs + API submit (text → JSON, screenshot → multipart) ──
    var form = $('form[data-new-paste]');
    if (form && window.fetch && window.FormData) {
      var status = $('[data-status]', form);
      var tabs = $$('.tab', form); var mode = 'text';
      tabs.forEach(function (t) { t.hidden = false; });
      var lockSection = $('[data-lock-it]', form);
      var visField = $('[data-vis-field]', form);
      var visibilityInputs = $$('input[name="visibility"]', form);
      var audienceLine = $('[data-lock-audience]', form);
      var audienceText = $('[data-lock-audience-text]', form);
      var shotRoot = $('[data-screenshot-upload]', form);
      var shotStatus = $('[data-screenshot-status]', form);
      var shotProgress = $('[data-screenshot-progress]', form);
      var shotFile = null;
      var shotMeter = shotProgress && window.OVUpload ? window.OVUpload.progress(shotProgress) : null;
      var shotPicker = shotRoot && window.OVUpload ? window.OVUpload.picker(shotRoot, {
        label: 'Choose an image', accept: 'image/png,image/jpeg,image/webp,image/gif',
        onFile: function (f) {
          shotFile = f;
          if (shotProgress) shotProgress.hidden = true;
          if (!form.elements.title.value) form.elements.title.value = f.name.replace(/\.[^.]+$/, '');
          setMode('image');
        },
        onRemove: function () { shotFile = null; }
      }) : null;
      function sayShot(text, bad) { if (!shotStatus) return; shotStatus.textContent = text || ''; shotStatus.className = 'form-status' + (bad ? ' error' : ''); }
      var LOCK_AUDIENCE = { people: 'For the people on the list', password: 'Anyone with the password', link: 'Anyone with the link' };
      var syncLock = null;
      var lockOn = function () { return !!(form.elements.lock_it && form.elements.lock_it.checked); };
      function setMode(m) {
        mode = m;
        tabs.forEach(function (t) { var on = t.getAttribute('data-tab') === m; t.classList.toggle('active', on); t.setAttribute('aria-selected', on ? 'true' : 'false'); });
        $$('[data-pane]', form).forEach(function (p) { p.hidden = p.getAttribute('data-pane') !== m; });
        var content = form.elements.content, lang = form.elements.language;
        if (content) content.required = m === 'text';
        if (lang) lang.closest('.field').style.display = m === 'image' ? 'none' : '';
        // A screenshot stays on the proxy: locking is offered for text only.
        if (lockSection) lockSection.hidden = m !== 'text';
        if (syncLock) syncLock();
      }
      // Lock it (Locker): revealed here, never without JavaScript, because the sealing happens in this browser.
      if (lockSection) {
        lockSection.hidden = false;
        var lockBody = $('[data-lock-body]', form);
        syncLock = function () {
          var on = lockOn() && mode === 'text';
          if (lockBody) lockBody.hidden = !on;
          // The audience is the lock's (Specific people, or the link), so the column is replaced by one read-only line
          // naming it, and comes back when Lock it is off.
          var kind = (form.querySelector('input[name="lock_kind"]:checked') || {}).value || 'people';
          visibilityInputs.forEach(function (i) { i.disabled = on; });
          if (visField) visField.hidden = on;
          if (audienceLine) audienceLine.hidden = !on;
          if (audienceText) audienceText.textContent = LOCK_AUDIENCE[kind] || kind;
          if (!on) return;
          $$('[data-lock-for]', form).forEach(function (d) { d.hidden = d.getAttribute('data-lock-for') !== kind; });
        };
        form.elements.lock_it.addEventListener('change', syncLock);
        $$('input[name="lock_kind"]', form).forEach(function (r) { r.addEventListener('change', syncLock); });
        syncLock();
      }
      tabs.forEach(function (t) { t.addEventListener('click', function () { setMode(t.getAttribute('data-tab')); if (t.getAttribute('data-tab') === 'text') growBox(); }, { signal }); });

      // ── The code box: line numbers, a box that grows from 12 lines, the language chip, and a dropped file ──
      var codebox = $('[data-codebox]', form);
      var contentBox = form.elements.content;
      var gutterBox = $('[data-gutter]', form);
      var langSelect = $('[data-lang-select]', form);
      var langChip = $('[data-lang-chip]', form);
      var fileInput = $('[data-code-file-input]', form);
      var minBox = 0;
      function paintGutter() {
        if (!contentBox || !gutterBox) return;
        var n = Math.max(12, contentBox.value.split('\n').length);
        var out = '';
        for (var i = 1; i <= n; i++) out += i + (i === n ? '' : '\n');
        gutterBox.textContent = out;
        if (gutterBox.parentNode) gutterBox.parentNode.scrollTop = contentBox.scrollTop;
      }
      function growBox() {
        if (!contentBox) return;
        var cs = window.getComputedStyle(contentBox);
        if (!minBox) minBox = contentBox.offsetHeight || (12 * parseFloat(cs.lineHeight) + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom));
        contentBox.style.height = 'auto';
        var max = Math.round(window.innerHeight * 0.68);
        contentBox.style.height = Math.max(minBox, Math.min(contentBox.scrollHeight, max)) + 'px';
        paintGutter();
      }
      function readText(f) {
        var r = new FileReader();
        r.onload = function () {
          contentBox.value = String(r.result || '');
          if (!form.elements.title.value.trim()) form.elements.title.value = f.name.replace(/\.[^.]+$/, '');
          setMode('text');
          growBox();
          contentBox.focus();
        };
        r.readAsText(f);
      }
      function fillFile(f) {
        if (!f) return;
        if (/^image\//.test(f.type)) { takeFile(f); return; }
        if (/^text\//.test(f.type) || /\.(txt|log|md|markdown|json|jsonc|js|mjs|cjs|ts|tsx|jsx|py|sh|bash|zsh|yml|yaml|toml|ini|sql|css|scss|html?|xml|diff|patch|go|rs|php|rb|java|kt|swift|c|cpp|cs|lua|pl|r|conf|nginx)$/i.test(f.name)) readText(f);
      }
      if (contentBox && gutterBox) {
        growBox();
        contentBox.addEventListener('input', growBox, { signal });
        contentBox.addEventListener('scroll', function () { if (gutterBox.parentNode) gutterBox.parentNode.scrollTop = contentBox.scrollTop; }, { signal });
        window.addEventListener('resize', growBox, { signal });
      }
      if (langSelect && langChip) {
        var sayLang = function () { var o = langSelect.options[langSelect.selectedIndex]; langChip.textContent = o ? o.text : 'Auto-detect'; };
        langSelect.addEventListener('change', sayLang, { signal }); sayLang();
      }
      if (fileInput) {
        fileInput.addEventListener('change', function () { fillFile(fileInput.files && fileInput.files[0]); fileInput.value = ''; }, { signal });
        var pickFile = $('[data-code-file]', form);
        if (pickFile) pickFile.addEventListener('click', function () { fileInput.click(); }, { signal });
      }
      if (codebox) {
        ['dragenter', 'dragover'].forEach(function (ev) { codebox.addEventListener(ev, function (e) { e.preventDefault(); codebox.classList.add('is-drop'); }, { signal }); });
        codebox.addEventListener('dragleave', function () { codebox.classList.remove('is-drop'); }, { signal });
        codebox.addEventListener('drop', function (e) {
          codebox.classList.remove('is-drop');
          if (!e.dataTransfer || !e.dataTransfer.files[0]) return;
          e.preventDefault(); e.stopPropagation();
          fillFile(e.dataTransfer.files[0]);
        }, { signal });
      }
      setMode('text');
      // Dropping or pasting an image anywhere on the form switches to the screenshot mode.
      function takeFile(f) { if (!f || !/^image\//.test(f.type)) return; setMode('image'); if (shotPicker) shotPicker.add([f]); }
      form.addEventListener('dragover', function (e) { e.preventDefault(); }, { signal });
      form.addEventListener('drop', function (e) { if (e.dataTransfer && e.dataTransfer.files[0]) { e.preventDefault(); takeFile(e.dataTransfer.files[0]); } }, { signal });
      document.addEventListener('paste', function (e) { var items = e.clipboardData && e.clipboardData.items; if (!items) return; for (var i = 0; i < items.length; i++) { if (items[i].kind === 'file') { takeFile(items[i].getAsFile()); e.preventDefault(); return; } } }, { signal });

      // The Locker, loaded only when a locked paste is actually being made.
      function loadLocker() {
        return new Promise(function (resolve, reject) {
          if (window.OVLocker) return resolve(window.OVLocker);
          window.OpenVibeLockerConfig = { network: form.getAttribute('data-lock-network') || 'https://openvibe.network' };
          var s = document.createElement('script');
          s.src = '/shared/ov-locker.js';
          s.onload = function () { window.OVLocker ? resolve(window.OVLocker) : reject(new Error('The Locker could not start.')); };
          s.onerror = function () { reject(new Error('The Locker could not load. Check your connection and try again.')); };
          document.head.appendChild(s);
        });
      }
      function b64(u8) { var s = ''; for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s); }

      /** The screenshot goes to Community as one multipart request (it stores it in Media as the person's picture). */
      function uploadScreenshot(fd) {
        return new Promise(function (resolve, reject) {
          var xhr = new XMLHttpRequest();
          xhr.open('POST', '/api/pastes/screenshot');
          xhr.withCredentials = true;
          xhr.upload.onprogress = function (e) { if (e.lengthComputable && shotMeter) shotMeter.update({ state: 'sending', done: e.loaded, total: e.total }); };
          xhr.onload = function () {
            var body = null; try { body = JSON.parse(xhr.responseText || 'null'); } catch (_) { body = null; }
            if (xhr.status >= 200 && xhr.status < 300) { if (shotMeter) shotMeter.update({ state: 'done', done: shotFile ? shotFile.size : 0, total: shotFile ? shotFile.size : 0 }); resolve(body || {}); return; }
            var err = new Error((body && (body.detail || body.error)) || ('The image could not be uploaded (' + xhr.status + ').'));
            err.status = xhr.status; err.data = body; reject(err);
          };
          xhr.onerror = function () { reject(new Error('The connection dropped. Try the image again.')); };
          xhr.send(fd);
        });
      }

      /**
       * A locked paste: the plaintext never leaves this page. The document is sealed here, the envelope is what goes
       * up, and a people lock names who it is wrapped for (their public keys, each checked before anything is sent).
       */
      async function submitLocked(el) {
        var content = String(el.content.value || '');
        if (!content.trim()) throw new Error('Paste something first — the content is empty.');
        var kind = (form.querySelector('input[name="lock_kind"]:checked') || {}).value || 'people';
        var L = await loadLocker();
        await L.ensure();
        var pub = await L.publicKeys();
        var doc = JSON.stringify({ v: 1, type: 'paste', title: String(el.title.value || ''), content: content, language: String(el.language.value || 'auto') });
        var body = {
          locked: true, title: String(el.title.value || ''), show_title: !!(el.show_title && el.show_title.checked),
          is_nsfw: !!el.is_nsfw.checked,
        };
        var sealed;
        if (kind === 'people') {
          var names = String(el.lock_people.value || '').split(/[\s,;]+/).map(function (n) { return n.trim().replace(/^@+/, ''); }).filter(Boolean);
          if (!names.length) throw new Error('Name at least one person to lock it for.');
          var me = { type: 'user', id: form.getAttribute('data-subject') };
          if (!me.id) throw new Error('Sign in again to lock a paste.');
          var keys = [{ subject: me, publicKey: pub.ecdh }];
          var people = [];
          for (var i = 0; i < names.length; i++) {
            status.textContent = 'Checking @' + names[i] + '…';
            var found = await api('/api/v1/share/people?name=' + encodeURIComponent(names[i]));
            if (!found.person) throw new Error('No OpenVibe account is called @' + names[i] + '.');
            var k = await L.keys(found.person.subject);
            if (!k) throw new Error('@' + names[i] + ' has no locker yet: they make one the first time they open a locked item.');
            keys.push({ subject: found.person.subject, publicKey: k.ecdh_public || k.ecdh });
            people.push({ name: names[i], role: 'viewer', subject: found.person.subject });
          }
          status.textContent = 'Sealing on your device…';
          sealed = await L.seal(doc, { lock: 'people', keys: keys });
          var slots = (sealed.header.slots && sealed.header.slots.people) || [];
          body.members = people.map(function (p) {
            var slot = null;
            for (var j = 0; j < slots.length; j++) if (slots[j].subject.id === p.subject.id && slots[j].subject.type === p.subject.type) slot = slots[j];
            return slot ? { name: p.name, role: p.role, key_slot: slot } : null;
          });
          if (body.members.some(function (m) { return !m; })) throw new Error('A key is missing; try again.');
          body.audience = 'people';
        } else if (kind === 'password') {
          var password = String(el.lock_password.value || '');
          if (password.length < 12) throw new Error('Make the password longer: 12 characters or more, or a few words.');
          status.textContent = 'Sealing on your device…';
          sealed = await L.seal(doc, { lock: 'password', password: password });
          body.audience = 'link';
        } else {
          status.textContent = 'Sealing on your device…';
          sealed = await L.seal(doc, { lock: 'link' });
          body.audience = 'link';
        }
        body.envelope = b64(sealed.bytes);
        var out = await api('/api/pastes', { method: 'POST', json: body });
        var href = out && (out.url || (out.paste && out.paste.url));
        var slug = out && (out.slug || (out.paste && out.paste.slug));
        if (!href && !slug) throw new Error('No paste came back');
        status.textContent = 'Done — opening your paste…';
        location.href = (href || '/p/' + encodeURIComponent(slug)) + (sealed.linkKey ? '#k=' + sealed.linkKey : '');
      }

      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var btn = $('button[type="submit"]', form); btn.disabled = true; status.className = 'form-status';
        var el = form.elements; var p;
        if (lockOn() && mode === 'text') {
          status.textContent = 'Preparing your locker…';
          submitLocked(el).catch(function (err) {
            btn.disabled = false; status.className = 'form-status error';
            status.textContent = err.status === 429 && err.data && err.data.cooldown ? 'Slow down — try again in ' + err.data.cooldown + 's.' : err.message;
          });
          return;
        }
        var common = { title: el.title.value, visibility: el.visibility.value, burn_after_read: el.burn_after_read.checked, is_nsfw: el.is_nsfw.checked };
        if (mode === 'image') {
          if (!shotFile) { btn.disabled = false; sayShot('Choose an image first.', true); return; }
          sayShot('Uploading your image…');
          if (shotProgress) shotProgress.hidden = false;
          if (shotMeter) shotMeter.update({ state: 'sending', done: 0, total: shotFile.size });
          var fd = new FormData();
          fd.append('screenshot', shotFile);
          fd.append('title', common.title || 'Screenshot'); fd.append('description', el.description.value); fd.append('visibility', common.visibility);
          if (common.is_nsfw) fd.append('is_nsfw', '1');
          p = uploadScreenshot(fd);
        } else {
          status.textContent = 'Creating…';
          p = api('/api/pastes', { method: 'POST', json: Object.assign({ content: el.content.value, language: el.language.value }, common) });
        }
        p.then(function (out) {
          var href = out && (out.url || (out.paste && out.paste.url));
          var slug = out && (out.slug || (out.paste && out.paste.slug));
          if (!href && !slug) throw new Error('No paste came back');
          status.textContent = 'Done — opening your paste…';
          location.href = href || '/p/' + encodeURIComponent(slug);
        }).catch(function (err) {
          btn.disabled = false;
          var message = err.status === 429 && err.data && err.data.cooldown ? 'Slow down — try again in ' + err.data.cooldown + 's.' : err.message;
          if (mode === 'image') { if (shotMeter) shotMeter.update({ state: 'failed', message: message }); sayShot(message, true); }
          else { status.className = 'form-status error'; status.textContent = message; }
        });
      }, { signal });
    }

    // Pulse follows OpenVibe.Events realtime (roadmap WS-F task 1): on the first page, public activity
    // from here and the other sites arrives over openvibe.events/realtime/stream, and a bar
    // offers to show it (the page itself stays server-rendered, so a reload is the whole update).
    if (pulseEs) { pulseEs.close(); pulseEs = null; }
    var pulse = document.querySelector('[data-pulse-live]');
    if (pulse && typeof EventSource !== 'undefined') {
      var topics = ['community.paste.created', 'community.thread.created', 'community.post.created', 'live.stream.started', 'blog.post.published', 'wiki.page.published', 'news.story.published'];
      var bar = pulse.querySelector('.pulse-new'), show = pulse.querySelector('[data-pulse-show]'), fresh = 0;
      var es = new EventSource('https://openvibe.events/realtime/stream?topics=' + encodeURIComponent(topics.join(',')));
      pulseEs = es;
      es.onmessage = function (m) {
        var d; try { d = JSON.parse(m.data); } catch (e) { return; }
        if (!d || !d.event || topics.indexOf(d.event.event_type) < 0) return;
        fresh++;
        show.textContent = fresh === 1 ? 'Show 1 new item' : 'Show ' + fresh + ' new items';
        bar.hidden = false;
      };
      show.addEventListener('click', function () { es.close(); location.reload(); }, { signal });
      window.addEventListener('pagehide', function () { es.close(); }, { signal });
    }
  }
  // ── What people wear ───────────────────────────────────────
  // Names marked data-ov-subject wear their owner's name effect (openvibe-shared items.js, OpenVibe.Inventory; plan
  // T21). The script and its stylesheet load only on a page that shows someone, then every page move decorates again.
  function wearItems() {
    var meta = document.querySelector('meta[name="ov-items"]');
    if (!meta || !document.querySelector('[data-ov-subject]')) return;
    if (window.OpenVibeItems) { window.OpenVibeItems.decorate(document); return; }
    if (document.getElementById('ov-items-js')) return;
    var urls = (meta.getAttribute('content') || '').split(' ');
    if (urls.length !== 2) return;
    var css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = urls[1];
    document.head.appendChild(css);
    var s = document.createElement('script');
    s.id = 'ov-items-js';
    s.src = urls[0];
    s.onload = function () { if (window.OpenVibeItems) window.OpenVibeItems.decorate(document); };
    document.head.appendChild(s);
  }

  // ── The kit's behaviour ────────────────────────────────────
  // A page with the kit's rails, card menus or copy buttons (openvibe-shared kit.js markup, the home) gets kit-web.js;
  // it enhances what is there and, after that, every boosted page swap by itself.
  function kitWeb() {
    var meta = document.querySelector('meta[name="ov-kit"]');
    if (!meta || window.OpenVibeKitWeb || document.getElementById('ov-kit-js')) return;
    if (!document.querySelector('.ovk-rail, .ovk-more, [data-ovk-copy]')) return;
    var s = document.createElement('script');
    s.id = 'ov-kit-js';
    s.src = meta.getAttribute('content');
    document.head.appendChild(s);
  }

  wirePage();
  wearItems();
  kitWeb();
  document.addEventListener('ov:boost:load', function () { wirePage(); wearItems(); kitWeb(); });
})();
