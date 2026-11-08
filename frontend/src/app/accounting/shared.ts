import { inject } from '@angular/core';
import { Api, ApiError } from '../core/api';
import { Workspace } from '../core/workspace';
import { type OrgRecord, recordLabel } from '../admin/org-kinds';
import { formatMoney } from '../ui/money-input';
import type { ConfirmService } from '../ui/confirm';

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

/**
 * Listas de referência de uma entidade legal para os formulários de activos fixos: diários activos, contas
 * movimentáveis activas do plano activo e centros de custo activos (só com `organization.read`).
 */
export async function entityReferences(api: Api, workspace: Workspace, legalEntityId: string) {
  const [journals, charts] = await Promise.all([
    api.page<{ id: string; code: string; name: string; status: string }>('accounting/journals', {
      legalEntityId,
      status: 'ACTIVE',
      limit: 200,
    }),
    api.page<{ id: string }>('accounting/charts', { legalEntityId, status: 'ACTIVE', limit: 1 }),
  ]);
  const chart = charts.items[0];
  const accounts = chart
    ? (
        await api.page<{ id: string; code: string; name: string; status: string }>(
          'accounting/accounts',
          { chartId: chart.id, postable: 'true', limit: 500 },
        )
      ).items.filter((a) => a.status === 'ACTIVE')
    : [];
  const centers = workspace.can('organization.read')
    ? (
        await api.page<OrgRecord>('organization/cost-centers', {
          legalEntityId,
          status: 'ACTIVE',
          limit: 200,
        })
      ).items.map((r) => ({ id: r.id, label: recordLabel(r) }))
    : [];
  return {
    journals: journals.items.map((j) => ({ id: j.id, label: `${j.code} — ${j.name}` })),
    accounts: accounts.map((a) => ({ id: a.id, label: `${a.code} — ${a.name}` })),
    centers,
  };
}

/** Montante da API (texto com as casas da empresa) formatado para leitura, com sinal. */
export function moneyText(v: string | null | undefined) {
  if (v === null || v === undefined || v === '') return '—';
  const negative = v.startsWith('-');
  const abs = negative ? v.slice(1) : v;
  const text = formatMoney(abs, abs.includes('.') ? abs.split('.')[1].length : 0);
  return negative ? `-${text}` : text;
}

/**
 * Depois de mudar de entidade legal: limpa as escolhas (diário, contas, centro de custo) que não existem nas listas
 * da nova entidade, para nunca se enviar uma referência de outra entidade.
 */
export function keepKnown<T extends object>(
  form: T,
  keys: readonly (keyof T)[],
  options: readonly { id: string }[],
) {
  const known = new Set(options.map((o) => o.id));
  const target = form as Record<keyof T, unknown>;
  for (const k of keys) if (target[k] && !known.has(target[k] as string)) target[k] = null;
}

/**
 * Fecha um período: se a checklist só tiver avisos, mostra-os e, com confirmação, repete reconhecendo-os (fica na
 * auditoria). Bloqueios e outros erros sobem para quem chamou. Devolve undefined se o utilizador desistir.
 */
export async function closeWithWarnings<T>(
  api: Api,
  confirm: ConfirmService,
  periodId: string,
  name: string,
): Promise<T | undefined> {
  try {
    return await api.post<T>(`accounting/periods/${periodId}/close`, {});
  } catch (e) {
    const err = ApiError.from(e);
    if (err.code !== 'CLOSE_WARNINGS') throw err;
    const ok = await confirm.ask({
      title: `Fechar ${name} com avisos`,
      message: err.details.map((d) => d.message).join(' '),
      confirmLabel: 'Fechar mesmo assim',
    });
    if (!ok) return undefined;
    return api.post<T>(`accounting/periods/${periodId}/close`, { acknowledgeWarnings: true });
  }
}
