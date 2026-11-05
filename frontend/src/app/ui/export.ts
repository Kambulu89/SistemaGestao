import type { Api } from '../core/api';
import { downloadText, toCsv } from './csv';
import type { Column } from './data-table';

/** Máximo de linhas exportadas de uma vez (evita pedidos sem fim; acima disto, filtre a lista). */
export const EXPORT_LIMIT = 5000;

/**
 * Exporta uma listagem para CSV: lê as páginas pela mesma API (com as permissões e filtros actuais do utilizador) e
 * escreve as colunas visíveis. Nada é calculado fora do que a API devolve.
 */
export async function exportList<T extends object>(
  api: Api,
  url: string,
  query: Record<string, string | number | boolean | null | undefined>,
  columns: Column<T>[],
  filename: string,
  pageSize = 100,
) {
  const rows: T[] = [];
  for (let offset = 0; offset < EXPORT_LIMIT; offset += pageSize) {
    const page = await api.page<T>(url, { ...query, limit: pageSize, offset });
    rows.push(...page.items);
    if (rows.length >= page.total || page.items.length === 0) break;
  }
  const value = (c: Column<T>, row: T) =>
    c.value ? c.value(row) : (row as Record<string, unknown>)[c.key];
  downloadText(
    filename,
    toCsv(
      columns.map((c) => c.label),
      rows.slice(0, EXPORT_LIMIT).map((row) => columns.map((c) => value(c, row))),
    ),
  );
  return rows.length;
}

/** A mesma consulta sem paginação (a exportação percorre as páginas). */
export function withoutPaging<Q extends Record<string, unknown>>(query: Q) {
  const rest: Record<string, unknown> = { ...query };
  delete rest['limit'];
  delete rest['offset'];
  return rest as Omit<Q, 'limit' | 'offset'>;
}
