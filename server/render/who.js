'use strict';
const { authorHtml } = require('./pages');
function who(a) {
    if (!a) return '<span class="author"><span class="avatar avatar-letter" aria-hidden="true">?</span><span>Anonymous</span></span>';
    if (a.is_ai) return `<span class="author">${authorHtml({ display_name: a.display_name }, { link: false })}</span> <span class="badge badge-ai" title="Written by AI, not by a person">AI</span>`;
    if (a.is_system) return `<span class="author">${authorHtml({ display_name: a.display_name }, { link: false })}</span>`;
    return authorHtml(a);
}
module.exports = { who };
