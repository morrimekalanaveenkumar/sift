import { ensureSchema, withDb } from '@/lib/db/client';
import { Shell } from '@/components/ui/Shell';
import shell from '@/components/ui/shell.module.css';
import { PileList } from '@/components/upload/PileList';
import { Upload } from '@/components/upload/Upload';

export const dynamic = 'force-dynamic';

export default async function Home() {
  let projects: { id: string; name: string; documents: number; kinds: number; status: string }[] = [];
  let error: string | null = null;

  try {
    await ensureSchema();
    projects = await withDb(async (c) => {
      const { rows } = await c.query(
        `SELECT p.id, p.name, p.status,
                (SELECT count(*) FROM documents d WHERE d.project_id = p.id)::int AS documents,
                (SELECT count(*) FROM kinds k WHERE k.project_id = p.id)::int AS kinds
           FROM projects p ORDER BY p.created_at DESC`,
      );
      return rows as typeof projects;
    });
  } catch (e) {
    error = (e as Error).message;
  }

  return (
    <Shell crumbs={[]}>
      <div className={shell.scroll}>
        <div className={shell.wrap}>
          <h1 className={shell.h1}>Turn a pile of documents into a table you can query.</h1>
          <p className={shell.lede}>
            Drop in documents of whatever kinds you have. Sift works out what they are, which
            fields they share even when every source names them differently, and turns the pile
            into a typed Postgres table — showing you exactly where every value came from.
          </p>

          {error && (
            <div className={shell.notice} data-tone="warn">
              <span aria-hidden="true">⚠</span>
              <div>
                <strong>Sift can’t reach its database.</strong> {error}
                <br />
                Run <code>npm run setup</code> to create it and load a demo pile.
              </div>
            </div>
          )}

          {projects.length > 0 && (
            <div className={shell.panel}>
              <div className={shell.panelHead}><span className={shell.panelTitle}>Piles</span></div>
              <PileList piles={projects} />
            </div>
          )}

          <div className={shell.panel}>
            <div className={shell.panelHead}>
              <span className={shell.panelTitle}>
                {projects.length ? 'Add another pile' : 'Start with a pile'}
              </span>
            </div>
            <div className={shell.panelBody}><Upload showDemo={projects.length === 0} /></div>
          </div>
        </div>
      </div>
    </Shell>
  );
}
