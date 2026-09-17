'use client';

/**
 * Two pieces of motion, both of which exist to answer a question rather than to decorate.
 *
 * Hand-rolled rather than pulled from a library. Not on principle — the two things needed
 * here are specific enough that a general-purpose animation library would be configured
 * into doing exactly this anyway, and the Web Animations API already runs off the main
 * thread. The interesting part is not how the tween is driven, it is deciding what should
 * move and why.
 */

const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * Fly a value from the list to the place on the page it came from.
 *
 * This is the one piece of motion that carries information. A reviewer is asked to check
 * a value against a document, and the question underneath that task is always "where on
 * this page did that come from?". Cutting between the two states makes the person find
 * the answer themselves, every time, for every cell. Moving the value there answers it
 * before they have to ask — and because the eye tracks a moving object automatically,
 * it costs no attention at all.
 *
 * The ghost is a real DOM node appended to the body, so it can travel across the
 * scrolling boundary between the two panes without being clipped by either.
 */
export function flyToRegion(
  from: DOMRect,
  to: DOMRect,
  text: string,
  onDone?: () => void,
): void {
  if (prefersReducedMotion() || typeof document === 'undefined') { onDone?.(); return; }

  const ghost = document.createElement('div');
  ghost.textContent = text;
  Object.assign(ghost.style, {
    position: 'fixed',
    left: '0',
    top: '0',
    margin: '0',
    padding: '2px 6px',
    borderRadius: '4px',
    font: '600 12.5px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace',
    color: 'var(--text-inverse)',
    background: 'var(--accent)',
    boxShadow: '0 6px 20px rgb(16 24 40 / 0.25)',
    whiteSpace: 'nowrap',
    pointerEvents: 'none',
    zIndex: '9999',
    transformOrigin: 'left top',
  } satisfies Partial<CSSStyleDeclaration>);
  document.body.appendChild(ghost);

  const ghostRect = ghost.getBoundingClientRect();
  // Scale the ghost to the size of the region it is landing on, so it arrives the same
  // size as the text underneath it rather than sitting on top at the wrong scale.
  const scale = Math.max(0.4, Math.min(2, to.height / Math.max(1, ghostRect.height)));

  const animation = ghost.animate(
    [
      { transform: `translate(${from.left}px, ${from.top}px) scale(1)`, opacity: 1 },
      {
        transform: `translate(${to.left}px, ${to.top + (to.height - ghostRect.height * scale) / 2}px) scale(${scale})`,
        opacity: 0,
      },
    ],
    { duration: 420, easing: EASE, fill: 'forwards' },
  );

  animation.addEventListener('finish', () => { ghost.remove(); onDone?.(); });
  // A cancelled animation must still clean up its node, or a fast reviewer leaves a trail
  // of ghosts stuck to the page.
  animation.addEventListener('cancel', () => { ghost.remove(); onDone?.(); });
}

/**
 * FLIP: make a list reorder look like things moving rather than things blinking.
 *
 * Confirming an item removes it, and every item below jumps up by one row. That jump is
 * the moment a reviewer loses their place — the thing they were about to look at is
 * suddenly somewhere else and they have to re-find it. Sliding instead preserves the
 * thread, and it costs one measurement before the change and one transform after.
 *
 * Call `record()` before the state update and `play()` in a layout effect after.
 */
export function createFlip() {
  let previous = new Map<string, DOMRect>();

  return {
    record(container: HTMLElement | null) {
      previous = new Map();
      if (!container) return;
      for (const el of container.querySelectorAll<HTMLElement>('[data-flip-key]')) {
        previous.set(el.dataset.flipKey!, el.getBoundingClientRect());
      }
    },

    play(container: HTMLElement | null) {
      if (!container || prefersReducedMotion()) { previous = new Map(); return; }
      for (const el of container.querySelectorAll<HTMLElement>('[data-flip-key]')) {
        const before = previous.get(el.dataset.flipKey!);
        if (!before) {
          // New to the list: fade in rather than sliding from nowhere, which would imply
          // it came from somewhere it did not.
          el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: EASE });
          continue;
        }
        const after = el.getBoundingClientRect();
        const dy = before.top - after.top;
        if (Math.abs(dy) < 1) continue;
        el.animate(
          [{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }],
          { duration: 300, easing: EASE },
        );
      }
      previous = new Map();
    },
  };
}
