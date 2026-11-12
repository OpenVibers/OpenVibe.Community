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
  }
  function scan() {
    Array.prototype.forEach.call(document.querySelectorAll('form[data-ovc-compose]'), upgrade);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scan, { once: true }); else scan();
  document.addEventListener('ov:boost:load', scan);
  window.OVCommunityComposer = { scan: scan, upgrade: upgrade };
})();
