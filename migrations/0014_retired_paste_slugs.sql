-- phase: expand
-- Paste slugs an account erasure took out of the table (ADR-033: a person's paste that no one else commented on is
-- deleted, not tombstoned). Its slug stays retired: no later paste is ever given it, and no re-import can bring the
-- paste back, so a link someone kept or a search engine indexed never opens another person's paste (AGT-4). Only a
-- SHA-256 of the slug is kept, so nothing readable of the erased paste stays.
CREATE TABLE retired_paste_slugs (
    slug_hash text COLLATE "C" PRIMARY KEY CHECK (slug_hash ~ '^[0-9a-f]{64}$'),
    retired_at text COLLATE "C" NOT NULL DEFAULT ov_now()
);
