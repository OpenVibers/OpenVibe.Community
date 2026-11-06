'use strict';

/**
 * Community's side of the unsafe-image review (VIS-6).
 *
 * An image paste goes to OpenVibe.Vision with its Media URL. Vision answers exactly one category:
 *
 *   fine          clear; the paste keeps the visibility its owner chose.
 *   sex_acts      private and NSFW: every public list, the Pulse feed, search and the sitemap leave it out;
 *                 the owner can still open it, and an adults-only section can use it later.
 *   minor_sexual  private, NSFW and quarantined, with the operator report id Vision made. The hard line is
 *                 always blocked, whoever posted it.
 *
 * If Vision cannot answer, the paste is made private and stays pending: an unreviewed image is never public.
 * Text pastes are not sent. No image bytes are copied here; Community keeps only the Media link it already had.
 */
const { serviceAuth } = require('openvibe-contracts');

function createPasteReview({ config, fetchImpl = globalThis.fetch, log = console } = {}) {
    const base = String((config.vision && config.vision.url) || process.env.OV_VISION_URL || process.env.VISION_URL || '').replace(/\/+$/, '');
    const enabled = Boolean(base && config.oauth && config.oauth.clientSecret);
    const tokens = enabled ? serviceAuth.createTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`,
        clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.vision',
        scope: 'vision.image.review',
        fetchImpl,
    }) : null;

    async function classify({ paste, imageUrl }, retried = false) {
        const mediaId = /^med_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(paste.media_ref || '')) ? paste.media_ref : null;
        const res = await fetchImpl(`${base}/api/v1/review`, {
            method: 'POST',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(await tokens.authHeaders()) },
            body: JSON.stringify({
                object_type: 'community.paste',
                object_id: paste.slug,
                object_app: 'community',
                media_object_id: mediaId,
                media_app: mediaId ? 'community' : null,
                owner_subject: paste.owner_subject || null,
                image_url: imageUrl,
                preview_url: imageUrl,
            }),
            signal: AbortSignal.timeout(20000),
        });
        if (res.status === 401 && !retried) { try { tokens.invalidate(); } catch { /* older client */ } return await classify({ paste, imageUrl }, true); }
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(`Vision review ${res.status}: ${(body && (body.detail || body.code)) || 'failed'}`);
        if (!body || !['fine', 'sex_acts', 'minor_sexual'].includes(body.category)) throw new Error('Vision review returned no known category');
        return body;
    }

    /**
     * A hidden paste is the owner's alone, so the share row must close too: after the sharing pilot the
     * share audience is the authority (server/sharing.js), and the old visibility column alone would let
     * canView reopen it. Members, pending transfers and access requests are removed for the same reason.
     */
    async function closeShares(db, paste) {
        await db.prepare("UPDATE shares SET audience = 'private', revision = revision + 1 WHERE service = 'community' AND kind = 'paste' AND resource_id = ?").run(paste.slug);
        await db.prepare("DELETE FROM share_members WHERE service = 'community' AND kind = 'paste' AND resource_id = ?").run(paste.slug);
        await db.prepare("UPDATE share_transfers SET state = 'cancelled' WHERE service = 'community' AND kind = 'paste' AND resource_id = ? AND state = 'pending'").run(paste.slug);
        await db.prepare("UPDATE share_access_requests SET state = 'dismissed' WHERE service = 'community' AND kind = 'paste' AND resource_id = ? AND state = 'pending'").run(paste.slug);
    }

    /** Write one category. Exported so a test or an operator route can apply the same three labels. */
    async function applyCategory(db, paste, category, reportId = null) {
        if (!['fine', 'sex_acts', 'minor_sexual'].includes(category)) throw new Error(`unknown review category: ${category}`);
        if (category !== 'fine') await closeShares(db, paste);
        if (category === 'fine') {
            await db.prepare("UPDATE pastes SET review_category = 'fine', review_status = 'clear', review_report_id = NULL, reviewed_at = ov_now() WHERE id = ?").run(paste.id);
        } else if (category === 'sex_acts') {
            await db.prepare("UPDATE pastes SET visibility = 'private', is_nsfw = 1, review_category = 'sex_acts', review_status = 'hidden', review_report_id = NULL, reviewed_at = ov_now() WHERE id = ?").run(paste.id);
        } else {
            if (reportId && !/^vor_[0-9A-HJKMNP-TV-Z]{26}$/.test(reportId)) throw new Error('invalid operator report id');
            await db.prepare("UPDATE pastes SET visibility = 'private', is_nsfw = 1, review_category = 'minor_sexual', review_status = 'quarantined', review_report_id = ?, reviewed_at = ov_now() WHERE id = ?").run(reportId, paste.id);
            log.error(`[Pastes] ${paste.slug} quarantined: sexual content involving a minor; operator report ${reportId || '(missing)'}`);
        }
        return await db.prepare('SELECT * FROM pastes WHERE id = ?').get(paste.id);
    }

    /** Review one image paste; a failure is closed (private + pending), never public. */
    async function reviewPaste(db, paste, imageUrl) {
        if (!enabled || !paste || paste.type !== 'screenshot' || !imageUrl) return null;
        try {
            const out = await classify({ paste, imageUrl });
            const row = await applyCategory(db, paste, out.category, out.report && out.report.id ? out.report.id : null);
            if (out.category === 'sex_acts') log.warn(`[Pastes] ${paste.slug} hidden: the review found sex acts or porn`);
            return row;
        } catch (err) {
            await db.prepare("UPDATE pastes SET visibility = 'private', is_nsfw = 1, review_status = 'pending' WHERE id = ?").run(paste.id);
            await closeShares(db, paste).catch(() => {});
            log.warn(`[Pastes] ${paste.slug}: review failed, the paste stays private and pending (${String((err && err.message) || err).slice(0, 200)})`);
            return await db.prepare('SELECT * FROM pastes WHERE id = ?').get(paste.id);
        }
    }

    return { enabled, classify, reviewPaste, applyCategory, closeShares };
}

module.exports = { createPasteReview };
