'use strict';
/**
 * A migrated database for one test (ADR-035), from openvibe-sdk/testing: PGlite by default; with COMMUNITY_TEST_STORE=pg
 * (npm run test:pg) the PostgreSQL + PgBouncer containers, with roles and a schema of its own. The handle's close()
 * also drops the test database.
 */
const { createTestDb } = require('openvibe-sdk/testing');
const { MIGRATIONS } = require('../../server/db');

async function testDb({ store = process.env.COMMUNITY_TEST_STORE || 'pglite', max = 4 } = {}) {
    const t = await createTestDb({ migrations: MIGRATIONS, store, service: 'community', max });
    // db.close() runs the test database's own close (PGlite: closes it; the containers: also drops its roles and
    // schema), once; that close calls the handle's original close, which is put back first.
    const own = t.db.close;
    let closing = null;
    t.db.close = () => { if (!closing) { t.db.close = own; closing = t.close(); } return closing; };
    return t.db;
}

module.exports = { testDb };
