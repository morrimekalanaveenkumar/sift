'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { stream } from '@/lib/client';
import shell from '@/components/ui/shell.module.css';
import styles from './Upload.module.css';

/**
 * The stages, in the order they happen, with the reason each one exists.
 *
 * This list is the honest explanation of why ingestion is not a per-document progress
 * bar: three of the five stages need the whole pile at once. Telling a label from a value
 * requires knowing which strings recur across documents, and there is no way to know that
 * from one document. Naming the stages turns an unavoidable wait into an explanation.
 */
const STAGES = [
  { key: 'parsing', label: 'Reading every page' },
  { key: 'analysing', label: 'Finding labels, values and tables' },
  { key: 'clustering', label: 'Grouping documents by structure' },
  { key: 'reconciling', label: 'Matching field names across sources' },
  { key: 'storing', label: 'Canonicalising values' },
] as const;

type Progress = { stage: string; done: number; total: number; message: string };
type Line =
  | { progress: Progress }
  | { done: { projectId: string; documents: number; kinds: number; fields: number } }
  | { error: string };

const KB = 1024;
const size = (bytes: number) =>
  bytes < KB * 999 ? `${Math.max(1, Math.round(bytes / KB))} KB` : `${(bytes / KB / KB).toFixed(1)} MB`;

export function Upload() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  const [files, setFiles] = useState<File[]>([]);
  const [name, setName] = useState('');
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [skipped, setSkipped] = useState(0);

  const accept = (incoming: FileList | File[]) => {
    const all = [...incoming];
    const pdfs = all.filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
    // Say what was ignored. Silently dropping a file the user dragged in is how they end
    // up believing extraction lost it.
    setSkipped(all.length - pdfs.length);
    setFiles((current) => {
      const seen = new Set(current.map((f) => `${f.name}:${f.size}`));
      return [...current, ...pdfs.filter((f) => !seen.has(`${f.name}:${f.size}`))];
    });
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (files.length === 0 || busy) return;

    setBusy(true);
    setError(null);
    setProgress({ stage: 'parsing', done: 0, total: files.length, message: '' });

    const form = new FormData();
    form.set('name', name.trim() || `${files.length} document${files.length === 1 ? '' : 's'}`);
    for (const file of files) form.append('files', file);

    try {
      let destination: string | null = null;
      await stream<Line>('/api/projects', form, (line) => {
        if ('progress' in line) setProgress(line.progress);
        else if ('done' in line) destination = `/p/${line.done.projectId}`;
        else if ('error' in line) throw new Error(line.error);
      });
      if (!destination) throw new Error('Ingestion ended without a result.');
      router.push(destination);
    } catch (e) {
      setError((e as Error).message);
      setProgress(null);
      setBusy(false);
    }
  };

  const activeIndex = progress ? STAGES.findIndex((s) => s.key === progress.stage) : -1;
  const shown = files.slice(0, 6);

  return (
    <form onSubmit={submit}>
      <label
        className={styles.drop}
        data-dragging={dragging}
        data-disabled={busy}
        onDragOver={(e) => { e.preventDefault(); if (!busy) setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (!busy) accept(e.dataTransfer.files);
        }}
      >
        <input
          ref={inputRef}
          type="file" multiple accept="application/pdf" hidden disabled={busy}
          onChange={(e) => { accept(e.target.files ?? []); e.target.value = ''; }}
        />
        <div className={styles.dropTitle}>
          {files.length > 0
            ? `${files.length} document${files.length === 1 ? '' : 's'} ready`
            : 'Drop PDFs here, or choose files'}
        </div>
        <div className={styles.dropHint}>
          Mixed kinds are fine — sorting them out is the point.
        </div>
      </label>

      {skipped > 0 && (
        <div className={shell.notice} data-tone="warn" style={{ marginTop: 12 }}>
          <span aria-hidden="true">⚠</span>
          <div>
            {skipped} file{skipped === 1 ? '' : 's'} ignored — Sift reads PDFs. Scanned pages are
            fine; a page with no text layer is reported as needing OCR rather than silently
            coming back empty.
          </div>
        </div>
      )}

      {files.length > 0 && !busy && (
        <div className={styles.files}>
          {shown.map((file) => (
            <div key={`${file.name}:${file.size}`} className={styles.file}>
              <span className={styles.fileName}>{file.name}</span>
              <span className={styles.fileSize}>{size(file.size)}</span>
              <button
                type="button"
                className={styles.fileDrop}
                onClick={() => setFiles((c) => c.filter((f) => f !== file))}
                aria-label={`Remove ${file.name}`}
              >
                ×
              </button>
            </div>
          ))}
          {files.length > shown.length && (
            <div className={styles.filesMore}>and {files.length - shown.length} more</div>
          )}
        </div>
      )}

      <div className={styles.row}>
        <input
          className={styles.nameInput}
          placeholder="Name this pile"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={busy}
          aria-label="Name this pile"
        />
        <button className={shell.btn} data-variant="primary" disabled={busy || files.length === 0}>
          {busy ? 'Sifting…' : 'Sift it'}
        </button>
      </div>

      {progress && (
        <div className={styles.progress} role="status" aria-live="polite">
          <div className={styles.stages}>
            {STAGES.map((stage, i) => {
              const state = i < activeIndex || progress.stage === 'done' ? 'done'
                : i === activeIndex ? 'active'
                : 'waiting';
              return (
                <div key={stage.key} className={styles.stage} data-state={state}>
                  <span className={styles.mark} aria-hidden="true">
                    {state === 'done' ? '✓' : state === 'active' ? <span className={styles.spinner} /> : '·'}
                  </span>
                  <span className={styles.stageLabel}>
                    {stage.label}
                    {state === 'active' && progress.message && (
                      <> <span className={styles.stageDetail}>{progress.message}</span></>
                    )}
                  </span>
                  <span className={styles.count}>
                    {state === 'active' && progress.total > 1
                      ? `${progress.done}/${progress.total}`
                      : ''}
                  </span>
                </div>
              );
            })}
          </div>
          <div className={styles.bar}>
            <div
              className={styles.barFill}
              style={{
                width: `${Math.round(
                  ((Math.max(0, activeIndex) + (progress.total ? progress.done / progress.total : 0))
                    / STAGES.length) * 100,
                )}%`,
              }}
            />
          </div>
        </div>
      )}

      {error && (
        <div className={shell.notice} data-tone="warn" style={{ marginTop: 12 }}>
          <span aria-hidden="true">⚠</span><div>{error}</div>
        </div>
      )}
    </form>
  );
}
