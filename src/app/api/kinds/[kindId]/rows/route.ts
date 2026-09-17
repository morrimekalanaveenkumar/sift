import { handle } from '@/lib/api';
import { withDb } from '@/lib/db/client';

export const dynamic = 'force-dynamic';

/**
 * The query surface: search, filter and sort the structured result.
 *
 * Runs as real SQL against the committed table rather than filtering in the client,
 * because "queryable" has to mean something — the whole point of building a typed table
 * is that a date behaves like a date and an amount sorts like a number.
 *
 * Identifiers are quoted from a list of columns read out of the catalog, and every value
 * is a bind parameter. A user-supplied column name never reaches the SQL text unless it
 * matched a real column of this table first.
 */
export async function GET(request: Request, { params }: { params: Promise<{ kindId: string }> }) {
  return handle(async () => {
    const { kindId } = await params;
    const url = new URL(request.url);
    const search = url.searchParams.get('q')?.trim() ?? '';
    const sort = url.searchParams.get('sort') ?? '';
    const direction = url.searchParams.get('dir') === 'desc' ? 'DESC' : 'ASC';
    const limit = Math.min(500, Number(url.searchParams.get('limit') ?? 200));

    return withDb(async (c) => {
      const { rows: kinds } = await c.query<{ table_name: string | null; name: string }>(
        `SELECT table_name, name FROM kinds WHERE id = $1`, [kindId],
      );
      const kind = kinds[0];
      if (!kind) throw new Error('Kind not found');
      if (!kind.table_name) {
        return { columns: [], rows: [], committed: false, total: 0 };
      }

      // The set of legal identifiers, straight from the catalog. Anything not in here is
      // not a column, whatever the query string says.
      const { rows: columns } = await c.query<{ column_name: string; data_type: string }>(
        `SELECT column_name, data_type FROM information_schema.columns
          WHERE table_schema = 'sift' AND table_name = $1 ORDER BY ordinal_position`,
        [kind.table_name],
      );
      const legal = new Set(columns.map((c2) => c2.column_name));
      const quote = (n: string) => `"${n.replace(/"/g, '""')}"`;

      const conditions: string[] = [];
      const values: unknown[] = [];

      if (search) {
        // Search every column as text. Casting rather than restricting to text columns
        // means "2026-03" finds a date and "171120" finds an amount, which is what
        // somebody typing into one box expects.
        values.push(`%${search}%`);
        const term = `$${values.length}`;
        conditions.push(
          `(${columns.map((c2) => `${quote(c2.column_name)}::text ILIKE ${term}`).join(' OR ')})`,
        );
      }

      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const orderBy = legal.has(sort)
        ? `ORDER BY ${quote(sort)} ${direction} NULLS LAST`
        : `ORDER BY ${quote('document')} ASC`;

      const { rows } = await c.query(
        `SELECT * FROM sift.${quote(kind.table_name)} ${where} ${orderBy} LIMIT ${limit}`,
        values,
      );
      const { rows: counted } = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM sift.${quote(kind.table_name)} ${where}`,
        values,
      );

      return {
        committed: true,
        table: kind.table_name,
        columns,
        rows,
        total: Number(counted[0]?.n ?? 0),
      };
    });
  });
}
