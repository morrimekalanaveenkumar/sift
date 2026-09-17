'use client';

/**
 * The structured result, searchable and sortable.
 *
 * This is the half of the brief that is easy to forget once the interesting problems are
 * solved: "converts them into clean, structured data **that can be searched and
 * queried**". A grid that filters an array in the browser would look identical here and
 * would not be that — so the search and the sort both run as SQL against the committed
 * table, which is the entire reason for building a typed table rather than keeping JSON.
 *
 * The consequence is visible rather than architectural: sorting by an amount orders it
 * numerically, sorting by a date orders it chronologically, and searching "2026-03" finds
 * dates rather than strings that happen to contain those characters.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/client';
import styles from './DataView.module.css';

type Column = { column_name: string; data_type: string };
type Row = Record<string, unknown>;

export function DataView({ kindId, table }: { kindId: string; table: string | null }) {
  const [columns, setColumns] = useState<Column[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<{ column: string; dir: 'asc' | 'desc' } | null>(null);
  const [loading, setLoading] = useState(true);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (q: string, s: typeof sort) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (s) { params.set('sort', s.column); params.set('dir', s.dir); }
      const data = await api.get<{ columns: Column[]; rows: Row[]; total: number }>(
        `/api/kinds/${kindId}/rows?${params}`,
      );
      setColumns(data.columns);
      setRows(data.rows);
      setTotal(data.total);
    } finally { setLoading(false); }
  }, [kindId]);

  useEffect(() => { void load('', null); }, [load]);

  // Debounced so typing does not fire a query per keystroke, but short enough that the
  // grid still feels like it is responding to you rather than to a timer.
  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => void load(query, sort), 220);
    return () => { if (debounce.current) clearTimeout(debounce.current); };
  }, [query, sort, load]);

  const toggleSort = (column: string) =>
    setSort((s) =>
      s?.column !== column ? { column, dir: 'asc' }
      : s.dir === 'asc' ? { column, dir: 'desc' }
      : null,
    );

  const isNumeric = useMemo(
    () => new Set(columns.filter((c) => /int|numeric|double|real/.test(c.data_type)).map((c) => c.column_name)),
    [columns],
  );

  if (!table) {
    return (
      <div className={styles.empty}>
        <div className={styles.emptyMark}>◈</div>
        <p style={{ fontWeight: 600, marginBottom: 4 }}>No table yet.</p>
        <p style={{ fontSize: 13 }}>Build the table from the schema page and the data appears here.</p>
      </div>
    );
  }

  const visible = columns.filter((c) => c.column_name !== '_needs_review');

  return (
    <div className={styles.root}>
      <div className={styles.bar}>
        <input
          className={styles.search}
          placeholder="Search every column…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search"
        />
        <span className={styles.count}>
          {loading ? 'querying…' : `${rows.length} of ${total} rows`}
        </span>
        <span style={{ flex: 1 }} />
        <span className={styles.tableName}>sift.{table}</span>
      </div>

      <div className={styles.scroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              {visible.map((column, i) => (
                <th
                  key={column.column_name}
                  className={`${styles.th}${i === 0 ? ` ${styles.sticky}` : ''}`}
                >
                  <button className={styles.thButton} onClick={() => toggleSort(column.column_name)}>
                    {column.column_name}
                    <span className={styles.thType}>{shortType(column.data_type)}</span>
                    {sort?.column === column.column_name && (
                      <span className={styles.sortMark}>{sort.dir === 'asc' ? '↑' : '↓'}</span>
                    )}
                  </button>
                </th>
              ))}
              <th className={styles.th} title="Values on this row that are low-confidence and not yet confirmed by a person">
                <span className={styles.thType}>unchecked</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className={styles.tr}>
                {visible.map((column, j) => {
                  const value = row[column.column_name];
                  const numeric = isNumeric.has(column.column_name);
                  return (
                    <td
                      key={column.column_name}
                      className={[
                        styles.td,
                        j === 0 ? styles.sticky : '',
                        numeric ? styles.num : '',
                        column.data_type === 'date' ? styles.mono : '',
                      ].filter(Boolean).join(' ')}
                      title={format(value)}
                    >
                      {value === null || value === undefined
                        ? <span className={styles.null}>null</span>
                        : format(value)}
                    </td>
                  );
                })}
                <td className={styles.td}>
                  {Number(row._needs_review) > 0 && (
                    <span className={styles.reviewFlag} title="Low-confidence values on this row that nobody has confirmed yet">
                      {String(row._needs_review)}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {!loading && rows.length === 0 && (
          <div className={styles.empty}>
            <p style={{ fontWeight: 600, marginBottom: 4 }}>Nothing matches “{query}”.</p>
            <p style={{ fontSize: 13 }}>The search runs across every column as text.</p>
          </div>
        )}
      </div>
    </div>
  );
}

const format = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  // Postgres returns numeric as a string to avoid float precision loss; keep it that way
  // and just make it readable.
  if (typeof v === 'string' && /^-?\d+\.\d{2}$/.test(v)) {
    return Number(v).toLocaleString(undefined, { minimumFractionDigits: 2 });
  }
  return String(v);
};

const shortType = (t: string) =>
  t === 'character varying' ? 'text'
  : t === 'timestamp with time zone' ? 'timestamptz'
  : t === 'double precision' ? 'float'
  : t;
