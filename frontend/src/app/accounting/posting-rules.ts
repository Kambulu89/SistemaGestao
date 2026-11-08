import { Component, computed, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { formatDate } from '../ui/dates';
import { Icon } from '../ui/icon';
import { Loadable } from '../ui/load';
import { EntityListPage } from '../ui/templates';
import { StatusBadge } from '../ui/status-badge';
import type { PostingRule } from './model';
import { accountingDeps, legalEntityOptions } from './shared';

/** Regras de contabilização: cada origem/evento de negócio → linhas com as contas escolhidas pela empresa. */
@Component({
  selector: 'app-posting-rules',
  imports: [RouterLink, EntityListPage, DataTable, CellDef, StatusBadge, Icon],
  template: `
    <app-entity-list-page
      title="Regras de contabilização"
      subtitle="Transformam eventos dos outros módulos (p. ex. factura emitida) em lançamentos. As contas são as do vosso plano."
      permission="accounting.read"
      feature="accounting"
    >
      @if (canManage()) {
        <a actions class="btn-primary" routerLink="/contabilidade/regras/novo"
          ><app-icon name="plus" [size]="16" />Nova regra</a
        >
      }

      <app-data-table
        tableId="acc-posting-rules"
        label="Regras de contabilização"
        [columns]="columns"
        [rows]="rules.value() ?? []"
        [total]="rules.value()?.length ?? 0"
        [loading]="rules.loading()"
        [error]="rules.error()"
        emptyText="Ainda não há regras."
        (retry)="rules.load()"
      >
        <ng-template appCell="status" let-row
          ><app-status-badge [status]="row.status"
        /></ng-template>
      </app-data-table>
    </app-entity-list-page>
  `,
})
export class PostingRules {
  private readonly deps = accountingDeps();
  protected readonly canManage = computed(() => this.deps.workspace.can('accounting.settings'));
  private readonly entities = signal<{ id: string; label: string }[]>([]);
  private readonly names = computed(() => new Map(this.entities().map((e) => [e.id, e.label])));
  protected readonly rules = new Loadable(
    async () =>
      (await this.deps.api.page<PostingRule>('accounting/posting-rules', { limit: 200 })).items,
  );
  protected readonly columns: Column<PostingRule>[] = [
    { key: 'code', required: true, label: 'Código', link: (r) => ['/contabilidade/regras', r.id] },
    { key: 'source', label: 'Origem / evento', value: (r) => `${r.source} · ${r.event}` },
    { key: 'name', label: 'Nome', hideOnMobile: true },
    {
      key: 'validFrom',
      label: 'Vigência',
      value: (r) => `${formatDate(r.validFrom)} – ${r.validTo ? formatDate(r.validTo) : '…'}`,
    },
    {
      key: 'legalEntityId',
      label: 'Entidade',
      hideOnMobile: true,
      value: (r) => this.names().get(r.legalEntityId) ?? '…',
    },
    {
      key: 'autoPost',
      label: 'Contabiliza',
      hideOnMobile: true,
      value: (r) => (r.autoPost ? 'Automaticamente' : 'Em rascunho'),
    },
    { key: 'status', label: 'Estado' },
  ];

  constructor() {
    void this.rules.load();
    legalEntityOptions(this.deps.api, this.deps.workspace).then(
      (e) => this.entities.set(e),
      () => undefined,
    );
  }
}
