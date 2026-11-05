import { inject } from '@angular/core';
import { Api } from '../core/api';
import { Workspace } from '../core/workspace';
import { type OrgRecord, recordLabel } from '../admin/org-kinds';

/** Entidades legais activas para escolher (cache da empresa em contexto). */
export async function legalEntityOptions(api: Api, workspace: Workspace) {
  const page = await workspace.cached('names:legal-entities', () =>
    api.page<OrgRecord>('organization/legal-entities', { limit: 200 }),
  );
  return page.items.map((r) => ({
    id: r.id,
    label: recordLabel(r),
    status: r['status'] as string,
  }));
}

/** Injecta os serviços usados por todas as páginas de contabilidade. */
export function accountingDeps() {
  return { api: inject(Api), workspace: inject(Workspace) };
}
