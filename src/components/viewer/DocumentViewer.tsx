'use client';

/**
 * Rendering a page and pointing at a piece of it.
 *
 * The whole value of this component is that the highlight sits *exactly* on the text it
 * claims to describe. A box two millimetres out reads as a bug in the extraction rather
 * than a bug in the drawing, and quietly destroys the user's trust in numbers that are
 * actually correct.
 *
 * Getting that right is a coordinate-space problem with one trap in it. The parser
 * normalised every box into viewport space at scale 1 — and crucially, for a page a
 * scanner left sideways, it did so under a *corrected* rotation so the text reads
 * upright. If the viewer renders at the page's declared rotation instead, the image and
 * the boxes disagree by ninety degrees. So the rotation the parser settled on travels
 * with the document and is used here; `stored.rotation` is not a detail, it is the
 * contract between the two halves.
 *
 * After that it is a single multiply: box coordinates are in points at scale 1, the
 * canvas is rendered at `scale`, so screen position is `box * scale`. No per-page
 * calibration, no fudge factors.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import styles from './DocumentViewer.module.css';

export type Box = { x: number; y: number; w: number; h: number };

export type Region = {
  id: string;
  page: number;
  box: Box;
  labelBox?: Box | null;
  tone?: 'sure' | 'likely' | 'unsure';
};

export type StoredPage = {
  index: number;
  width: number;
  height: number;
  /** The rotation the parser used. Must be reused here or the overlay will not align. */
  rotation: number;
  textRotationCorrected: number;
};

type Props = {
  documentId: string;
  pages: StoredPage[];
  regions: Region[];
  activeId: string | null;
  onSelect?: (id: string) => void;
  /** Called with the on-screen rect of the active region, for the shared-element morph. */
  onActiveRect?: (rect: DOMRect | null) => void;
};

