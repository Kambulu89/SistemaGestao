import { Component, computed, effect, inject, input, untracked } from '@angular/core';
import { Api } from '../core/api';
import { Workspace } from '../core/workspace';
import { formatDateTime } from './dates';
import { ErrorAlert } from './error-alert';
import { Loadable } from './load';

interface AuditEvent {
  id: string;
  occurredAt: string;
  action: string;
  changes: Record<string, { from: unknown; to: unknown }> | null;
  actor: { fullName: string | null; email: string } | null;
}

/** Histórico de um registo (auditoria). Só aparece com `audit.read`; os outros membros não vêem a secção. */
@Component({
  selector: 'app-audit-history',
  imports: [ErrorAlert],
  template: `
    @if (allowed()) {
      <section class="card" aria-labelledby="history-title">
        <h2 id="history-title" class="font-semibold">Histórico</h2>
        <app-error-alert [error]="events.error()" />
        @if (events.loading()) {
          <p class="mt-2 text-sm text-muted">A carregar…</p>
        } @else if ((events.value() ?? []).length === 0) {
          <p class="mt-2 text-sm text-muted">Sem eventos.</p>
        } @else {
          <ol class="mt-3 space-y-3 border-l border-border pl-4">
            @for (e of events.value(); track e.id) {
              <li class="text-sm">
                <p>
                  <span class="font-medium">{{ actionLabel(e.action) }}</span>
                  <span class="text-muted">
                    · {{ e.actor?.fullName ?? e.actor?.email ?? 'Sistema' }} ·
                    {{ when(e.occurredAt) }}</span
                  >
                </p>
                @for (c of changes(e); track c.field) {
                  <p class="text-xs text-muted">{{ c.field }}: {{ c.from }} → {{ c.to }}</p>
                }
              </li>
            }
          </ol>
        }
      </section>
    }
  `,
})
export class AuditHistory {
  readonly entityType = input.required<string>();
  readonly entityId = input.required<string>();
  /** Muda para recarregar (ex.: versão do registo depois de guardar). */
  readonly refreshKey = input<unknown>(null);
  private readonly api = inject(Api);
  private readonly workspace = inject(Workspace);
  protected readonly allowed = computed(() => this.workspace.can('audit.read'));
  protected readonly when = formatDateTime;
  protected readonly events = new Loadable(
    async () =>
      (
        await this.api.page<AuditEvent>('audit-events', {
          entityType: this.entityType(),
          entityId: this.entityId(),
          limit: 20,
        })
      ).items,
  );

  constructor() {
    effect(() => {
      this.entityType();
      this.entityId();
      this.refreshKey();
      if (this.allowed()) untracked(() => void this.events.load());
    });
  }

