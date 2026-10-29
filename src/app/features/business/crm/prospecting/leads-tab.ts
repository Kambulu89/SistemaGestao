import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import type { Observable } from 'rxjs';
import { PermissionService } from '../../../../core/permissions/permission.service';
import { TenantContextService } from '../../../../core/tenant-context/tenant-context.service';
import { Alert } from '../../../../shared/ui/alert/alert';
import { Badge } from '../../../../shared/ui/badge/badge';
import { Button } from '../../../../shared/ui/button/button';
import { Card } from '../../../../shared/ui/card/card';
import { Dialog } from '../../../../shared/ui/dialog/dialog';
import { EmptyState } from '../../../../shared/ui/empty-state/empty-state';
import { Input } from '../../../../shared/ui/input/input';
import { LoadingState } from '../../../../shared/ui/loading-state/loading-state';
import { Select, type SelectOption } from '../../../../shared/ui/select/select';
import { Table, type TableColumn } from '../../../../shared/ui/table/table';
import { OrganizationApi } from '../../../tenant/data-access/organization.api';
import {
  ProspectingApi,
  type ConsentStatus,
  type LeadDto,
  type LeadStatus,
} from './prospecting.api';
import { CONSENT, isMoney, LEAD_STATUS, prospectingError } from './prospecting-model';

const STATUS_OPTIONS: readonly SelectOption[] = (Object.keys(LEAD_STATUS) as LeadStatus[]).map(
  (value) => ({ value, label: LEAD_STATUS[value].label }),
);
const CONSENT_OPTIONS: readonly SelectOption[] = (Object.keys(CONSENT) as ConsentStatus[]).map(
  (value) => ({ value, label: CONSENT[value].label }),
);

/**
 * Leads: qualificar, desqualificar (com motivo) e converter. A conversão cria, numa só transacção, a pessoa ou
 * organização, o cliente e a oportunidade; repetir devolve os mesmos registos.
 */
