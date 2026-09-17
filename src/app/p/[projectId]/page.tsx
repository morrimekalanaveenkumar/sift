import { notFound } from 'next/navigation';
import { withDb } from '@/lib/db/client';
import { Shell } from '@/components/ui/Shell';
import { SchemaView, type Kind, type Field } from '@/components/SchemaView';

export const dynamic = 'force-dynamic';

export default async function ProjectPage({
  params,
}: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;

  const data = await withDb(async (c) => {
    const { rows: projects } = await c.query<{ id: string; name: string; status: string }>(
      `SELECT id, name, status FROM projects WHERE id = $1`, [projectId],
    );
    if (!projects[0]) return null;

    const { rows: kinds } = await c.query<Kind>(
      `SELECT k.id, k.name, k.table_name,
              (SELECT count(*) FROM documents d WHERE d.kind_id = k.id)::int AS documents,
              (SELECT count(*) FROM cells ce JOIN fields f ON f.id = ce.field_id
                WHERE f.kind_id = k.id AND f.included
                  AND ce.status = 'unreviewed' AND ce.confidence < 0.75)::int AS needs_review
         FROM kinds k WHERE k.project_id = $1
        ORDER BY (SELECT count(*) FROM documents d WHERE d.kind_id = k.id) DESC`,
      [projectId],
    );

    const { rows: fields } = await c.query<Field>(
      `SELECT f.id, f.kind_id, f.name, f.column_name, f.aliases, f.type,
              f.coverage, f.rationale, f.included
         FROM fields f JOIN kinds k ON k.id = f.kind_id
        WHERE k.project_id = $1 ORDER BY f.kind_id, f.position`,
      [projectId],
    );

    return { project: projects[0], kinds, fields };
  });

  if (!data) notFound();

  return (
    <Shell crumbs={[{ label: data.project.name, strong: true }]}>
      <SchemaView projectId={projectId} kinds={data.kinds} fields={data.fields} />
    </Shell>
  );
}
