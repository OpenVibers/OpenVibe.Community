-- phase: expand
-- Sharing (design 2026-11-06, plan track Q): the tables openvibe-sdk/share's sharesSchema() creates.
-- Kept verbatim from openvibe-sdk v0.85.0 (src/share/schema.js) so a Community database has the
-- same shape as every other service that adopts it. Expand only: nothing is dropped or rewritten.
CREATE TABLE IF NOT EXISTS shares (
    service text NOT NULL, kind text NOT NULL, resource_id text NOT NULL,
    owner_subject jsonb NOT NULL, audience text NOT NULL CHECK (audience IN ('public','link','people','private')),
    revision integer NOT NULL DEFAULT 1,
    PRIMARY KEY (service, kind, resource_id)
);
CREATE TABLE IF NOT EXISTS share_members (
    service text NOT NULL, kind text NOT NULL, resource_id text NOT NULL,
    subject jsonb NOT NULL, role text NOT NULL CHECK (role IN ('viewer','editor')),
    expires_at timestamptz, added_by jsonb NOT NULL, added_at timestamptz NOT NULL,
    PRIMARY KEY (service, kind, resource_id, subject),
    FOREIGN KEY (service,kind,resource_id) REFERENCES shares(service,kind,resource_id)
);
CREATE TABLE IF NOT EXISTS share_transfers (
    id uuid PRIMARY KEY, service text NOT NULL, kind text NOT NULL, resource_id text NOT NULL,
    from_subject jsonb NOT NULL, to_subject jsonb NOT NULL, keep_access boolean NOT NULL DEFAULT false,
    requested_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
    state text NOT NULL CHECK (state IN ('pending','accepted','declined','cancelled','expired')),
    FOREIGN KEY (service,kind,resource_id) REFERENCES shares(service,kind,resource_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS share_transfer_pending ON share_transfers(service,kind,resource_id) WHERE state='pending';
CREATE TABLE IF NOT EXISTS share_access_requests (
    id uuid PRIMARY KEY, service text NOT NULL, kind text NOT NULL, resource_id text NOT NULL,
    subject jsonb NOT NULL, requested_at timestamptz NOT NULL,
    state text NOT NULL CHECK (state IN ('pending','granted','dismissed')),
    FOREIGN KEY (service,kind,resource_id) REFERENCES shares(service,kind,resource_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS share_request_pending ON share_access_requests(service,kind,resource_id,subject) WHERE state='pending';
CREATE TABLE IF NOT EXISTS share_log (
    id uuid PRIMARY KEY, service text NOT NULL, kind text NOT NULL, resource_id text NOT NULL,
    actor jsonb NOT NULL, action text NOT NULL, details jsonb NOT NULL, occurred_at timestamptz NOT NULL,
    sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE
);
CREATE OR REPLACE FUNCTION share_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'share_log is append-only'; END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='share_log_no_changes' AND tgrelid='share_log'::regclass) THEN
        CREATE TRIGGER share_log_no_changes BEFORE UPDATE OR DELETE OR TRUNCATE ON share_log
        FOR EACH STATEMENT EXECUTE FUNCTION share_log_append_only();
    END IF;
END $$;
CREATE TABLE IF NOT EXISTS share_deliveries (
    id uuid PRIMARY KEY, channel text NOT NULL CHECK (channel IN ('event','notify')),
    body jsonb NOT NULL, created_at timestamptz NOT NULL, delivered_at timestamptz,
    sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE
);
CREATE TABLE IF NOT EXISTS share_name_limits (
    caller jsonb PRIMARY KEY, window_start bigint NOT NULL, attempts integer NOT NULL
);
CREATE INDEX IF NOT EXISTS share_members_subject ON share_members(subject);
CREATE INDEX IF NOT EXISTS share_transfers_recipient ON share_transfers(to_subject) WHERE state='pending';
CREATE INDEX IF NOT EXISTS share_deliveries_pending ON share_deliveries(created_at) WHERE delivered_at IS NULL;
