-- Adds a structured `content` JSONB column holding the create/edit form's
-- fields (prose sections, action-item tables, timeline rows). This lets an RCA
-- be re-opened in the same structured editor used to create it, instead of
-- only as a raw-markdown blob.
--
-- `body` (markdown) is kept as the rendered/derived artifact: the frontend
-- recomposes it from `content` on every save, so the AI summary generator,
-- Slack notifications, and right-rail link extraction (all of which read
-- `body`) keep working unchanged.
--
-- Existing rows have content = NULL. They are migrated lazily: the editor
-- hydrates the form from the markdown `body` (via the existing parser) on
-- first edit and writes `content` back on save. No bulk backfill is required,
-- and nothing is ever stranded — an unparseable body still falls back to the
-- raw-markdown editor.

SET search_path TO rca_coe;

ALTER TABLE rcas
    ADD COLUMN IF NOT EXISTS content JSONB;
