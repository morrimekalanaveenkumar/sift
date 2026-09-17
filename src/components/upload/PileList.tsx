'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/client';
import shell from '@/components/ui/shell.module.css';
import styles from './Upload.module.css';

export type Pile = {
  id: string;
  name: string;
  status: string;
  documents: number;
  kinds: number;
};

/**
 * The list of piles, with a way to get rid of one.
 *
 * Confirmation is a second click on the same button rather than a browser dialog. A
 * `confirm()` is easy and it is also modal, unstyled, and impossible to back out of with
 * the keyboard in the same way as the rest of this UI — and "click Delete, then click
 * Really?" is the same two decisions with none of that. Anything that drops a Postgres
 * table needs a deliberate second action; it does not need to seize the whole window.
 */
export function PileList({ piles }: { piles: Pile[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const remove = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      await api.delete(`/api/projects/${id}`);
      setConfirming(null);
      // Re-render the server component rather than filtering locally, so the list and the
      // database cannot disagree about what exists.
      startTransition(() => router.refresh());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      {piles.map((pile) => (
        <div key={pile.id} className={styles.pile} data-busy={busy === pile.id || pending}>
          <Link href={`/p/${pile.id}`} className={styles.pileMain}>
            <span className={shell.kindName}>{pile.name}</span>
            <span className={shell.kindMeta}>
              {pile.documents} document{pile.documents === 1 ? '' : 's'} · {pile.kinds} kind
              {pile.kinds === 1 ? '' : 's'}
            </span>
          </Link>

          <span className={shell.pill} data-tone={pile.status === 'committed' ? 'ready' : undefined}>
            {pile.status}
          </span>

          {confirming === pile.id ? (
            <span className={styles.confirm}>
              <button
                type="button"
                className={shell.btn}
                data-size="sm"
                data-variant="danger"
                disabled={busy === pile.id}
                onClick={() => void remove(pile.id)}
              >
                {busy === pile.id ? 'Deleting…' : 'Delete everything'}
              </button>
              <button
                type="button"
                className={shell.btn}
                data-size="sm"
                onClick={() => setConfirming(null)}
              >
                Keep
              </button>
            </span>
          ) : (
            <button
              type="button"
              className={styles.pileDelete}
              onClick={() => setConfirming(pile.id)}
              aria-label={`Delete ${pile.name}`}
              title="Delete this pile and any tables built from it"
            >
              ×
            </button>
          )}
        </div>
      ))}

      {error && (
        <div className={shell.notice} data-tone="warn" style={{ margin: 12 }}>
          <span aria-hidden="true">⚠</span><div>{error}</div>
        </div>
      )}
    </>
  );
}
