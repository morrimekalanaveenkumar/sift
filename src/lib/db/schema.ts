/**
 * Sift's own tables.
 *
 * Kept in a `sift` schema rather than `public`, so that the database Sift stores its
 * work in can also be a database someone points Sift at without the tool discovering
 * itself.
 *
 * The important structural decision is that extracted data lands in **two** places:
 *
 *   - `sift.cells`, one row per extracted value, carrying its confidence, the page and
 *     box it came from, and whether a human has looked at it. This is the provenance
 *     store, and it is what the review UI reads and writes.
 *   - a **real table per document kind**, created when the schema is committed, with one
 *     column per field and a proper Postgres type. This is what "queryable" has to mean:
 *     not a JSON blob you filter in JavaScript, but a table you can join and aggregate.
 *
 * Keeping both is a deliberate duplication. Provenance and confidence do not belong in
 * the clean table — nobody wants to see `total_confidence` next to `total` — and a clean
 * table with no provenance cannot be reviewed or corrected. The cells table is the source
 * of truth; the typed table is a projection of it, rebuilt whenever values change.
 */

export const SCHEMA = 'sift';

export const SCHEMA_SQL = `
CREATE SCHEMA IF NOT EXISTS ${SCHEMA};
SET LOCAL search_path = ${SCHEMA}, public;

CREATE TABLE IF NOT EXISTS projects (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  status      text NOT NULL DEFAULT 'ingesting'
              CHECK (status IN ('ingesting','discovered','committed')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS documents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  filename    text NOT NULL,
  content     bytea NOT NULL,
  page_count  integer NOT NULL DEFAULT 0,
  -- Page geometry only: sizes and rotation. The full positioned text is re-derived on
  -- demand rather than stored, because it is large, cheap to recompute, and would go
  -- stale against parser improvements.
  pages       jsonb NOT NULL DEFAULT '[]'::jsonb,
  kind_id     uuid,
  needs_ocr   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS documents_project_idx ON documents (project_id);

CREATE TABLE IF NOT EXISTS kinds (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name          text NOT NULL,
  signature     jsonb NOT NULL,
  -- The Postgres table this kind was committed into, once it has been.
  table_name    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fields (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind_id     uuid NOT NULL REFERENCES kinds(id) ON DELETE CASCADE,
  name        text NOT NULL,
  column_name text NOT NULL,
  aliases     text[] NOT NULL DEFAULT '{}',
  type        text NOT NULL,
  coverage    real NOT NULL DEFAULT 0,
  rationale   jsonb NOT NULL DEFAULT '[]'::jsonb,
  position    integer NOT NULL DEFAULT 0,
  -- The user can drop a discovered field before committing. Kept rather than deleted so
  -- the decision survives a re-run of discovery.
  included    boolean NOT NULL DEFAULT true
);
CREATE INDEX IF NOT EXISTS fields_kind_idx ON fields (kind_id);

CREATE TABLE IF NOT EXISTS cells (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id  uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  field_id     uuid NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
  raw          text,
  value        jsonb,
  -- The exact label this value was found under, before reconciliation renamed it.
  -- Kept because it identifies *who produced the document*: a vendor uses one wording
  -- consistently, so the label is a usable proxy for the vendor's house conventions —
  -- which is how date formats get resolved correctly. See canonicaliseAll.
  source_label text,
  confidence   real NOT NULL DEFAULT 0,
  page         integer NOT NULL DEFAULT 0,
  -- Where on the page this came from, so the UI can point at it.
  box          jsonb,
  label_box    jsonb,
  status       text NOT NULL DEFAULT 'unreviewed'
               CHECK (status IN ('unreviewed','confirmed','corrected','empty')),
  corrected_to text,
  reviewed_at  timestamptz,
  UNIQUE (document_id, field_id)
);
CREATE INDEX IF NOT EXISTS cells_field_idx ON cells (field_id, confidence);
CREATE INDEX IF NOT EXISTS cells_review_idx ON cells (field_id, status);

/**
 * Corrections, kept as a log rather than applied and forgotten.
 *
 * The log is what makes "you fixed this once, here are 47 more like it" possible: a
 * correction is only generalisable if you still have the before, the after, and enough
 * context to recognise the same mistake elsewhere.
 */
CREATE TABLE IF NOT EXISTS corrections (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  field_id     uuid NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
  cell_id      uuid REFERENCES cells(id) ON DELETE SET NULL,
  before_raw   text,
  after_value  text,
  -- What kind of mistake this was, used to find others like it. See extract/generalise.ts.
  signature    text NOT NULL,
  applied_to   integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS corrections_signature_idx ON corrections (project_id, signature);
`;

/** Postgres column type for each inferred value type. */
export const COLUMN_TYPES: Record<string, string> = {
  date: 'date',
  money: 'numeric(16,2)',
  number: 'double precision',
  integer: 'bigint',
  identifier: 'text',
  email: 'text',
  phone: 'text',
  boolean: 'boolean',
  text: 'text',
};

/**
 * Turn a discovered field name into a column name.
 *
 * Quoting would let us keep "Inv. Number" verbatim, and every query anyone writes against
 * the result would then need quotes too. The point of the exercise is a table people can
 * use, so the names are made usable.
 */
export function toColumnName(name: string, taken: Set<string>): string {
  let base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^(\d)/, 'f_$1')
    .slice(0, 55);
  if (!base) base = 'field';

  let candidate = base;
  let n = 2;
  while (taken.has(candidate)) candidate = `${base}_${n++}`;
  taken.add(candidate);
  return candidate;
}

export function toTableName(name: string, taken: Set<string>): string {
  return toColumnName(name, taken);
}
