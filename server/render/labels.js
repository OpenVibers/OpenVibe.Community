'use strict';
/**
 * Content labels on the forum's pages (L1, labels and choices; Contracts common.content-labels@1).
 *
 *   attrs()    data-ov-labels on a labelled thread (a row in a list, or a thread's posts). Shared's ov-labels.js, which
 *              the navbar loads when one appears, applies each reader's own choice from openvibe.network: show, blur
 *              behind a "Show" button, or hide. The author always sees their own (data-ov-labels-owner, their subject).
 *              On the thread's own page it is "opened": a hide covers it instead of emptying the page.
 *   chips()    the labels in words beside a title, so a reader sees why something is covered.
 *   picker()   the labels in a form (new thread, the author's or a moderator's Labels box); AI suggestions are marked
 *              and never ticked for the author.
 *   fromForm() what a submitted form asks for.
 * A label is a reader's choice, never a ban: nothing here removes a thread for anybody.
 */
const { escapeHtml: esc } = require('./highlight');
const contentLabels = require('../forum/labels');

const NAMES = Object.freeze({ nudity: 'Nudity', language: 'Strong language', graphic: 'Graphic', '18+': '18+', flashing: 'Flashing lights', spoilers: 'Spoilers' });
const HINTS = Object.freeze({
    nudity: 'Nudity, art included',
    language: 'Swearing and slurs',
    graphic: 'Blood, injury, gore',
    '18+': 'For adults only',
    flashing: 'Strobes, fast flashes',
    spoilers: 'Endings and twists',
});

/** The labels in force on a thread (its content_labels, as stored or as shaped). */
const inForce = (t) => (t && t.content_labels !== undefined ? contentLabels.labelsOf(t.content_labels).labels : []);
const suggestedOf = (t) => (t && t.content_labels !== undefined ? contentLabels.labelsOf(t.content_labels).suggested : []);

/** ' data-ov-labels="…"' and its companions (nothing for no labels). owner: the author's subject. */
function attrs(labels, { owner = null, opened = false } = {}) {
    if (!labels || !labels.length) return '';
    const who = owner && /^[A-Za-z0-9_-]{1,80}$/.test(String(owner)) ? ` data-ov-labels-owner="${esc(owner)}"` : '';
    return ` data-ov-labels="${esc(labels.join(','))}"${who}${opened ? ' data-ov-labels-opened' : ''}`;
}

/** The labels in words (18+ in the warning colour), as Shared's kit.labels draws them. */
function chips(labels) {
    if (!labels || !labels.length) return '';
    return `<ul class="ovk-labels" aria-label="Content labels">${labels.map((l) => `<li class="ovk-label${l === '18+' ? ' ovk-label--adult' : ''}" data-label="${esc(l)}">${esc(NAMES[l])}</li>`).join('')}</ul>`;
}

/**
 * Six toggles, one per label. `current` is the labels in force, `suggested` the ones an AI or a reader proposed. A hidden
 * labels_form field says the picker was there, so ticking nothing means no labels.
 */
function picker({ current = [], suggested = [], id = 'labels' } = {}) {
    const now = new Set(current);
    const sug = new Set(suggested.filter((l) => !now.has(l)));
    return `<fieldset class="ovl-pick" aria-describedby="${esc(id)}-help"><legend>Content labels</legend>
<p class="ovl-help" id="${esc(id)}-help">Each reader picks what they see for a label: show it, blur it, or hide it. A label never takes the thread down.${sug.size ? ' Suggested ones are marked; nothing changes until you tick one.' : ''}</p>
<input type="hidden" name="labels_form" value="1">
<div class="ovl-opts">${contentLabels.LABELS.map((l) => `<label class="ovl-opt${l === '18+' ? ' ovl-opt--adult' : ''}"><input type="checkbox" name="labels" value="${esc(l)}"${now.has(l) ? ' checked' : ''}><span class="ovl-card"><b>${esc(NAMES[l])}</b><small>${esc(HINTS[l])}</small>${sug.has(l) ? '<em class="ovl-sug">Suggested</em>' : ''}</span></label>`).join('')}</div>
</fieldset>`;
}

/**
 * The labels a form asks for: a clean list, [] when the picker was there with nothing ticked, undefined when the form had
 * no picker, or null when it named something that is not a label.
 */
function fromForm(body) {
    const b = body || {};
    if (b.labels === undefined) return b.labels_form ? [] : undefined;
    return contentLabels.parseLabels([].concat(b.labels));
}

module.exports = { NAMES, HINTS, inForce, suggestedOf, attrs, chips, picker, fromForm };
