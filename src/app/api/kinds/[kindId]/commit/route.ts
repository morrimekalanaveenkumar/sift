import { handle } from '@/lib/api';
import { commitKind } from '@/lib/extract/ingest';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(_: Request, { params }: { params: Promise<{ kindId: string }> }) {
  return handle(async () => {
    const { kindId } = await params;
    return commitKind(kindId);
  });
}
