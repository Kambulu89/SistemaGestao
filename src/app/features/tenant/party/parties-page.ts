import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import type { Observable } from 'rxjs';
import { detailedErrorMessage } from '../../../core/api/error-message';
import { PermissionService } from '../../../core/permissions/permission.service';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import { Alert } from '../../../shared/ui/alert/alert';
import { Badge } from '../../../shared/ui/badge/badge';
import { Button } from '../../../shared/ui/button/button';
import { Card } from '../../../shared/ui/card/card';
import { Dialog } from '../../../shared/ui/dialog/dialog';
import { EmptyState } from '../../../shared/ui/empty-state/empty-state';
import { Input } from '../../../shared/ui/input/input';
import { LoadingState } from '../../../shared/ui/loading-state/loading-state';
import { PageHeader } from '../../../shared/ui/page-header/page-header';
import { Select } from '../../../shared/ui/select/select';
import { Table, type TableColumn } from '../../../shared/ui/table/table';
import { COUNTRY, KIND_LABEL, STATUS_LABEL, textOrNull } from './party-model';
import { PartyDetail } from './party-detail';
import {
  PartyApi,
  type PartyDetailDto,
  type PartyDto,
  type PartyKind,
  type PartyStatus,
} from './party.api';

const PAGE = 25;

const KIND_OPTIONS = [
  { value: 'PERSON', label: 'Pessoas' },
  { value: 'ORGANIZATION', label: 'Organizações' },
];
const STATUS_OPTIONS = [
  { value: 'ACTIVE', label: 'Activas' },
  { value: 'INACTIVE', label: 'Inactivas' },
];

