'use strict';
/**
 * Public AI text never describes a person (the owner's rule; openvibe-sdk/no-looks): no looks, body, clothing, hair,
 * face, pose, age or guessed gender. Services send Community AI text (Live's picture descriptions of screenshots, its
 * AI moment pastes), and models ignore the rule in their prompts about one time in ten, so Community applies it to
 * every AI field it stores:
 *
 *   - a paste's ai_summary and ai_tags, whoever owns the paste;
 *   - the title and body of an AI paste (origin 'ai'). The body's footer ("🔴 Caught live on @x's stream — …",
 *     "▶ Watch this moment on …") is links, not description, and stays as written, except "on @null's stream",
 *     which reads "on the stream".
 *
 * repairStored() rewrites rows stored before (187 of 1,207 summaries named people on 2026-10-22). It runs at boot
 * and changes only rows whose text the rules change, so a later boot finds nothing. Search's hourly refresh
 * (server/search/documents.js) re-sends the repaired pastes. A person's own title and text are never touched.
 */
const { noLooks, noLooksTags } = require('openvibe-sdk/no-looks');

const FOOTER = /(\n\n(?:🔴|▶)[\s\S]*)$/u;

const summary = (s) => (typeof s === 'string' ? noLooks(s).trim() : s);

/** ai_tags as stored (a JSON array string, an array, or comma text) → the same shape without looks tags. */
function tags(t) {
    if (t == null) return t;
    if (Array.isArray(t)) return noLooksTags(t);
    const s = String(t);
    try {
        const arr = JSON.parse(s);
        if (Array.isArray(arr)) return JSON.stringify(noLooksTags(arr));
    } catch { /* comma text */ }
    return noLooksTags(s.split(',').map((x) => x.trim())).join(', ');
}

/** An AI paste's body: the description before its footer. */
function body(content) {
    if (typeof content !== 'string') return content;
    const m = FOOTER.exec(content);
    const text = m ? content.slice(0, m.index) : content;
    const clean = noLooks(text).trim();
    // Live wrote "on @null's stream" when Media's list named no owner (478 pastes, 2026-08-18 to 10-22; fixed in Live).
    const footer = m ? m[1].replace(/ on @null's stream:/, ' on the stream:') : '';
    // A description that was all looks leaves the footer alone.
    return clean ? clean + footer : footer.trim();
}

/** An AI paste's title; '' when it was all looks (store.sanitizeTitle then gives the default). */
function title(t) {
    if (typeof t !== 'string') return t;
    return noLooks(t).trim();
}

/** The AI fields of a row as Community stores them: { ai_summary, ai_tags } and, for an AI paste, title and content. */
function cleanRow(row) {
    const out = {};
    if (row.ai_summary != null) out.ai_summary = summary(row.ai_summary);
    if (row.ai_tags != null) out.ai_tags = tags(row.ai_tags);
    if (row.origin === 'ai') {
        if (row.title != null) out.title = title(row.title) || 'Untitled';
        if (row.content != null) out.content = body(row.content);
    }
    return out;
}

/** Rewrite stored rows the rules change; returns how many changed. */
async function repairStored(db, { log = console } = {}) {
    const rows = await db.prepare(`SELECT id, origin, title, content, ai_summary, ai_tags FROM pastes
        WHERE deleted_at IS NULL AND (ai_summary IS NOT NULL OR ai_tags IS NOT NULL OR origin = 'ai')`).all();
    let changed = 0;
    for (const row of rows) {
        const clean = cleanRow(row);
        const cols = Object.keys(clean).filter((c) => clean[c] !== row[c]);
        if (!cols.length) continue;
        await db.prepare(`UPDATE pastes SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => clean[c]), row.id);
        changed++;
    }
    if (changed && log) log.log(`[Pastes] public AI text no longer describes people: ${changed} paste(s) repaired`);
    return changed;
}

module.exports = { summary, tags, body, title, cleanRow, repairStored };
