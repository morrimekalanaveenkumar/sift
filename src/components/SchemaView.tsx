'use client';

/**
 * What Sift found, and the chance to disagree with it before anything is committed.
 *
 * The discovery is a set of claims — these documents are one kind, these five labels are
 * one field, this field holds dates — and every one of them could be wrong on a pile I
 * have not seen. So the schema is presented as editable rather than as a result: rename
 * anything, retype anything, drop anything, and only then build the table.
 *
 * The part worth defending is the "why". Each merged field can explain itself in plain
 * words, because "these five labels are the same field" is a substantial claim about
 * someone's data and a tool that makes it silently is a tool you have to take on faith.
 */

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/client';
import shell from '@/components/ui/shell.module.css';

export type Kind = {
  id: string; name: string; table_name: string | null;
  documents: number; needs_review: number;
};
export type Field = {
  id: string; kind_id: string; name: string; column_name: string;
  aliases: string[]; type: string; coverage: number; rationale: string[]; included: boolean;
};

const TYPES = ['text', 'identifier', 'date', 'money', 'number', 'integer', 'email', 'phone', 'boolean'];

export function SchemaView({
  projectId, kinds, fields,
}: { projectId: string; kinds: Kind[]; fields: Field[] }) {
  const router = useRouter();
  const [local, setLocal] = useState(fields);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const patch = async (id: string, change: Partial<Field>) => {
    setLocal((cur) => cur.map((f) => (f.id === id ? { ...f, ...change } : f)));
    await api.patch(`/api/fields/${id}`, change).catch(() => router.refresh());
  };

  const commit = async (kindId: string) => {
    setBusy(kindId);
    try {
      await api.post(`/api/kinds/${kindId}/commit`);
      router.refresh();
    } finally { setBusy(null); }
  };

  return (
    <div className={shell.scroll}>
      <div className={shell.wrap}>
        <h1 className={shell.h1}>{kinds.length} kinds found</h1>
        <p className={shell.lede}>
          Sift grouped the pile by structure rather than by what the fields are called — five
          vendors naming the same thing five ways still belong together. Check the schema, change
          anything that looks wrong, then build the table.
        </p>

        {kinds.map((kind) => {
          const kindFields = local.filter((f) => f.kind_id === kind.id);
          const included = kindFields.filter((f) => f.included);

          return (
            <div key={kind.id} className={shell.panel}>
              <div className={shell.panelHead}>
                <div style={{ flex: 1 }}>
                  <div className={shell.kindName}>{kind.name}</div>
                  <div className={shell.kindMeta}>
                    {kind.documents} documents · {included.length} fields
                    {kind.table_name && ` · sift.${kind.table_name}`}
                  </div>
                </div>

                {kind.needs_review > 0 && (
                  <Link href={`/p/${projectId}/review/${kind.id}`} className={shell.pill} data-tone="review">
                    {kind.needs_review} to check
                  </Link>
                )}
                {kind.table_name && (
                  <Link href={`/p/${projectId}/data/${kind.id}`} className={shell.btn} data-size="sm">
                    Query
                  </Link>
                )}
                {included.length > 0 && (
                  <button
                    className={shell.btn}
                    data-variant={kind.table_name ? undefined : 'primary'}
                    data-size="sm"
                    onClick={() => void commit(kind.id)}
                    disabled={busy === kind.id}
                  >
                    {busy === kind.id ? 'Building…' : kind.table_name ? 'Rebuild table' : 'Build table'}
                  </button>
                )}
              </div>

              {kindFields.length === 0 ? (
                <div className={shell.panelBody} style={{ color: 'var(--text-muted)', fontSize: 13 }}>
                  No repeating fields here. These documents are prose rather than forms, so Sift
                  left them alone instead of inventing a schema for them.
                </div>
              ) : (
                kindFields.map((field) => (
                  <div key={field.id}>
                    <div className={shell.fieldRow} data-excluded={!field.included}>
                      <div style={{ minWidth: 0 }}>
                        <input
                          className={shell.fieldName}
                          value={field.name}
                          onChange={(e) => patch(field.id, { name: e.target.value })}
                          aria-label="Field name"
                        />
                        {field.aliases.length > 0 && (
                          <div className={shell.aliases}>
                            also called {field.aliases.map((a) => `“${a}”`).join(', ')}
                          </div>
                        )}
                      </div>

                      <select
                        className={shell.select}
                        value={field.type}
                        onChange={(e) => patch(field.id, { type: e.target.value })}
                        aria-label="Field type"
                      >
                        {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                      </select>

                      <div className={shell.coverage} title="How many documents of this kind have this field">
                        <span className={shell.coverageTrack}>
                          <span className={shell.coverageFill} style={{ width: `${field.coverage * 100}%` }} />
                        </span>
                        {Math.round(field.coverage * 100)}%
                      </div>

                      <div className={shell.fieldActions}>
                        {field.rationale.length > 0 && (
                          <button
                            className={shell.btn}
                            data-size="sm"
                            onClick={() => setOpen(open === field.id ? null : field.id)}
                            aria-expanded={open === field.id}
                          >
                            Why?
                          </button>
                        )}
                        <button
                          className={shell.btn}
                          data-size="sm"
                          onClick={() => patch(field.id, { included: !field.included })}
                        >
                          {field.included ? 'Drop' : 'Keep'}
                        </button>
                      </div>
                    </div>

                    {open === field.id && (
                      <div className={shell.why}>
                        {field.rationale.map((r, i) => (
                          <div key={i} className={shell.whyItem}>· {r}</div>
                        ))}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
