'use client';

import Link from 'next/link';
import styles from './shell.module.css';

export function Shell({
  crumbs, tabs, children,
}: {
  crumbs: { label: string; href?: string; strong?: boolean }[];
  tabs?: { label: string; href: string; active: boolean }[];
  children: React.ReactNode;
}) {
  return (
    <div className={styles.app}>
      <header className={styles.top}>
        <Link href="/" className={styles.brand}>
          <span className={styles.brandMark} aria-hidden="true">◈</span>
          Sift
        </Link>
        {crumbs.map((c, i) => (
          <span key={i} style={{ display: 'contents' }}>
            <span className={styles.sep} />
            {c.href ? (
              <Link href={c.href} className={c.strong ? styles.crumbStrong : styles.crumb}>{c.label}</Link>
            ) : (
              <span className={c.strong ? styles.crumbStrong : styles.crumb}>{c.label}</span>
            )}
          </span>
        ))}
        <span className={styles.spacer} />
        {tabs && (
          <nav className={styles.tabs}>
            {tabs.map((t) => (
              <Link key={t.href} href={t.href} className={styles.tab} data-active={t.active}>
                {t.label}
              </Link>
            ))}
          </nav>
        )}
      </header>
      <div className={styles.body}>{children}</div>
    </div>
  );
}

/**
 * The stylesheet is deliberately *not* re-exported from here.
 *
 * `export { styles as shell }` from a 'use client' module looks harmless and works in
 * every client component that imports it. Import it from a *server* component and React
 * hands you a client reference proxy instead of the object, so every `shell.whatever`
 * silently evaluates to `undefined` and the page renders with no classes at all — styled
 * correctly in development-adjacent cases and completely unstyled where it matters.
 * Importing `shell.module.css` directly costs one line per file and cannot do that.
 */
