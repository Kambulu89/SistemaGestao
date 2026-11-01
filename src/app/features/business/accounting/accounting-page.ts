import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { PermissionService } from '../../../core/permissions/permission.service';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import { Alert } from '../../../shared/ui/alert/alert';
import { EmptyState } from '../../../shared/ui/empty-state/empty-state';
import { LoadingState } from '../../../shared/ui/loading-state/loading-state';
import { PageHeader } from '../../../shared/ui/page-header/page-header';
import { Select, type SelectOption } from '../../../shared/ui/select/select';
import { AccountingApi } from './accounting.api';
import { accountingError } from './accounting-model';
import { ChartTab } from './chart-tab';
import { EntriesTab } from './entries-tab';
import { LedgerTab } from './ledger-tab';
import { PeriodsTab } from './periods-tab';
import { RulesTab } from './rules-tab';
import { TrialTab } from './trial-tab';

type TabId = 'entries' | 'chart' | 'ledger' | 'trial' | 'periods' | 'rules';

const TABS: readonly { id: TabId; label: string }[] = [
  { id: 'entries', label: 'Lançamentos' },
  { id: 'chart', label: 'Plano de contas' },
  { id: 'ledger', label: 'Razão' },
  { id: 'trial', label: 'Balancete' },
  { id: 'periods', label: 'Exercícios e diários' },
  { id: 'rules', label: 'Regras de contabilização' },
];

/** Contabilidade geral (ERP E1): tudo por empresa, que se escolhe no topo. */
@Component({
  selector: 'app-accounting-page',
  imports: [
    FormsModule,
    Alert,
    EmptyState,
    LoadingState,
    PageHeader,
    Select,
    ChartTab,
    EntriesTab,
    LedgerTab,
    PeriodsTab,
    RulesTab,
    TrialTab,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-page-header
      title="Contabilidade"
      description="Plano de contas, exercícios, diários e lançamentos de partidas dobradas, com razão e balancete. Lançado é definitivo: corrige-se por reversão."
    />
    @if (organizations.isLoading() && !organizations.hasValue()) {
      <app-loading-state label="A carregar empresas…" />
    } @else if (organizations.error()) {
      <app-alert tone="danger">{{ describe(organizations.error()) }}</app-alert>
    } @else if (organizationOptions().length === 0) {
      <app-empty-state icon="building" title="Sem empresas: crie uma em Organização" />
    } @else {
      <div class="mb-4 w-80">
        <app-select
          label="Empresa"
          [options]="organizationOptions()"
          [ngModel]="organizationId()"
          (ngModelChange)="organizationId.set($event ?? '')"
        />
      </div>
      <div
        class="mb-5 flex flex-wrap gap-1 border-b border-line"
        role="tablist"
        aria-label="Contabilidade"
      >
        @for (tab of tabs; track tab.id) {
          <button
            type="button"
            role="tab"
            class="-mb-px border-b-2 px-4 py-2 text-sm font-medium"
            [class.border-brand-600]="active() === tab.id"
            [class.text-brand-700]="active() === tab.id"
            [class.border-transparent]="active() !== tab.id"
            [class.text-fg-muted]="active() !== tab.id"
            [attr.aria-selected]="active() === tab.id"
            [attr.data-testid]="'tab-' + tab.id"
            (click)="active.set(tab.id)"
          >
            {{ tab.label }}
          </button>
        }
      </div>
      @if (organizationId(); as org) {
        @switch (active()) {
          @case ('entries') {
            <app-entries-tab [organizationId]="org" />
          }
          @case ('chart') {
            <app-chart-tab [organizationId]="org" />
          }
          @case ('ledger') {
            <app-ledger-tab [organizationId]="org" />
          }
          @case ('trial') {
            <app-trial-tab [organizationId]="org" />
          }
          @case ('periods') {
            <app-periods-tab [organizationId]="org" />
          }
          @case ('rules') {
            <app-rules-tab [organizationId]="org" />
          }
        }
      }
    }
  `,
})
export class AccountingPage {
  private readonly api = inject(AccountingApi);
  private readonly tenant = inject(TenantContextService).tenant;
  protected readonly permissions = inject(PermissionService);

  protected readonly tabs = TABS;
  protected readonly active = signal<TabId>('entries');
  protected readonly organizationId = signal('');

  protected readonly organizations = rxResource({
    params: () => {
      const t = this.tenant();
      return t ? { tenantId: t.id } : undefined;
    },
    stream: () => this.api.organizations(),
  });
  protected readonly organizationOptions = computed<readonly SelectOption[]>(() =>
    (this.organizations.hasValue() ? this.organizations.value() : []).map((o) => ({
      value: o.id,
      label: `${o.legalName} (${o.code})`,
    })),
  );

  constructor() {
    // A primeira empresa fica escolhida por omissão.
    effect(() => {
      const first = this.organizationOptions()[0]?.value;
      if (first && !this.organizationId()) this.organizationId.set(first);
    });
  }

  protected describe = (e: unknown) => accountingError(e, 'Não foi possível carregar as empresas.');
}
