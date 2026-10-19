import { pageRequestToParams } from '../../api/api.service';
import type { RecordQuery } from '../models/entity-record.model';

/**
 * Caminhos PROPOSTOS para a futura API REST (relativos ao `apiUrl`). Não são endpoints existentes:
 * servem de contrato para o adapter HTTP e para o backend implementar. O tenant viaja no
 * cabeçalho `X-Tenant-Id`, nunca no caminho.
 */
export const ENTITY_API = {
  /** GET (lista de entidades do tenant) · POST (criar entidade/rascunho) */
  entities: () => 'v1/entities',
  /** GET (definição em vigor) */
  definition: (key: string) => `v1/entities/${encodeURIComponent(key)}/definition`,
  /** GET (listagem paginada) · POST (criar registo) */
  records: (key: string) => `v1/entities/${encodeURIComponent(key)}/records`,
  /** GET · PATCH (actualizar, com `If-Match`/rowVersion) · DELETE */
  record: (key: string, id: string) =>
    `v1/entities/${encodeURIComponent(key)}/records/${encodeURIComponent(id)}`,
  /** POST `{ transition }` */
  transitions: (key: string, id: string) => `${ENTITY_API.record(key, id)}/transitions`,
  /** GET (histórico de auditoria) */
  audit: (key: string, id: string) => `${ENTITY_API.record(key, id)}/audit`,
  /** GET `?search=` (opções para campos de referência) */
  lookup: (key: string) => `${ENTITY_API.records(key)}/lookup`,
} as const;

/** Parâmetros de query de uma listagem: paginação, ordenação, pesquisa e `filter.<campo>`. */
export function recordQueryParams(query: RecordQuery): Record<string, string | number | boolean> {
  const params: Record<string, string | number | boolean> = pageRequestToParams({
    page: query.page,
    pageSize: query.pageSize,
    sort: query.sort,
  });
  if (query.search) params['search'] = query.search;
  for (const [field, value] of Object.entries(query.filters ?? {}))
    params[`filter.${field}`] = value;
  return params;
}
