(function () {
    'use strict';
    var thread = document.querySelector('[data-ovc-thread]');
    if (!thread) return;
    var allowed = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf', 'text/plain']);
    function read(html) { return new DOMParser().parseFromString(html, 'text/html').querySelector('[data-ovc-thread]'); }
    function replace(next, url) {
        if (!next) return false;
        thread.replaceWith(next); thread = next;
        if (url) history.pushState(null, '', url);
        return true;
    }
    document.addEventListener('click', async function (event) {
        var reply = event.target.closest('[data-ovc-reply]');
        if (reply && thread.contains(reply)) {
            var form = thread.querySelector('[data-ovt-composer]');
            var item = reply.closest('.ovc-comment');
            if (!form || !item) return;
            event.preventDefault();
            var parent = form.querySelector('[name="parent_id"]');
            if (!parent) { parent = document.createElement('input'); parent.type = 'hidden'; parent.name = 'parent_id'; form.appendChild(parent); }
            parent.value = reply.dataset.ovcReply;
            var slot = item.querySelector(':scope > [data-ovc-composer-slot]');
            if (!slot) { slot = document.createElement('div'); slot.dataset.ovcComposerSlot = ''; item.insertBefore(slot, item.querySelector(':scope > .ovc-replies')); }
            slot.appendChild(form);
            form.querySelector('textarea').focus();
            history.replaceState(null, '', reply.href);
            return;
        }
        var more = event.target.closest('[data-ovc-more]');
        if (more && thread.contains(more)) {
            event.preventDefault();
            more.setAttribute('aria-busy', 'true');
            try {
                var response = await fetch(more.href, { credentials: 'same-origin' });
                if (!response.ok) throw new Error('Replies could not be loaded.');
                var next = read(await response.text());
                var currentReplies = more.closest('[data-ovc-replies]');
                var loadedReplies = next && next.querySelector('[data-ovc-replies="' + more.dataset.ovcMore + '"]');
                if (!loadedReplies) throw new Error('Replies could not be loaded.');
                currentReplies.replaceWith(loadedReplies);
                history.pushState(null, '', more.href);
            } catch (error) { more.textContent = error.message; more.removeAttribute('aria-busy'); }
            return;
        }
        var order = event.target.closest('[data-ovc-order]');
        if (order && thread.contains(order)) {
            event.preventDefault();
            order.setAttribute('aria-busy', 'true');
            try {
                var page = await fetch(order.href, { credentials: 'same-origin' });
                if (!page.ok || !replace(read(await page.text()), order.href)) throw new Error('Comments could not be refreshed.');
            } catch (error) { order.textContent = error.message; order.removeAttribute('aria-busy'); }
        }
    });
    document.addEventListener('submit', async function (event) {
        var form = event.target;
        if (!thread.contains(form) || (!form.matches('[data-ovt-composer]') && !form.closest('.ovc-actions'))) return;
        var files = form.querySelector('[data-ovt-files]');
        var note = form.querySelector('[data-ovt-note]');
        if (files && files.files.length) {
            var problem = files.files.length > 4 ? 'Attach up to four files.' : '';
            for (var file of files.files) {
                if (file.size > 16 * 1024 * 1024) problem = 'A file can be up to 16 MB.';
                if (!allowed.has(file.type)) problem = 'Attach JPEG, PNG, GIF, WebP, PDF or text files.';
            }
            if (problem) { event.preventDefault(); if (note) note.textContent = problem; return; }
        }
        event.preventDefault();
        var button = form.querySelector('[type="submit"]');
        if (button) button.disabled = true;
        if (note) note.textContent = 'Sending…';
        try {
            var body = form.matches('[data-ovt-composer]') ? new FormData(form) : new URLSearchParams(new FormData(form));
            var response = await fetch(form.action, { method: 'POST', body: body, credentials: 'same-origin' });
            var html = await response.text();
            var next = read(html);
            if (!response.ok || !replace(next, response.url)) throw new Error('The comment could not be saved. Try again.');
        } catch (error) { if (note) note.textContent = error.message; if (button) button.disabled = false; }
    });
})();
