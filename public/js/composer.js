/* OpenVibe.Community's composer on the shared one (openvibe-shared 4.215.0, OpenVibeComposer.mount): a marked
   server form keeps its action, its fields (a title, a category, images, pastes, a reply's parent) and its no-JS
   submit; the words and tools inside it become the shared composer. The page loads ov-composer.js or ov-thread.js
   first; without either the plain form stays. */
(function () {
  'use strict';
  function labelOf(form) {
    var b = form.querySelector('.form-actions button[type="submit"], button[type="submit"]');
    var t = b ? b.textContent.replace(/\s+/g, ' ').trim() : '';
    return t || (form.getAttribute('data-ovc-preset') === 'comment' ? 'Reply' : 'Post');
  }
  function upgrade(form) {
    if (!form || form.__ovcComposer || !window.OpenVibeComposer || !window.OpenVibeComposer.mount) return;
    var ta = form.querySelector('textarea[name="body"], textarea[name="message"], textarea');
    if (!ta) return;
    var user = null;
    try { user = JSON.parse(form.getAttribute('data-ovc-user') || 'null'); } catch (e) { user = null; }
    var preset = form.getAttribute('data-ovc-preset') || 'post';
    var hint = form.querySelector('.form-actions .muted');
    var note = hint ? hint.textContent.replace(/\s+/g, ' ').trim() : '';
    var host = document.createElement('div');
    var c;
    try {
      c = window.OpenVibeComposer.mount(host, {
        preset: preset, user: user, name: ta.name || 'body', placeholder: ta.placeholder || '',
        maxLength: Number(ta.getAttribute('maxlength')) || 40000, submitLabel: labelOf(form),
        note: note, tools: ['emoji'], label: ta.getAttribute('aria-label') || ta.placeholder || 'Write',
      });
    } catch (e) { return; }
    if (!c) return;
    if (ta.value) c.text.value = ta.value;
    var anchor = ta.closest('label') || ta;
    var parent = anchor.parentNode;
    while (c.form.firstChild) parent.insertBefore(c.form.firstChild, anchor);
    anchor.remove();
    var actions = form.querySelector('.form-actions');
    if (actions) actions.remove();
    form.classList.add('ovt-composer', 'ovc-v2');
    form.dataset.preset = preset;
    form.setAttribute('data-ovc', '');
    form.__ovcComposer = c;
    preview(form, c.text);
  }
  /*
   * Preview (plan §Y.1 A9): a form that names a preview address (data-ovc-preview) gets a Preview switch; while it is on,
   * a panel under the box shows the words as the site will publish them (the server's own renderer), drawn again half
   * a second after typing stops. The panel's markup is the server's sanitised HTML.
   */
  function preview(form, text) {
    var url = form.getAttribute('data-ovc-preview');
    if (!url || !text || form.__ovcPreview) return;
    form.__ovcPreview = true;
    var bar = document.createElement('div'); bar.className = 'ovc-preview-bar';
    var btn = document.createElement('button'); btn.type = 'button'; btn.className = 'ovc-preview-btn';
    btn.setAttribute('aria-pressed', 'false'); btn.setAttribute('aria-controls', 'ovc-preview-' + Math.random().toString(36).slice(2, 8));
    btn.textContent = 'Preview';
    var panel = document.createElement('div'); panel.className = 'md ovc-preview'; panel.id = btn.getAttribute('aria-controls');
    panel.hidden = true; panel.setAttribute('aria-live', 'polite'); panel.setAttribute('aria-label', 'Preview');
    bar.appendChild(btn);
    // Right under the box (the part of the form that holds it), above the form's other choices.
    var top = text;
    while (top.parentNode && top.parentNode !== form) top = top.parentNode;
    if (top.parentNode === form) { form.insertBefore(bar, top.nextSibling); form.insertBefore(panel, bar.nextSibling); }
    else { form.appendChild(bar); form.appendChild(panel); }
    var timer = 0, seq = 0, last = null;
    function draw() {
      var source = text.value || '';
      if (source === last) return;
      last = source;
      var mine = ++seq;
      if (!source.trim()) { panel.innerHTML = ''; panel.appendChild(Object.assign(document.createElement('p'), { className: 'muted', textContent: 'Nothing to preview yet.' })); return; }
      panel.classList.add('is-loading');
      fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ body: source }) })
        .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
        .then(function (b) { if (mine === seq) panel.innerHTML = String((b && b.html) || ''); })
        .catch(function () { if (mine === seq) { last = null; panel.textContent = 'The preview could not be drawn. Your words are safe in the box.'; } })
        .then(function () { if (mine === seq) panel.classList.remove('is-loading'); });
    }
    btn.addEventListener('click', function () {
      var on = btn.getAttribute('aria-pressed') !== 'true';
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.textContent = on ? 'Hide preview' : 'Preview';
      panel.hidden = !on;
      if (on) { last = null; draw(); }
    });
    text.addEventListener('input', function () {
      if (panel.hidden) return;
      clearTimeout(timer); timer = setTimeout(draw, 500);
    });
  }
  function scan() {
    Array.prototype.forEach.call(document.querySelectorAll('form[data-ovc-compose]'), upgrade);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scan, { once: true }); else scan();
  document.addEventListener('ov:boost:load', scan);
  window.OVCommunityComposer = { scan: scan, upgrade: upgrade };
})();
