'use client';

/**
 * Checking extracted values against the documents they came from.
 *
 * This is the screen the product lives or dies on. Extraction is probabilistic, so
 * somebody has to verify it, and the only question that matters is how many values one
 * person can get through before they stop caring. Everything here is shaped by that:
 *
 *   - **Worst first.** The queue is ordered by confidence ascending, so the first thing
 *     you see is the thing most likely to be wrong. A queue that opens on an easy one
 *     teaches you it is not worth reading.
 *   - **Never make them hunt.** Selecting a value flies it to the exact spot on the page
 *     it came from, and draws the label that produced it. "Where did this come from" is
 *     answered before it is asked.
 *   - **Hands stay on the keyboard.** Enter confirms, e edits, arrows move. Reaching for
 *     the mouse once per value is what makes a thousand values feel like a thousand.
 *   - **Fix it once.** A correction is almost never a one-off — it comes from a rule that
 *     was wrong everywhere it applied. So the app finds the others and offers to fix them
 *     all, after showing exactly what it would change.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/client';
import { DocumentViewer, type Region, type StoredPage } from '@/components/viewer/DocumentViewer';
import { createFlip, flyToRegion } from './motion';
import styles from './Review.module.css';

type Cell = {
  id: string;
  raw: string | null;
  corrected_to: string | null;
  confidence: number;
  page: number;
  box: { x: number; y: number; w: number; h: number } | null;
  label_box: { x: number; y: number; w: number; h: number } | null;
  status: string;
  source_label: string | null;
  field_id: string;
  field_name: string;
  field_type: string;
  document_id: string;
  filename: string;
  pages: StoredPage[];
};

type Suggestion = {
  signature: string;
  description: string;
  candidates: { cellId: string; document: string; before: string; after: string }[];
};

const toneOf = (cell: Cell): 'sure' | 'likely' | 'unsure' | 'empty' =>
  cell.raw === null ? 'empty'
  : cell.confidence >= 0.75 ? 'sure'
  : cell.confidence >= 0.5 ? 'likely'
  : 'unsure';

export function Review({ kindId, kindName }: { kindId: string; kindName: string }) {
  const [cells, setCells] = useState<Cell[]>([]);
  const [summary, setSummary] = useState({ pending: 0, reviewed: 0, total: 0 });
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  /** The cell the open suggestion came from; it leaves the queue once the user decides. */
  const [pending, setPending] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const flip = useRef(createFlip());
  const pendingMorph = useRef<{ from: DOMRect; text: string } | null>(null);

  const active = useMemo(() => cells.find((c) => c.id === activeId) ?? null, [cells, activeId]);

  // --- data ----------------------------------------------------------------

  const load = useCallback(async () => {
    const data = await api.get<{ cells: Cell[]; summary: typeof summary }>(
      `/api/kinds/${kindId}/review`,
    );
    setCells(data.cells);
    setSummary(data.summary);
    setLoaded(true);
    setActiveId((current) => current ?? data.cells[0]?.id ?? null);
  }, [kindId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    setDraft(active?.corrected_to ?? active?.raw ?? '');
    setEditing(false);
  }, [active]);

  // FLIP has to measure before React commits and animate after, which is exactly what a
  // layout effect is for — doing it in a normal effect measures a screen the user has
  // already seen jump.
  useLayoutEffect(() => { flip.current.play(listRef.current); }, [cells]);

  // --- selection and the morph ---------------------------------------------

  const select = useCallback((id: string, sourceEl?: HTMLElement | null) => {
    const cell = cells.find((c) => c.id === id);
    if (sourceEl && cell?.raw) {
      // Capture where the value is *now*; the viewer reports where it lands once the
      // page has scrolled, and the ghost flies between the two.
      pendingMorph.current = { from: sourceEl.getBoundingClientRect(), text: cell.raw };
    }
    setActiveId(id);
  }, [cells]);

  const onActiveRect = useCallback((rect: DOMRect | null) => {
    const pending = pendingMorph.current;
    pendingMorph.current = null;
    if (pending && rect) flyToRegion(pending.from, rect, pending.text);
  }, []);

  const step = useCallback((delta: number) => {
    const index = cells.findIndex((c) => c.id === activeId);
    const next = cells[Math.max(0, Math.min(cells.length - 1, index + delta))];
    if (next && next.id !== activeId) {
      const el = listRef.current?.querySelector<HTMLElement>(`[data-flip-key="${next.id}"]`);
      el?.scrollIntoView({ block: 'nearest' });
      select(next.id, el);
    }
  }, [cells, activeId, select]);

  // --- actions -------------------------------------------------------------

  const advanceAfter = useCallback((id: string, alsoDone?: Set<string>) => {
    // Remember where the user was before the list shrinks, so review continues from the
    // same place rather than snapping back to the top. `alsoDone` is the generalised
    // batch: those rows leave the queue at the same moment, so the next cell has to be
    // the first one that is not in either set.
    const done = new Set(alsoDone ? [id, ...alsoDone] : [id]);
    const index = cells.findIndex((c) => c.id === id);
    const next =
      cells.slice(index + 1).find((c) => !done.has(c.id))
      ?? cells.slice(0, Math.max(0, index)).reverse().find((c) => !done.has(c.id))
      ?? null;
    flip.current.record(listRef.current);
    setCells((current) => current.filter((c) => !done.has(c.id)));
    setSummary((s) => ({
      ...s,
      pending: Math.max(0, s.pending - done.size),
      reviewed: s.reviewed + done.size,
    }));
    setActiveId(next?.id ?? null);
  }, [cells]);

  const confirm = useCallback(async () => {
    if (!active || busy) return;
    setBusy(true);
    try {
      await api.patch(`/api/cells/${active.id}`, { action: 'confirm' });
      advanceAfter(active.id);
    } finally { setBusy(false); }
  }, [active, busy, advanceAfter]);

  const correct = useCallback(async () => {
    if (!active || busy) return;
    const value = draft.trim();
    if (value === (active.raw ?? '')) { void confirm(); return; }
    setBusy(true);
    try {
      const result = await api.patch<{ suggestion: Suggestion | null }>(
        `/api/cells/${active.id}`, { action: 'correct', value },
      );
      // Hold position while a suggestion is on screen. Moving on immediately would leave
      // the panel talking about one document while the viewer shows the next one, and
      // the user cannot judge "does this rule look right" against the wrong page.
      if (result.suggestion) { setSuggestion(result.suggestion); setPending(active.id); }
      else advanceAfter(active.id);
    } finally { setBusy(false); }
  }, [active, draft, busy, advanceAfter, confirm]);

  const dismissSuggestion = useCallback(() => {
    setSuggestion(null);
    if (pending) { advanceAfter(pending); setPending(null); }
  }, [pending, advanceAfter]);

  const applySuggestion = useCallback(async () => {
    if (!suggestion) return;
    setBusy(true);
    try {
      await api.post('/api/corrections', {
        signature: suggestion.signature,
        changes: suggestion.candidates.map((c) => ({ cellId: c.cellId, after: c.after })),
      });
      const fixed = new Set(suggestion.candidates.map((c) => c.cellId));
      setSuggestion(null);
      if (pending) { advanceAfter(pending, fixed); setPending(null); }
    } finally { setBusy(false); }
  }, [suggestion, pending, advanceAfter]);

  // --- keyboard ------------------------------------------------------------

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const inInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';

      if (inInput) {
        if (event.key === 'Enter') { event.preventDefault(); void correct(); }
        if (event.key === 'Escape') {
          event.preventDefault();
          setDraft(active?.corrected_to ?? active?.raw ?? '');
          setEditing(false);
          inputRef.current?.blur();
        }
        return;
      }

      if (suggestion) {
        if (event.key === 'a') { event.preventDefault(); void applySuggestion(); }
        if (event.key === 'Escape') { event.preventDefault(); dismissSuggestion(); }
        return;
      }

      switch (event.key) {
        case 'ArrowDown': case 'j': event.preventDefault(); step(1); break;
        case 'ArrowUp': case 'k': event.preventDefault(); step(-1); break;
        case 'Enter': event.preventDefault(); void confirm(); break;
        case 'e':
          event.preventDefault();
          setEditing(true);
          // Focus after the state flush, so the input exists to receive it.
          requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.select(); });
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step, confirm, correct, applySuggestion, dismissSuggestion, suggestion, active]);

  // --- derived -------------------------------------------------------------

  const groups = useMemo(() => {
    const byField = new Map<string, Cell[]>();
    for (const cell of cells) {
      (byField.get(cell.field_name) ?? byField.set(cell.field_name, []).get(cell.field_name)!).push(cell);
    }
    return [...byField.entries()];
  }, [cells]);

  const regions: Region[] = useMemo(() => {
    if (!active) return [];
    // Every value from the same document, so the reviewer sees the one in question in the
    // context of its neighbours rather than floating alone on a page.
    return cells
      .filter((c) => c.document_id === active.document_id && c.box)
      .map((c) => ({
        id: c.id, page: c.page, box: c.box!, labelBox: c.label_box,
        tone: toneOf(c) === 'empty' ? 'unsure' : (toneOf(c) as 'sure' | 'likely' | 'unsure'),
      }));
  }, [cells, active]);

  const progress = summary.total > 0 ? (summary.reviewed / summary.total) * 100 : 0;

  if (loaded && cells.length === 0) {
    return (
      <div className={styles.root}>
        <div className={styles.done} style={{ margin: 'auto' }}>
          <div className={styles.doneMark}>✓</div>
          <p style={{ fontWeight: 600, marginBottom: 4 }}>Nothing left to check.</p>
          <p style={{ fontSize: 13 }}>
            Every value in {kindName} is either confident or confirmed.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <aside className={styles.queue}>
        <div className={styles.queueHead}>
          <div className={styles.queueTitle}>
            Needs checking
            <span className={styles.groupCount}>{summary.pending}</span>
          </div>
          <div className={styles.queueSub}>
            Least confident first · {summary.reviewed} of {summary.total} reviewed
          </div>
          <div className={styles.progressTrack}>
            <div className={styles.progressFill} style={{ width: `${progress}%` }} />
          </div>
        </div>

        <div className={styles.list} ref={listRef}>
          {groups.map(([fieldName, items]) => (
            <div key={fieldName} className={styles.group}>
              <div className={styles.groupHead}>
                {fieldName}
                <span className={styles.groupCount}>{items.length}</span>
              </div>
              {items.map((cell) => (
                <button
                  key={cell.id}
                  data-flip-key={cell.id}
                  className={styles.item}
                  data-active={cell.id === activeId}
                  data-tone={toneOf(cell)}
                  onClick={(e) => select(cell.id, e.currentTarget)}
                >
                  <span className={styles.spine} />
                  <span className={styles.itemMain}>
                    <span className={styles.itemValue} data-empty={cell.raw === null}>
                      {cell.raw ?? 'nothing found'}
                    </span>
                    <span className={styles.itemMeta}>{cell.filename}</span>
                  </span>
                  <span className={styles.confidence}>
                    {cell.raw === null ? '—' : `${Math.round(cell.confidence * 100)}%`}
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
      </aside>

      <main className={styles.main}>
        {active && (
          <div className={styles.card}>
            <div className={styles.cardField}>
              <div className={styles.cardLabel}>{active.field_type}</div>
              <div className={styles.cardName}>{active.field_name}</div>
              {active.source_label && active.source_label !== active.field_name && (
                <div className={styles.cardSource}>found as “{active.source_label}”</div>
              )}
            </div>

            <input
              ref={inputRef}
              className={styles.valueInput}
              value={draft}
              data-dirty={draft.trim() !== (active.raw ?? '')}
              placeholder={active.raw === null ? 'Nothing was found — type the value' : ''}
              onChange={(e) => { setDraft(e.target.value); setEditing(true); }}
              onFocus={() => setEditing(true)}
              aria-label={`Value for ${active.field_name}`}
            />

            <div className={styles.actions}>
              <button
                className={styles.button}
                onClick={() => void correct()}
                disabled={busy || draft.trim() === (active.raw ?? '')}
              >
                Save <span className={styles.kbd}>↵</span>
              </button>
              <button
                className={styles.button}
                data-variant="primary"
                onClick={() => void confirm()}
                disabled={busy}
              >
                Looks right <span className={styles.kbd}>↵</span>
              </button>
            </div>
          </div>
        )}

        <div className={styles.viewerWrap}>
          {active && (
            <DocumentViewer
              documentId={active.document_id}
              pages={active.pages}
              regions={regions}
              activeId={active.id}
              onSelect={(id) => select(id)}
              onActiveRect={onActiveRect}
            />
          )}

          {suggestion && (
            <div className={styles.suggestion} role="dialog" aria-label="Apply this correction elsewhere">
              <div className={styles.suggestionHead}>
                <span className={styles.suggestionIcon} aria-hidden="true">◈</span>
                <span className={styles.suggestionTitle}>
                  {suggestion.candidates.length} other{suggestion.candidates.length === 1 ? '' : 's'} look
                  {suggestion.candidates.length === 1 ? 's' : ''} like the same mistake
                </span>
                <button className={styles.button} data-size="sm" onClick={dismissSuggestion}>
                  Not now
                </button>
              </div>

              <div className={styles.suggestionBody}>
                {suggestion.candidates.slice(0, 40).map((c) => (
                  <div key={c.cellId} className={styles.change}>
                    <span className={styles.changeDoc}>{c.document}</span>
                    <span className={styles.before}>{c.before}</span>
                    <span className={styles.arrow} aria-hidden="true">→</span>
                    <span className={styles.after}>{c.after}</span>
                  </div>
                ))}
              </div>

              <div className={styles.suggestionFoot}>
                <span className={styles.suggestionCount}>
                  Sift would {suggestion.description}.
                </span>
                <button
                  className={styles.button}
                  data-variant="primary"
                  onClick={() => void applySuggestion()}
                  disabled={busy}
                >
                  Apply to all {suggestion.candidates.length} <span className={styles.kbd}>a</span>
                </button>
              </div>
            </div>
          )}

          {!suggestion && active && (
            <div className={styles.hint}>
              <span><span className={styles.kbd}>↑</span><span className={styles.kbd}>↓</span> move</span>
              <span><span className={styles.kbd}>↵</span> confirm</span>
              <span><span className={styles.kbd}>e</span> edit</span>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
