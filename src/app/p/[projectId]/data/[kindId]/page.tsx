import { notFound } from 'next/navigation';
import { withDb } from '@/lib/db/client';
import { Shell } from '@/components/ui/Shell';
import { DataView } from '@/components/DataView';

export const dynamic = 'force-dynamic';

export default async function DataPage({
  params,
}: { params: Promise<{ projectId: string; kindId: string }> }) {
  const { projectId, kindId } = await params;
  const info = await withDb(async (c) => {
    const { rows } = await c.query<{ name: string; project: string; table_name: string | null }>(
      `SELECT k.name, p.name AS project, k.table_name
         FROM kinds k JOIN projects p ON p.id = k.project_id WHERE k.id = $1`,
      [kindId],
    );
    return rows[0];
  });
  if (!info) notFound();

  return (
    <Shell
      crumbs={[
        { label: info.project, href: `/p/${projectId}` },
        { label: info.name, strong: true },
      ]}
      tabs={[
        { label: 'Schema', href: `/p/${projectId}`, active: false },
        { label: 'Review', href: `/p/${projectId}/review/${kindId}`, active: false },
        { label: 'Data', href: `/p/${projectId}/data/${kindId}`, active: true },
      ]}
    >
      <DataView kindId={kindId} table={info.table_name} />
    </Shell>
  );
}