/** Fichas de pessoas e organizações externas do tenant (clientes, fornecedores e contactos partilham-nas). */
@Component({
  selector: 'app-parties-page',
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
    PageHeader,
    PartyDetail,
    Select,
    Table,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    @if (selectedId(); as id) {
      <app-party-detail
        [partyId]="id"
        (back)="selectedId.set(null)"
        (open)="selectedId.set($event)"
      />
    } @else {
      <app-page-header
        title="Pessoas e entidades"
        description="Fichas de pessoas e organizações externas: identificação, contactos, moradas e relações."
      />

      <div class="mb-3 flex flex-wrap items-end gap-3" data-testid="filters">
        <div class="min-w-56 flex-1">
          <app-input
            label="Pesquisar"
            hint="Pelo menos 2 letras"
            [ngModel]="search()"
            (ngModelChange)="searchChanged($event)"
          />
        </div>
        <app-select
          label="Tipo"
          placeholder="Todos"
          [options]="kindOptions"
          [ngModel]="kind()"
          (ngModelChange)="kind.set($event ?? ''); offset.set(0)"
        />
        <app-select
          label="Estado"
          placeholder="Todos"
          [options]="statusOptions"
          [ngModel]="status()"
          (ngModelChange)="status.set($event ?? ''); offset.set(0)"
        />
        @if (canCreate()) {
          <app-button (click)="openCreate('PERSON')">Nova pessoa</app-button>
          <app-button variant="secondary" (click)="openCreate('ORGANIZATION')"
            >Nova organização</app-button
          >
        }
      </div>
      @if (searchHint()) {
        <p class="mb-3 text-xs text-fg-muted">A pesquisa só se aplica com 2 ou mais letras.</p>
      }
      @if (notice(); as text) {
        <app-alert tone="success" class="mb-3 block">{{ text }}</app-alert>
      }

      <app-card [flush]="true">
        @if (parties.isLoading() && !parties.hasValue()) {
          <app-loading-state label="A carregar fichas…" />
        } @else if (parties.error()) {
          <div class="p-5">
            <app-alert tone="danger" title="Não foi possível carregar as fichas">
              {{ describe(parties.error()) }}
            </app-alert>
          </div>
        } @else if (parties.value(); as list) {
          @if (list.length === 0) {
            <app-empty-state
              icon="users"
              title="Sem fichas"
              description="Nenhuma ficha corresponde aos filtros."
            />
          } @else {
            <app-table caption="Pessoas e entidades" [columns]="columns" [rows]="list">
              <ng-template let-row let-column="column">
                @switch (column.key) {
                  @case ('displayName') {
                    <button
                      type="button"
                      class="font-medium underline-offset-2 hover:underline"
                      (click)="selectedId.set(row.id)"
                    >
                      {{ row.displayName }}
                    </button>
                  }
                  @case ('kind') {
                    {{ kindLabel(row.kind) }}
                  }
                  @case ('status') {
                    <app-badge [tone]="row.status === 'ACTIVE' ? 'success' : 'neutral'">{{
                      statusLabel(row.status)
                    }}</app-badge>
                  }
                  @default {
                    {{ row[column.key] ?? '—' }}
                  }
                }
              </ng-template>
            </app-table>
            <div class="flex items-center justify-between border-t border-line px-4 py-2 text-sm">
              <span class="text-fg-muted">{{ offset() + 1 }}–{{ offset() + list.length }}</span>
              <span class="flex gap-2">
                <app-button
                  size="sm"
                  variant="secondary"
                  [disabled]="offset() === 0"
                  (click)="offset.set(offset() - pageSize)"
                  >Anterior</app-button
                >
                <app-button
                  size="sm"
                  variant="secondary"
                  [disabled]="list.length < pageSize"
                  (click)="offset.set(offset() + pageSize)"
                  >Seguinte</app-button
                >
              </span>
            </div>
          }
        }
      </app-card>

      <app-dialog
        [open]="creating() !== null"
        [title]="creating() === 'PERSON' ? 'Nova pessoa' : 'Nova organização'"
        (closed)="creating.set(null)"
      >
        @if (formError(); as text) {
          <app-alert tone="danger" class="mb-3 block">{{ text }}</app-alert>
        }
        <div class="space-y-3" data-testid="create-form">
          @if (creating() === 'PERSON') {
            <app-input
              label="Nomes próprios"
              [required]="true"
              [ngModel]="form()['givenNames']"
              (ngModelChange)="setForm('givenNames', $event)"
            />
            <app-input
              label="Apelido"
              [required]="true"
              [ngModel]="form()['familyName']"
              (ngModelChange)="setForm('familyName', $event)"
            />
          } @else {
            <app-input
              label="Denominação legal"
              [required]="true"
              [ngModel]="form()['legalName']"
              (ngModelChange)="setForm('legalName', $event)"
            />
            <app-input
              label="País fiscal (ISO-2)"
              [ngModel]="form()['taxCountry']"
              (ngModelChange)="setForm('taxCountry', $event)"
            />
            <app-input
              label="NIF"
              [ngModel]="form()['taxId']"
              (ngModelChange)="setForm('taxId', $event)"
            />
          }
          <app-input
            label="Nome a apresentar (opcional)"
            [ngModel]="form()['displayName']"
            (ngModelChange)="setForm('displayName', $event)"
          />
          <app-input
            label="Referência externa (opcional)"
            [ngModel]="form()['externalReference']"
            (ngModelChange)="setForm('externalReference', $event)"
          />
        </div>
        <ng-container dialogActions>
          <app-button variant="secondary" (click)="creating.set(null)">Cancelar</app-button>
          <app-button [loading]="busy()" (click)="create()">Criar</app-button>
        </ng-container>
      </app-dialog>
    }
  `,
})
export class PartiesPage {
  private readonly api = inject(PartyApi);
  private readonly permissions = inject(PermissionService);
  private readonly tenantId = inject(TenantContextService).tenant;

  protected readonly canCreate = computed(() => this.permissions.can('party.create'));
  protected readonly pageSize = PAGE;
  protected readonly kindOptions = KIND_OPTIONS;
  protected readonly statusOptions = STATUS_OPTIONS;
  protected readonly columns: readonly TableColumn[] = [
    { key: 'displayName', label: 'Nome' },
    { key: 'kind', label: 'Tipo' },
    { key: 'status', label: 'Estado' },
    { key: 'externalReference', label: 'Referência' },
  ];

  protected readonly search = signal('');
  protected readonly kind = signal('');
  protected readonly status = signal('');
  protected readonly offset = signal(0);
  protected readonly selectedId = signal<string | null>(null);
  protected readonly notice = signal<string | null>(null);

  /** O servidor exige 2+ letras: com menos, a pesquisa não se envia (e avisa-se). */
  private readonly effectiveQuery = computed(() => {
    const q = this.search().trim();
    return q.length >= 2 ? q : '';
  });
  protected readonly searchHint = computed(() => this.search().trim().length === 1);

  protected readonly parties = rxResource({
    params: () => {
      const tenant = this.tenantId();
      return tenant
        ? {
            tenantId: tenant.id,
            q: this.effectiveQuery(),
            kind: this.kind(),
            status: this.status(),
            offset: this.offset(),
          }
        : undefined;
    },
    stream: ({ params }) =>
      this.api.list({
        limit: PAGE,
        offset: params.offset,
        ...(params.q ? { q: params.q } : {}),
        ...(params.kind ? { kind: params.kind as PartyKind } : {}),
        ...(params.status ? { status: params.status as PartyStatus } : {}),
      }),
  });

  protected readonly creating = signal<PartyKind | null>(null);
  protected readonly form = signal<Record<string, string>>({});
  protected readonly busy = signal(false);
  protected readonly formError = signal<string | null>(null);

  protected kindLabel = (kind: PartyKind) => KIND_LABEL[kind];
  protected statusLabel = (status: PartyStatus) => STATUS_LABEL[status];
  protected describe = (e: unknown) => detailedErrorMessage(e, 'Pedido falhado.');

  protected searchChanged(value: string | null): void {
    this.search.set(value ?? '');
    this.offset.set(0);
  }

  protected openCreate(kind: PartyKind): void {
    this.notice.set(null);
    this.formError.set(null);
    this.form.set({});
    this.creating.set(kind);
  }

  protected setForm(key: string, value: string | null): void {
    this.form.update((f) => ({ ...f, [key]: value ?? '' }));
  }

  protected create(): void {
    const kind = this.creating();
    const f = this.form();
    if (!kind) return;
    const common = {
      displayName: textOrNull(f['displayName'] ?? ''),
      externalReference: textOrNull(f['externalReference'] ?? ''),
    };
    let call: Observable<PartyDetailDto>;
    if (kind === 'PERSON') {
      if (!f['givenNames']?.trim() || !f['familyName']?.trim()) {
        this.formError.set('Indique os nomes próprios e o apelido.');
        return;
      }
      call = this.api.createPerson({
        ...common,
        givenNames: f['givenNames'].trim(),
        familyName: f['familyName'].trim(),
      });
    } else {
      const country = textOrNull(f['taxCountry'] ?? '');
      const taxId = textOrNull(f['taxId'] ?? '');
      if (!f['legalName']?.trim()) {
        this.formError.set('Indique a denominação legal.');
        return;
      }
      if (country && !COUNTRY.test(country)) {
        this.formError.set('O país fiscal tem de ter 2 letras (ISO-2).');
        return;
      }
      if (taxId && !country) {
        this.formError.set('Indique o país fiscal para registar o NIF.');
        return;
      }
      call = this.api.createOrganization({
        ...common,
        legalName: f['legalName'].trim(),
        taxCountry: country ? country.toUpperCase() : null,
        taxId,
      });
    }
    this.formError.set(null);
    this.busy.set(true);
    call.subscribe({
      next: (created: PartyDto) => {
        this.busy.set(false);
        this.creating.set(null);
        this.notice.set('Ficha criada.');
        this.selectedId.set(created.id);
      },
      error: (e: unknown) => {
        this.busy.set(false);
        this.formError.set(detailedErrorMessage(e, 'Não foi possível criar a ficha.'));
      },
    });
  }
}