  protected actionLabel(action: string) {
    const verb = action.split('.').pop() ?? action;
    const labels: Record<string, string> = {
      created: 'Criado',
      updated: 'Alterado',
      deleted: 'Eliminado',
      suspended: 'Suspenso',
      reactivated: 'Reactivado',
      invited: 'Convidado',
      invitation_accepted: 'Convite aceite',
      role_assigned: 'Perfil atribuído',
      role_unassigned: 'Perfil retirado',
      published: 'Publicado',
      retired: 'Retirado',
      submitted: 'Submetido',
      approved: 'Aprovado',
      accepted: 'Aceite',
      rejected: 'Rejeitado',
      checked: 'Conferido',
      reopened: 'Reaberto',
      confirmed: 'Confirmado',
      reversed: 'Estornado',
      closed: 'Fechado',
      cancelled: 'Anulado',
      picked: 'Separado',
      dispatched: 'Expedido',
      received: 'Recebido',
      issued: 'Entregue',
      released: 'Libertado',
      started: 'Iniciado',
      counted: 'Contado',
      line_added: 'Artigo acrescentado',
      justified: 'Justificado',
      recount_requested: 'Recontagem pedida',
      blocked: 'Bloqueado',
      unblocked: 'Desbloqueado',
      recalled: 'Recolhido',
      adjusted: 'Custo ajustado',
      accounts_set: 'Contas configuradas',
      retried: 'Repetido',
      purchase_receipt: 'Recepção de compra',
      sale_reservation: 'Reserva de venda',
      sale_release: 'Reserva libertada',
      sale_delivery: 'Entrega de venda',
      sale_return: 'Devolução de cliente',
      contact_added: 'Contacto acrescentado',
      contact_updated: 'Contacto alterado',
      bank_account_requested: 'Conta bancária registada',
      bank_account_approved: 'Conta bancária aprovada',
      bank_account_rejected: 'Conta bancária recusada',
      bank_account_deactivated: 'Conta bancária desactivada',
      document_added: 'Documento entregue',
      document_deactivated: 'Documento desactivado',
      step_approved: 'Etapa aprovada',
      copied: 'Copiada',
      amended: 'Revisto',
      opened: 'Propostas abertas',
      quote_received: 'Proposta registada',
      'rfq.issued': 'Emitido',
      'purchase_order.issued': 'Emitida',
      'purchase_invoice.validated': 'Validada',
      'purchase_invoice.created': 'Registada',
      'purchase_invoice.refused': 'Devolvida ao fornecedor',
      divergent: 'Com divergências',
      exception_approved: 'Excepção autorizada',
      exception_rejected: 'Excepção recusada',
      'purchase_receipt.confirmed': 'Confirmada',
      'purchase_receipt.reversed': 'Estornada',
      'purchase_receipt.created': 'Registada',
      'purchase_return.created': 'Registada',
      'purchase_return.confirmed': 'Confirmada',
      'purchase_return.cancelled': 'Anulada',
      'purchase_credit_note.created': 'Registada',
      'purchase_credit_note.validated': 'Validada',
      'purchase_credit_note.cancelled': 'Anulada',
      'procurement_payable.paid': 'Pagamento registado',
      'procurement_payable.accounting_retried': 'Contabilização repetida',
      'procurement_budget.created': 'Verba criada',
      'procurement_budget.updated': 'Verba alterada',
      'supplier_evaluation.published': 'Avaliação publicada',
      'supplier_evaluation.weights_updated': 'Pesos da avaliação alterados',
      'customer.created': 'Cliente criado',
      'customer.updated': 'Cliente alterado',
      'customer.credit_limit_changed': 'Limite de crédito alterado',
      'customer.status_changed': 'Estado do cliente alterado',
      'customer.address_added': 'Morada acrescentada',
      'customer.address_updated': 'Morada alterada',
      'customer_segment.created': 'Segmento criado',
      'customer_segment.updated': 'Segmento alterado',
      'price_list.created': 'Tabela criada',
      'price_list.updated': 'Tabela alterada',
      'price_list.line_added': 'Preço acrescentado',
      'price_list.line_updated': 'Preço alterado',
      'price_list.line_removed': 'Preço removido',
      'price_list.submitted': 'Submetida para aprovação',
      'price_list.approved': 'Aprovada',
      'price_list.rejected': 'Devolvida',
      'price_list.deactivated': 'Inactivada',
      'discount_rule.created': 'Regra criada',
      'discount_rule.updated': 'Regra alterada',
      'discount_rule.submitted': 'Submetida para aprovação',
      'discount_rule.approved': 'Aprovada',
      'discount_rule.rejected': 'Devolvida',
      'discount_rule.deactivated': 'Inactivada',
      'discount_limit.set': 'Limite de desconto definido',
      'discount_limit.removed': 'Limite de desconto removido',
      'sales_quote.created': 'Orçamento criado',
      'sales_quote.updated': 'Orçamento alterado',
      'sales_quote.submitted': 'Submetido',
      'sales_quote.approved': 'Aprovado',
      'sales_quote.rejected': 'Devolvido',
      'sales_quote.sent': 'Enviado ao cliente',
      'sales_quote.accepted': 'Aceite pelo cliente',
      'sales_quote.declined': 'Recusado pelo cliente',
      'sales_quote.revised': 'Revisto (nova versão)',
      'sales_quote.cancelled': 'Anulado',
      'sales_quote.converted': 'Convertido em encomenda',
      'sales_order.created': 'Encomenda criada',
      'sales_order.updated': 'Encomenda alterada',
      'sales_order.submitted': 'Submetida',
      'sales_order.approved': 'Aprovada e confirmada',
      'sales_order.rejected': 'Devolvida',
      'sales_order.reserved': 'Reservada no inventário',
      'sales_order.released': 'Reserva libertada',
      'sales_order.delivered': 'Expedida',
      'sales_order.closed': 'Fechada',
      'sales_order.cancelled': 'Anulada',
      'tax_code.created': 'Imposto criado',
      'tax_code.updated': 'Imposto alterado',
      'tax_rate.created': 'Taxa preparada',
      'tax_rate.updated': 'Taxa alterada',
      'tax_rate.deleted': 'Taxa apagada (rascunho)',
      'tax_rate.confirmed': 'Taxa confirmada',
      'tax_rate.retired': 'Taxa retirada',
      'tax_exemption.created': 'Isenção preparada',
      'tax_exemption.updated': 'Isenção alterada',
      'tax_exemption.confirmed': 'Isenção confirmada',
      'tax_exemption.retired': 'Isenção retirada',
      'tax_settings.updated': 'Arredondamento alterado',
      'fiscal_series.created': 'Série criada',
      'fiscal_series.updated': 'Série alterada',
      'fiscal_series.activated': 'Série activada',
      'fiscal_series.closed': 'Série fechada',
      terminated: 'Terminado',
      amendment_proposed: 'Adenda proposta',
      'purchase_contract.amended': 'Adenda aplicada',
      renewed: 'Renovado',
      amendment_rejected: 'Adenda recusada',
      amendment_cancelled: 'Adenda anulada',
      revised: 'Revisão aberta',
    };
    return labels[action] ?? labels[verb] ?? action;
  }

  protected changes(e: AuditEvent) {
    const show = (v: unknown) =>
      v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return Object.entries(e.changes ?? {}).map(([field, c]) => ({
      field,
      from: show(c.from),
      to: show(c.to),
    }));
  }
}