@Component({
  selector: 'app-prospecting-leads',
  imports: [
    FormsModule,
    Alert,
    Badge,
    Button,
    Card,
    Dialog,
    EmptyState,
    Input,
    LoadingState,
    Select,
    Table,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="mb-3 flex flex-wrap items-end gap-3">
      <div class="min-w-56">
        <app-input label="Pesquisar" [ngModel]="q()" (ngModelChange)="q.set($event ?? '')" />
      </div>
      <div class="min-w-48">
        <app-select
          label="Estado"
          placeholder="Todos"
          [options]="statusOptions"
          [ngModel]="status()"
          (ngModelChange)="status.set($event ?? '')"
        />
      </div>
      @if (canManage()) {
        <app-button (click)="openCreate()">Nova lead</app-button>
      }
    </div>
    @if (notice(); as text) {
      <app-alert tone="success" class="mb-3 block" data-testid="notice">{{ text }}</app-alert>
    }
    @if (actionError(); as text) {
      <app-alert tone="danger" class="mb-3 block">{{ text }}</app-alert>
    }
    <app-card [flush]="true">
      @if (leads.isLoading() && !leads.hasValue()) {
        <app-loading-state label="A carregar leads…" />
      } @else if (leads.error()) {
        <div class="p-5">
          <app-alert tone="danger" title="Não foi possível carregar as leads">
            {{ describe(leads.error()) }}
          </app-alert>
        </div>
      } @else if (leads.hasValue() && leads.value(); as page) {
        @if (page.items.length === 0) {
          <app-empty-state icon="users" title="Sem leads" />
        } @else {
          <app-table caption="Leads" [columns]="columns" [rows]="page.items">
            <ng-template let-row let-column="column">
              @switch (column.key) {
                @case ('name') {
                  <span class="font-medium">{{ row.name }}</span>
                  @if (row.companyName) {
                    <span class="block text-xs text-fg-muted">{{ row.companyName }}</span>
                  }
                }
                @case ('contact') {
                  {{ row.email ?? '—' }}
                  @if (row.phone) {
                    <span class="block text-xs text-fg-muted">{{ row.phone }}</span>
                  }
                }
                @case ('source') {
                  {{ row.source }}
                }
                @case ('consent') {
                  <app-badge [tone]="consentOf(row.consentStatus).tone">{{
                    consentOf(row.consentStatus).label
                  }}</app-badge>
                }
                @case ('status') {
                  <app-badge [tone]="statusOf(row.status).tone">{{
                    statusOf(row.status).label
                  }}</app-badge>
                }
                @case ('actions') {
                  @if (canManage() && row.status !== 'CONVERTED') {
                    <span class="flex flex-wrap justify-end gap-1">
                      @if (row.status !== 'QUALIFIED') {
                        <app-button size="sm" variant="secondary" (click)="qualify(row)">{{
                          row.status === 'DISQUALIFIED' ? 'Requalificar' : 'Qualificar'
                        }}</app-button>
                      }
                      @if (row.status !== 'DISQUALIFIED') {
                        <app-button size="sm" variant="secondary" (click)="askDisqualify(row)"
                          >Desqualificar</app-button
                        >
                        <app-button size="sm" (click)="openConvert(row)">Converter</app-button>
                      }
                    </span>
                  }
                }
              }
            </ng-template>
          </app-table>
        }
      }
    </app-card>

    <app-dialog [open]="creating()" title="Nova lead" (closed)="creating.set(false)">
      @if (formError(); as text) {
        <app-alert tone="danger" class="mb-3 block">{{ text }}</app-alert>
      }
      <div class="space-y-3" data-testid="lead-form">
        <app-input label="Nome" [ngModel]="name()" (ngModelChange)="name.set($event ?? '')" />
        <app-input
          label="Empresa"
          [ngModel]="company()"
          (ngModelChange)="company.set($event ?? '')"
        />
        <app-input label="Email" [ngModel]="email()" (ngModelChange)="email.set($event ?? '')" />
        <app-input label="Telefone" [ngModel]="phone()" (ngModelChange)="phone.set($event ?? '')" />
        <app-input label="Origem" [ngModel]="source()" (ngModelChange)="source.set($event ?? '')" />
        <app-select
          label="Consentimento"
          [options]="consentOptions"
          [ngModel]="consent()"
          (ngModelChange)="consent.set($event ?? 'UNKNOWN')"
        />
      </div>
      <ng-container dialogActions>
        <app-button variant="secondary" (click)="creating.set(false)">Cancelar</app-button>
        <app-button [loading]="busy()" (click)="create()">Criar</app-button>
      </ng-container>
    </app-dialog>

    <app-dialog
      [open]="disqualifying() !== null"
      title="Desqualificar lead"
      (closed)="disqualifying.set(null)"
    >
      @if (formError(); as text) {
        <app-alert tone="danger" class="mb-3 block">{{ text }}</app-alert>
      }
      <app-input label="Motivo" [ngModel]="reason()" (ngModelChange)="reason.set($event ?? '')" />
      <ng-container dialogActions>
        <app-button variant="secondary" (click)="disqualifying.set(null)">Cancelar</app-button>
        <app-button [loading]="busy()" (click)="disqualify()">Desqualificar</app-button>
      </ng-container>
    </app-dialog>

    <app-dialog
      [open]="converting() !== null"
      title="Converter lead"
      (closed)="converting.set(null)"
    >
      @if (formError(); as text) {
        <app-alert tone="danger" class="mb-3 block">{{ text }}</app-alert>
      }
      <div class="space-y-3" data-testid="convert-form">
        <p class="text-sm text-fg-muted">
          Cria a pessoa ou organização (ou reutiliza a que já existe), o cliente e a oportunidade
          numa só operação.
        </p>
        <app-select
          label="Organização"
          placeholder="Escolha a organização"
          [options]="organizationOptions()"
          [ngModel]="orgId()"
          (ngModelChange)="orgId.set($event ?? '')"
        />
        <app-input
          label="Nome da oportunidade"
          [ngModel]="opportunityName()"
          (ngModelChange)="opportunityName.set($event ?? '')"
        />
        <app-input
          label="Valor esperado"
          [ngModel]="expectedValue()"
          (ngModelChange)="expectedValue.set($event ?? '')"
        />
      </div>
      <ng-container dialogActions>
        <app-button variant="secondary" (click)="converting.set(null)">Cancelar</app-button>
        <app-button [loading]="busy()" (click)="convert()">Converter</app-button>
      </ng-container>
    </app-dialog>
  `,
})
export class LeadsTab {
  private readonly api = inject(ProspectingApi);
  private readonly organizations = inject(OrganizationApi);
  private readonly permissions = inject(PermissionService);
  private readonly tenantId = inject(TenantContextService).tenant;

  protected readonly statusOptions = STATUS_OPTIONS;
  protected readonly consentOptions = CONSENT_OPTIONS;
  protected readonly canManage = computed(() => this.permissions.can('crm.manage'));
  protected readonly columns: readonly TableColumn[] = [
    { key: 'name', label: 'Lead' },
    { key: 'contact', label: 'Contacto' },
    { key: 'source', label: 'Origem' },
    { key: 'consent', label: 'Consentimento' },
    { key: 'status', label: 'Estado' },
    { key: 'actions', label: '', align: 'end' },
  ];

  protected readonly q = signal('');
  protected readonly status = signal('');
  private readonly tick = signal(0);
  protected readonly busy = signal(false);
  protected readonly notice = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);
  protected readonly formError = signal<string | null>(null);

  protected readonly leads = rxResource({
    params: () => {
      const tenant = this.tenantId();
      return tenant
        ? { tenantId: tenant.id, q: this.q(), status: this.status(), tick: this.tick() }
        : undefined;
    },
    stream: ({ params }) =>
      this.api.leads({
        limit: 100,
        ...(params.q ? { q: params.q } : {}),
        ...(params.status ? { status: params.status as LeadStatus } : {}),
      }),
  });
  private readonly orgs = rxResource({
    params: () => (this.converting() ? true : undefined),
    stream: () => this.organizations.listOrganizations(),
  });
  protected readonly organizationOptions = computed<readonly SelectOption[]>(() =>
    (this.orgs.hasValue() ? this.orgs.value() : []).map((o) => ({
      value: o.id,
      label: `${o.code} — ${o.legalName}`,
    })),
  );

  protected readonly creating = signal(false);
  protected readonly name = signal('');
  protected readonly company = signal('');
  protected readonly email = signal('');
  protected readonly phone = signal('');
  protected readonly source = signal('');
  protected readonly consent = signal<string>('UNKNOWN');

  protected readonly disqualifying = signal<LeadDto | null>(null);
  protected readonly reason = signal('');

  protected readonly converting = signal<LeadDto | null>(null);
  protected readonly orgId = signal('');
  protected readonly opportunityName = signal('');
  protected readonly expectedValue = signal('');

  protected describe = (e: unknown) => prospectingError(e, 'Pedido falhado.');
  protected statusOf = (s: LeadStatus) => LEAD_STATUS[s];
  protected consentOf = (c: ConsentStatus) => CONSENT[c];

  protected openCreate(): void {
    this.notice.set(null);
    this.formError.set(null);
    this.name.set('');
    this.company.set('');
    this.email.set('');
    this.phone.set('');
    this.source.set('');
    this.consent.set('UNKNOWN');
    this.creating.set(true);
  }

  protected create(): void {
    if (!this.name().trim() || !this.source().trim()) {
      this.formError.set('Indique o nome e a origem da lead.');
      return;
    }
    this.formError.set(null);
    this.busy.set(true);
    this.api
      .createLead({
        name: this.name().trim(),
        source: this.source().trim(),
        companyName: this.company().trim() || null,
        email: this.email().trim() || null,
        phone: this.phone().trim() || null,
        consentStatus: this.consent() as ConsentStatus,
      })
      .subscribe({
        next: () => {
          this.busy.set(false);
          this.creating.set(false);
          this.notice.set('Lead criada.');
          this.tick.update((n) => n + 1);
        },
        error: (e: unknown) => {
          this.busy.set(false);
          this.formError.set(prospectingError(e, 'Não foi possível criar a lead.'));
        },
      });
  }

  protected qualify(lead: LeadDto): void {
    this.run(this.api.qualifyLead(lead.id), 'Lead qualificada.');
  }

  protected askDisqualify(lead: LeadDto): void {
    this.formError.set(null);
    this.reason.set('');
    this.disqualifying.set(lead);
  }

  protected disqualify(): void {
    const lead = this.disqualifying();
    if (!lead) return;
    if (!this.reason().trim()) {
      this.formError.set('Indique o motivo.');
      return;
    }
    this.busy.set(true);
    this.api.disqualifyLead(lead.id, this.reason().trim()).subscribe({
      next: () => {
        this.busy.set(false);
        this.disqualifying.set(null);
        this.notice.set('Lead desqualificada.');
        this.tick.update((n) => n + 1);
      },
      error: (e: unknown) => {
        this.busy.set(false);
        this.formError.set(prospectingError(e, 'Não foi possível desqualificar.'));
      },
    });
  }

  protected openConvert(lead: LeadDto): void {
    this.notice.set(null);
    this.formError.set(null);
    this.orgId.set('');
    this.opportunityName.set(lead.companyName ?? lead.name);
    this.expectedValue.set('');
    this.converting.set(lead);
  }

  protected convert(): void {
    const lead = this.converting();
    if (!lead) return;
    if (!this.orgId()) {
      this.formError.set('Escolha a organização do cliente.');
      return;
    }
    if (this.expectedValue().trim() && !isMoney(this.expectedValue())) {
      this.formError.set('Valor esperado inválido (até 4 casas decimais).');
      return;
    }
    this.formError.set(null);
    this.busy.set(true);
    this.api
      .convertLead(lead.id, {
        organizationId: this.orgId(),
        opportunity: {
          ...(this.opportunityName().trim() ? { name: this.opportunityName().trim() } : {}),
          ...(this.expectedValue().trim() ? { expectedValue: this.expectedValue().trim() } : {}),
        },
      })
      .subscribe({
        next: (result) => {
          this.busy.set(false);
          this.converting.set(null);
          this.notice.set(
            result.alreadyConverted
              ? 'A lead já estava convertida: são os mesmos registos.'
              : 'Lead convertida: pessoa ou organização, cliente e oportunidade criados.',
          );
          this.tick.update((n) => n + 1);
        },
        error: (e: unknown) => {
          this.busy.set(false);
          this.formError.set(prospectingError(e, 'Não foi possível converter a lead.'));
        },
      });
  }

  private run(call: Observable<unknown>, message: string): void {
    this.notice.set(null);
    this.actionError.set(null);
    call.subscribe({
      next: () => {
        this.notice.set(message);
        this.tick.update((n) => n + 1);
      },
      error: (e: unknown) => {
        this.actionError.set(prospectingError(e, 'Não foi possível concluir a operação.'));
        this.tick.update((n) => n + 1);
      },
    });
  }
}
