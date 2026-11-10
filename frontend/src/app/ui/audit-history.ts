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
    };
    return labels[verb] ?? action;
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