export function DocumentViewer({
  documentId, pages, regions, activeId, onSelect, onActiveRect,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const activeRef = useRef<HTMLDivElement>(null);
  const renderTask = useRef<{ cancel: () => void } | null>(null);

  const active = useMemo(() => regions.find((r) => r.id === activeId) ?? null, [regions, activeId]);
  const pageIndex = active?.page ?? 0;
  const stored = pages[pageIndex] ?? pages[0];

  const [scale, setScale] = useState(1);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);

  // --- render --------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setStatus('loading');
      try {
        const pdfjs = await import('pdfjs-dist');
        // The worker is served from /public rather than bundled: it is 1.4MB of code that
        // must run off the main thread, and letting the bundler inline it would both
        // bloat the entry chunk and defeat the point.
        pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';

        const doc = await pdfjs.getDocument({ url: `/api/documents/${documentId}/file` }).promise;
        if (cancelled) return;
        const page = await doc.getPage(pageIndex + 1);
        if (cancelled) return;

        const canvas = canvasRef.current;
        const container = scrollRef.current;
        if (!canvas || !container) return;

        // Fit the page to the available width, leaving the padding alone, and never
        // enlarge past 1.6 — a blown-up scan is not more readable, just bigger.
        const available = container.clientWidth - 48;
        const base = page.getViewport({ scale: 1, rotation: stored?.rotation });
        const fitted = Math.min(1.6, Math.max(0.4, available / base.width));
        const viewport = page.getViewport({ scale: fitted, rotation: stored?.rotation });

        // Render at device resolution and scale back down with CSS, so text stays crisp
        // on a retina display instead of being upscaled from a 1x bitmap.
        const dpr = Math.min(3, window.devicePixelRatio || 1);
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;

        const context = canvas.getContext('2d');
        if (!context) return;
        context.setTransform(dpr, 0, 0, dpr, 0, 0);

        renderTask.current?.cancel();
        const task = page.render({ canvasContext: context, viewport });
        renderTask.current = task;
        await task.promise;

        if (!cancelled) { setScale(fitted); setStatus('ready'); }
      } catch (err) {
        if (cancelled) return;
        // A render that was superseded is not a failure; only report real ones.
        if ((err as { name?: string }).name === 'RenderingCancelledException') return;
        setError((err as Error).message);
        setStatus('error');
      }
    })();

    return () => { cancelled = true; renderTask.current?.cancel(); };
  }, [documentId, pageIndex, stored?.rotation]);

  // --- keep the active region in view --------------------------------------

  useEffect(() => {
    if (!active || status !== 'ready') return;
    const el = activeRef.current;
    const container = scrollRef.current;
    if (!el || !container) return;

    // Scroll so the region sits in the upper third rather than dead centre: the eye
    // expects to read downward from what it just found, and centring puts the context
    // that follows it off-screen.
    const target = el.offsetTop - container.clientHeight / 3;
    container.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });

    // Report the rect once the scroll has settled, so the morph lands where the box
    // actually ends up rather than where it started.
    const report = () => onActiveRect?.(el.getBoundingClientRect());
    const timer = setTimeout(report, 320);
    return () => clearTimeout(timer);
  }, [active, status, onActiveRect]);

  const place = useCallback(
    (box: Box) => ({
      left: box.x * scale,
      top: box.y * scale,
      width: Math.max(2, box.w * scale),
      height: Math.max(2, box.h * scale),
    }),
    [scale],
  );

  const onPage = regions.filter((r) => r.page === pageIndex);

  return (
    <div className={styles.frame}>
      {/* Pinned to the viewport rather than to the page, so scrolling to a region three
          pages down does not scroll away the label saying which page you are on. */}
      <div className={styles.tags}>
        <span className={styles.pageTag}>
          page {pageIndex + 1} of {pages.length}
        </span>
        {stored?.textRotationCorrected ? (
          <span className={styles.rotatedTag}>
            rotated {stored.textRotationCorrected}° — straightened
          </span>
        ) : null}
      </div>

      <div className={styles.root} ref={scrollRef}>
        <div className={styles.stage}>
          <canvas ref={canvasRef} className={styles.page} />

          <div className={styles.overlay}>
            {onPage.map((region) => {
              const isActive = region.id === activeId;
              return (
                <div key={region.id}>
                  {region.labelBox && (
                    <div
                      className={styles.labelBox}
                      data-active={isActive}
                      style={place(region.labelBox)}
                      aria-hidden="true"
                    />
                  )}
                  {region.labelBox && isActive && (
                    <Connector from={region.labelBox} to={region.box} scale={scale} />
                  )}
                  <div
                    ref={isActive ? activeRef : undefined}
                    className={styles.box}
                    data-tone={region.tone}
                    data-active={isActive}
                    style={place(region.box)}
                    onClick={() => onSelect?.(region.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect?.(region.id); }
                    }}
                    aria-label="Where this value was found on the page"
                  />
                </div>
              );
            })}
          </div>

          {status !== 'ready' && (
            <div className={styles.status}>
              {status === 'loading' ? 'Rendering the page…' : `Could not render: ${error}`}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * A dotted line from the label to the value it points at.
 *
 * Small, and it answers the question the highlight alone leaves open: *why* is this the
 * invoice number? Because that word over there says so. Drawn only for the active region,
 * because drawing it for all of them turns the page into a cat's cradle.
 */
function Connector({ from, to, scale }: { from: Box; to: Box; scale: number }) {
  const x1 = (from.x + from.w) * scale;
  const y1 = (from.y + from.h / 2) * scale;
  const x2 = to.x * scale;
  const y2 = (to.y + to.h / 2) * scale;

  const left = Math.min(x1, x2) - 4;
  const top = Math.min(y1, y2) - 4;
  const width = Math.abs(x2 - x1) + 8;
  const height = Math.abs(y2 - y1) + 8;

  return (
    <svg
      className={styles.connector}
      data-active="true"
      style={{ left, top, width, height }}
      aria-hidden="true"
    >
      <path
        className={styles.connectorLine}
        d={`M ${x1 - left} ${y1 - top} L ${x2 - left} ${y2 - top}`}
      />
    </svg>
  );
}
