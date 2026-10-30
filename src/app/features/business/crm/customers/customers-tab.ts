import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { finalize, type Observable } from 'rxjs';
import { PermissionService } from '../../../../core/permissions/permission.service';
import { IamApi } from '../../../tenant/data-access/iam.api';
import { OrganizationApi } from '../../../tenant/data-access/organization.api';
import { Alert } from '../../../../shared/ui/alert/alert';
import { Badge, type Tone } from '../../../../shared/ui/badge/badge';
import { Button } from '../../../../shared/ui/button/button';
import { Card } from '../../../../shared/ui/card/card';
import { EmptyState } from '../../../../shared/ui/empty-state/empty-state';
import { Input } from '../../../../shared/ui/input/input';
import { LoadingState } from '../../../../shared/ui/loading-state/loading-state';
import { Select, type SelectOption } from '../../../../shared/ui/select/select';
import { Table, type TableColumn } from '../../../../shared/ui/table/table';
import {
  CustomersApi,
  type Channel,
  type CustomerDto,
  type CustomerPatch,
  type CustomerStatus,
  type InteractionDto,
  type NewCustomer,
  type PartyDto,
} from './customers.api';
import { CHANNEL_LABEL, customerError, isMoney, localToIso, STATUS_LABEL } from './customers-model';

const COLUMNS: readonly TableColumn[] = [
  { key: 'name', label: 'Cliente' },
  { key: 'segment', label: 'Segmento' },
  { key: 'terms', label: 'Prazo' },
  { key: 'credit', label: 'Crédito', align: 'end' },
  { key: 'status', label: 'Estado' },
  { key: 'actions', label: '', align: 'end' },
];

const STATUSES: readonly SelectOption[] = [
  { value: 'ACTIVE', label: 'Activo' },
  { value: 'BLOCKED', label: 'Bloqueado' },
  { value: 'INACTIVE', label: 'Inactivo' },
];

const CHANNELS: readonly SelectOption[] = (Object.keys(CHANNEL_LABEL) as Channel[]).map(
  (value) => ({ value, label: CHANNEL_LABEL[value] }),
);

type PartyMode = 'existing' | 'organization' | 'person';
const PARTY_MODES: readonly SelectOption[] = [
  { value: 'existing', label: 'Pessoa ou organização existente' },
  { value: 'organization', label: 'Nova organização' },
  { value: 'person', label: 'Nova pessoa' },
];

/** Clientes (M01): condições comerciais sobre uma Party, bloqueio com motivo e interacções. */
@Component({
  selector: 'app-customers',
  imports: [
    FormsModule,
    Alert,
    Badge,
    Button,
    Card,
    EmptyState,
    Input,
    LoadingState,
    Select,
    Table,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (notice(); as text) {
      <app-alert tone="success" class="mb-4 block">{{ text }}</app-alert>
    }
    @if (actionError(); as text) {
      <app-alert tone="danger" title="Não foi possível concluir a operação" class="mb-4 block">{{
        text
      }}</app-alert>
    }

    @if (!editing()) {
      <div class="mb-4 flex flex-wrap items-end gap-3">
        <div class="min-w-56 flex-1">
          <app-input
            label="Pesquisar"
            placeholder="Nome, código ou NIF"
            [ngModel]="query()"
            (ngModelChange)="query.set($event ?? '')"
          />
        </div>
        <app-select
          label="Estado"
          placeholder="Todos"
          [options]="statuses"
          [ngModel]="statusFilter()"
          (ngModelChange)="statusFilter.set($event ?? '')"
        />
        <app-select
          label="Segmento"
          placeholder="Todos"
          [options]="segmentOptions()"
          [ngModel]="segmentFilter()"
          (ngModelChange)="segmentFilter.set($event ?? '')"
        />
        @if (canCreate()) {
          <app-button (click)="startNew()">Novo cliente</app-button>
        }
      </div>

      <app-card [flush]="true">
        @if (customers.isLoading() && !customers.hasValue()) {
          <app-loading-state label="A carregar clientes…" />
        } @else if (customers.error()) {
          <div class="p-5">
            <app-alert tone="danger" title="Não foi possível carregar os clientes">{{
              loadError()
            }}</app-alert>
          </div>
        } @else if (customers.value(); as page) {
          @if (page.items.length === 0) {
            <app-empty-state icon="users" title="Sem clientes" />
          } @else {
            <app-table
              caption="Clientes"
              [columns]="columns"
              [rows]="page.items"
              data-testid="customers"
            >
              <ng-template let-row let-column="column">
                @switch (column.key) {
                  @case ('name') {
                    <span class="font-medium">{{ row.partyName }}</span>
                    <span class="block text-xs text-fg-muted">
                      {{ row.code }}{{ row.taxId ? ' · NIF ' + row.taxId : '' }}
                    </span>
                  }
                  @case ('segment') {
                    {{ row.segmentName ?? '—' }}
                  }
                  @case ('terms') {
                    {{ row.paymentTermDays }} dias
                  }
                  @case ('credit') {
                    @if (row.creditLimit !== null) {
                      {{ row.creditLimit }} {{ row.currency }}
                    } @else {
                      —
                    }
                  }
                  @case ('status') {
                    <app-badge [tone]="tone(row.status)">{{ statusLabel(row.status) }}</app-badge>
                  }
                  @case ('actions') {
                    <app-button size="sm" variant="secondary" (click)="open(row)">Abrir</app-button>
                  }
                }
              </ng-template>
            </app-table>
            <p class="px-5 py-3 text-xs text-fg-muted">
              {{ page.items.length }} de {{ page.total }} clientes
            </p>
          }
        }
      </app-card>
    } @else {
      <app-card>
        <h2 class="mb-4 text-base font-semibold">
          {{ editing()!.id ? partyName() + ' (' + code() + ')' : 'Novo cliente' }}
        </h2>
        @if (clientError(); as text) {
          <app-alert tone="danger" class="mb-4 block">{{ text }}</app-alert>
        }

        @if (!editing()!.id) {
          <div class="mb-4 grid gap-4 sm:grid-cols-2">
            <app-select
              label="Pessoa ou organização"
              [options]="partyModes"
              [ngModel]="partyMode()"
              (ngModelChange)="partyMode.set(asMode($event))"
            />
            @switch (partyMode()) {
              @case ('existing') {
                <div>
                  <app-input
                    label="Procurar"
                    hint="Pelo menos 2 letras do nome ou contacto."
                    [ngModel]="partySearch()"
                    (ngModelChange)="searchParties($event ?? '')"
                  />
                </div>
                <div class="sm:col-span-2">
                  <app-select
                    label="Resultado"
                    [required]="true"
                    [options]="partyOptions()"
                    [ngModel]="partyId()"
                    (ngModelChange)="partyId.set($event ?? '')"
                  />
                </div>
              }
              @case ('organization') {
                <app-input
                  label="Designação legal"
                  [required]="true"
                  [ngModel]="newLegalName()"
                  (ngModelChange)="newLegalName.set($event ?? '')"
                />
                <app-input
                  label="NIF"
                  [ngModel]="newTaxId()"
                  (ngModelChange)="newTaxId.set($event ?? '')"
                />
              }
              @case ('person') {
                <app-input
                  label="Nomes próprios"
                  [required]="true"
                  [ngModel]="newGiven()"
                  (ngModelChange)="newGiven.set($event ?? '')"
                />
                <app-input
                  label="Apelido"
                  [required]="true"
                  [ngModel]="newFamily()"
                  (ngModelChange)="newFamily.set($event ?? '')"
                />
              }
            }
          </div>
        }

        <div class="grid gap-4 sm:grid-cols-2">
          @if (!editing()!.id) {
            <app-select
              label="Organização"
              [required]="true"
              [options]="orgOptions()"
              [ngModel]="orgId()"
              (ngModelChange)="orgId.set($event ?? '')"
            />
            <app-input
              label="Código"
              [required]="true"
              hint="Imutável depois de criado."
              [ngModel]="code()"
              (ngModelChange)="code.set($event ?? '')"
            />
          }
          <app-select
            label="Segmento"
            placeholder="Sem segmento"
            [options]="segmentOptions()"
            [ngModel]="segmentId()"
            (ngModelChange)="segmentId.set($event ?? '')"
          />
          <app-select
            label="Gestor de conta"
            placeholder="Sem gestor"
            [options]="managerOptions()"
            [ngModel]="managerId()"
            (ngModelChange)="managerId.set($event ?? '')"
          />
          <app-input
            label="Prazo de pagamento (dias)"
            type="number"
            [min]="0"
            [ngModel]="termDays()"
            (ngModelChange)="termDays.set(asInt($event))"
          />
          @if (canCredit()) {
            <app-input
              label="Limite de crédito"
              hint="Até 4 casas decimais."
              [ngModel]="creditLimit()"
              (ngModelChange)="creditLimit.set($event ?? '')"
            />
            <app-input
              label="Moeda"
              hint="ISO 4217. Vazio = moeda base da organização."
              [ngModel]="currency()"
              (ngModelChange)="currency.set(($event ?? '').toUpperCase())"
            />
          }
          @if (editing()!.id && editing()!.status !== 'BLOCKED') {
            <app-select
              label="Estado"
              [options]="editableStatuses"
              [ngModel]="status()"
              (ngModelChange)="status.set($event === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE')"
            />
          }
        </div>
        <div class="mt-5 flex flex-wrap gap-2">
          @if (editing()!.id ? canUpdate() : canCreate()) {
            <app-button [loading]="busy()" (click)="save()">Guardar</app-button>
          }
          <app-button variant="secondary" (click)="close()">Fechar</app-button>
        </div>
      </app-card>

      @if (editing()!.id) {
        @if (editing()!.status === 'BLOCKED') {
          <app-alert tone="warning" title="Cliente bloqueado" class="mt-4 block">
            {{ editing()!.statusReason }} — não recebe novas confirmações de venda, mas continua a
            poder pagar e regularizar.
          </app-alert>
        }
        @if (canBlock()) {
          <app-card class="mt-4 block">
            @if (editing()!.status === 'BLOCKED') {
              <app-button variant="secondary" [loading]="busy()" (click)="unblock()"
                >Desbloquear</app-button
              >
            } @else {
              <div class="flex flex-wrap items-end gap-3">
                <div class="min-w-64 flex-1">
                  <app-input
                    label="Motivo do bloqueio"
                    [ngModel]="blockReason()"
                    (ngModelChange)="blockReason.set($event ?? '')"
                  />
                </div>
                <app-button variant="secondary" [loading]="busy()" (click)="block()"
                  >Bloquear cliente</app-button
                >
              </div>
            }
          </app-card>
        }

        @if (contacts().length > 0) {
          <h3 class="mb-2 mt-8 text-base font-semibold">Contactos</h3>
          <app-card>
            <ul class="space-y-1 text-sm" data-testid="contacts">
              @for (contact of contacts(); track contact.id) {
                <li>
                  <span class="text-fg-muted">{{ contact.type }}</span> {{ contact.value }}
                </li>
              }
            </ul>
          </app-card>
        }

        <h3 class="mb-3 mt-8 text-base font-semibold">Interacções</h3>
        <app-card [flush]="true">
          @if (interactions().length === 0) {
            <app-empty-state icon="chat" title="Sem interacções" />
          } @else {
            <ul class="divide-y divide-line" data-testid="interactions">
              @for (item of interactions(); track item.id) {
                <li class="px-5 py-3 text-sm">
                  <span class="font-medium">{{ item.subject }}</span>
                  <span class="ms-2 text-xs text-fg-muted">
                    {{ channelLabel(item.channel) }} ·
                    {{ item.occurredAt.slice(0, 16).replace('T', ' ') }}
                  </span>
                  @if (item.followUpAt) {
                    <app-badge tone="warning" class="ms-2"
                      >Seguimento {{ item.followUpAt.slice(0, 10) }}</app-badge
                    >
                  }
                  @if (item.summary) {
                    <p class="mt-1 text-fg-muted">{{ item.summary }}</p>
                  }
                </li>
              }
            </ul>
          }
        </app-card>
        @if (canUpdate()) {
          <app-card class="mt-4 block">
            <h4 class="mb-3 text-sm font-semibold">Nova interacção</h4>
            <div class="grid gap-4 sm:grid-cols-2">
              <app-select
                label="Canal"
                [options]="channels"
                [ngModel]="channel()"
                (ngModelChange)="channel.set(asChannel($event))"
              />
              <app-input
                label="Assunto"
                [required]="true"
                [ngModel]="subject()"
                (ngModelChange)="subject.set($event ?? '')"
              />
              <app-input
                label="Quando"
                type="datetime-local"
                hint="Vazio = agora."
                [ngModel]="occurredAt()"
                (ngModelChange)="occurredAt.set($event ?? '')"
              />
              <app-input
                label="Seguimento"
                type="datetime-local"
                [ngModel]="followUpAt()"
                (ngModelChange)="followUpAt.set($event ?? '')"
              />
              <div class="sm:col-span-2">
                <app-input
                  label="Resumo"
                  [ngModel]="summary()"
                  (ngModelChange)="summary.set($event ?? '')"
                />
              </div>
            </div>
            <app-button class="mt-4" [loading]="busy()" (click)="addInteraction()"
              >Registar interacção</app-button
            >
          </app-card>
        }
      }
    }
  `,
})
export class CustomersTab {
  private readonly api = inject(CustomersApi);
  private readonly organizations = inject(OrganizationApi);
  private readonly iam = inject(IamApi);
  private readonly permissions = inject(PermissionService);

  protected readonly columns = COLUMNS;
  protected readonly statuses = STATUSES;
  protected readonly channels = CHANNELS;
  protected readonly partyModes = PARTY_MODES;
  protected readonly editableStatuses = STATUSES.filter((s) => s.value !== 'BLOCKED');

  protected readonly canCreate = computed(() => this.permissions.can('customer.create'));
  protected readonly canUpdate = computed(() => this.permissions.can('customer.update'));
  protected readonly canBlock = computed(() => this.permissions.can('customer.block'));
  protected readonly canCredit = computed(() => this.permissions.can('customer.credit_manage'));

  protected readonly query = signal('');
  protected readonly statusFilter = signal('');
  protected readonly segmentFilter = signal('');
  private readonly reload = signal(0);

  protected readonly customers = rxResource({
    params: () => ({
      q: this.query().trim(),
      status: this.statusFilter(),
      segmentId: this.segmentFilter(),
      reload: this.reload(),
    }),
    stream: ({ params }) =>
      this.api.customers({
        q: params.q || undefined,
        status: (params.status || undefined) as CustomerStatus | undefined,
        segmentId: params.segmentId || undefined,
        limit: 100,
      }),
  });
  protected readonly loadError = computed(() =>
    customerError(this.customers.error(), 'Tente novamente.'),
  );

  private readonly segments = rxResource({ stream: () => this.api.segments() });
  private readonly orgs = rxResource({ stream: () => this.organizations.listOrganizations() });
  private readonly members = rxResource({ stream: () => this.iam.listMembers() });
  protected readonly segmentOptions = computed<readonly SelectOption[]>(() =>
    (this.segments.hasValue() ? this.segments.value() : [])
      .filter((s) => s.active)
      .map((s) => ({ value: s.id, label: s.name })),
  );
  private readonly orgCountry = computed(
    () =>
      (this.orgs.hasValue() ? this.orgs.value() : []).find((o) => o.id === this.orgId())
        ?.countryCode ?? null,
  );
  protected readonly orgOptions = computed<readonly SelectOption[]>(() =>
    (this.orgs.hasValue() ? this.orgs.value() : []).map((o) => ({
      value: o.id,
      label: o.tradeName ?? o.legalName,
    })),
  );
  /** Sem `member.read` a lista fica vazia e o gestor de conta não se escolhe aqui. */
  protected readonly managerOptions = computed<readonly SelectOption[]>(() =>
    (this.members.hasValue() ? this.members.value() : [])
      .filter((m) => m.status === 'ACTIVE')
      .map((m) => ({ value: m.id, label: m.displayName ?? m.email ?? m.id })),
  );

  protected readonly notice = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);
  protected readonly clientError = signal<string | null>(null);
  protected readonly busy = signal(false);

  protected readonly editing = signal<{
    id: string | null;
    /** A Party do cliente aberto: as interacções referenciam a Party, não o cliente. */
    partyId: string | null;
    version: number;
    status: CustomerStatus;
    statusReason: string | null;
  } | null>(null);
  protected readonly partyName = signal('');
  protected readonly code = signal('');
  protected readonly orgId = signal('');
  protected readonly partyId = signal('');
  protected readonly partyMode = signal<PartyMode>('existing');
  protected readonly partySearch = signal('');
  protected readonly partyOptions = signal<readonly SelectOption[]>([]);
  protected readonly newLegalName = signal('');
  protected readonly newTaxId = signal('');
  protected readonly newGiven = signal('');
  protected readonly newFamily = signal('');
  protected readonly segmentId = signal('');
  protected readonly managerId = signal('');
  protected readonly termDays = signal<number | null>(0);
  protected readonly creditLimit = signal('');
  protected readonly currency = signal('');
  protected readonly status = signal<'ACTIVE' | 'INACTIVE'>('ACTIVE');
  protected readonly blockReason = signal('');
  protected readonly contacts = signal<NonNullable<CustomerDto['contacts']>>([]);
  protected readonly interactions = signal<readonly InteractionDto[]>([]);
  protected readonly channel = signal<Channel>('CALL');
  protected readonly subject = signal('');
  protected readonly occurredAt = signal('');
  protected readonly followUpAt = signal('');
  protected readonly summary = signal('');

  protected statusLabel(status: CustomerStatus): string {
    return STATUS_LABEL[status].label;
  }

  protected tone(status: CustomerStatus): Tone {
    return STATUS_LABEL[status].tone as Tone;
  }

  protected channelLabel(channel: Channel): string {
    return CHANNEL_LABEL[channel];
  }

  protected asMode(value: string | null): PartyMode {
    return value === 'organization' || value === 'person' ? value : 'existing';
  }

  protected asChannel(value: string | null): Channel {
    return value === 'EMAIL' || value === 'MEETING' || value === 'NOTE' ? value : 'CALL';
  }

  protected asInt(value: unknown): number | null {
    const n = typeof value === 'number' ? value : Number(value);
    return value === null || value === '' || !Number.isInteger(n) ? null : n;
  }

  private reset(): void {
    this.notice.set(null);
    this.actionError.set(null);
    this.clientError.set(null);
  }

  private run<T>(call: Observable<T>, done: (result: T) => void): void {
    this.actionError.set(null);
    this.busy.set(true);
    call.pipe(finalize(() => this.busy.set(false))).subscribe({
      next: done,
      error: (error: unknown) =>
        this.actionError.set(customerError(error, 'Não foi possível concluir a operação.')),
    });
  }

  protected searchParties(text: string): void {
    this.partySearch.set(text);
    this.partyId.set('');
    if (text.trim().length < 2) {
      this.partyOptions.set([]);
      return;
    }
    this.api.searchParties(text.trim()).subscribe({
      next: (list: readonly PartyDto[]) =>
        this.partyOptions.set(
          list.map((p) => ({
            value: p.id,
            label: `${p.displayName} (${p.kind === 'PERSON' ? 'pessoa' : 'organização'})`,
          })),
        ),
      error: (error: unknown) =>
        this.actionError.set(customerError(error, 'Não foi possível procurar.')),
    });
  }

  protected startNew(): void {
    this.reset();
    this.code.set('');
    this.orgId.set(this.orgOptions().length === 1 ? (this.orgOptions()[0]?.value ?? '') : '');
    this.partyId.set('');
    this.partyMode.set('existing');
    this.partySearch.set('');
    this.partyOptions.set([]);
    this.newLegalName.set('');
    this.newTaxId.set('');
    this.newGiven.set('');
    this.newFamily.set('');
    this.segmentId.set('');
    this.managerId.set('');
    this.termDays.set(0);
    this.creditLimit.set('');
    this.currency.set('');
    this.contacts.set([]);
    this.interactions.set([]);
    this.editing.set({
      id: null,
      partyId: null,
      version: 0,
      status: 'ACTIVE',
      statusReason: null,
    });
  }

  protected open(row: CustomerDto): void {
    this.reset();
    this.run(this.api.customer(row.id), (full) => {
      this.show(full);
      this.api.interactions(full.partyId).subscribe({
        next: (list) => this.interactions.set(list),
        error: (error: unknown) =>
          this.actionError.set(customerError(error, 'Não foi possível carregar as interacções.')),
      });
    });
  }

  private show(customer: CustomerDto): void {
    this.partyName.set(customer.partyName);
    this.code.set(customer.code);
    this.segmentId.set(customer.segmentId ?? '');
    this.managerId.set(customer.accountManagerMembershipId ?? '');
    this.termDays.set(customer.paymentTermDays);
    this.creditLimit.set(customer.creditLimit ?? '');
    this.currency.set(customer.currency);
    this.status.set(customer.status === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE');
    this.contacts.set(customer.contacts ?? []);
    this.editing.set({
      id: customer.id,
      partyId: customer.partyId,
      version: customer.version,
      status: customer.status,
      statusReason: customer.statusReason,
    });
  }

  protected close(): void {
    this.editing.set(null);
    this.reload.update((n) => n + 1);
  }

  protected save(): void {
    const state = this.editing();
    if (!state) return;
    this.reset();
    const term = this.termDays();
    if (term === null || term < 0 || term > 3650) {
      return void this.clientError.set('O prazo de pagamento vai de 0 a 3650 dias.');
    }
    const credit = this.creditLimit().trim();
    if (this.canCredit() && credit && !isMoney(credit)) {
      return void this.clientError.set('Limite de crédito: número não negativo com até 4 casas.');
    }
    if (this.canCredit() && this.currency() && !/^[A-Z]{3}$/.test(this.currency())) {
      return void this.clientError.set('A moeda tem três letras (ex.: AOA).');
    }
    const common = {
      segmentId: this.segmentId() || null,
      accountManagerMembershipId: this.managerId() || null,
      paymentTermDays: term,
      ...(this.canCredit() && credit ? { creditLimit: credit } : {}),
      ...(this.canCredit() && this.currency() ? { currency: this.currency() } : {}),
    };
    if (state.id) {
      const patch: CustomerPatch = {
        ...common,
        ...(state.status === 'BLOCKED' ? {} : { status: this.status() }),
      };
      this.run(this.api.updateCustomer(state.id, state.version, patch), (saved) => {
        this.show({ ...saved, contacts: this.contacts() });
        this.notice.set('Cliente guardado.');
      });
      return;
    }
    if (!this.orgId()) return void this.clientError.set('Escolha a organização.');
    if (!this.code().trim()) return void this.clientError.set('O código é obrigatório.');
    const create = (partyId: string) =>
      this.run(
        this.api.createCustomer({
          ...common,
          partyId,
          organizationId: this.orgId(),
          code: this.code().trim(),
        } satisfies NewCustomer),
        (created) => {
          this.show(created);
          this.interactions.set([]);
          this.notice.set('Cliente criado.');
        },
      );
    switch (this.partyMode()) {
      case 'existing': {
        if (!this.partyId()) return void this.clientError.set('Escolha a pessoa ou organização.');
        create(this.partyId());
        break;
      }
      case 'organization': {
        if (!this.newLegalName().trim()) {
          return void this.clientError.set('Indique a designação legal.');
        }
        this.run(
          this.api.createOrganizationParty({
            legalName: this.newLegalName().trim(),
            taxId: this.newTaxId().trim() || null,
            // O NIF pertence ao país da organização que vende (a Party exige o país da identificação fiscal).
            taxCountry: this.newTaxId().trim() ? this.orgCountry() : null,
          }),
          (party) => create(party.id),
        );
        break;
      }
      case 'person': {
        if (!this.newGiven().trim() || !this.newFamily().trim()) {
          return void this.clientError.set('Indique os nomes próprios e o apelido.');
        }
        this.run(
          this.api.createPerson({
            givenNames: this.newGiven().trim(),
            familyName: this.newFamily().trim(),
          }),
          (party) => create(party.id),
        );
        break;
      }
    }
  }

  protected block(): void {
    const state = this.editing();
    if (!state?.id) return;
    this.reset();
    if (!this.blockReason().trim()) {
      return void this.clientError.set('Indique o motivo do bloqueio.');
    }
    this.run(this.api.block(state.id, state.version, this.blockReason().trim()), (saved) => {
      this.show({ ...saved, contacts: this.contacts() });
      this.blockReason.set('');
      this.notice.set('Cliente bloqueado.');
    });
  }

  protected unblock(): void {
    const state = this.editing();
    if (!state?.id) return;
    this.reset();
    this.run(this.api.unblock(state.id, state.version), (saved) => {
      this.show({ ...saved, contacts: this.contacts() });
      this.notice.set('Cliente desbloqueado.');
    });
  }

  protected addInteraction(): void {
    const state = this.editing();
    if (!state?.id) return;
    this.reset();
    if (!this.subject().trim()) return void this.clientError.set('O assunto é obrigatório.');
    const occurred = localToIso(this.occurredAt());
    const follow = localToIso(this.followUpAt());
    if (this.occurredAt() && !occurred) return void this.clientError.set('Data inválida.');
    if (this.followUpAt() && !follow) {
      return void this.clientError.set('Data de seguimento inválida.');
    }
    const partyId = state.partyId;
    if (!partyId) return;
    this.run(
      this.api.createInteraction({
        partyId,
        channel: this.channel(),
        subject: this.subject().trim(),
        ...(occurred ? { occurredAt: occurred } : {}),
        ...(this.summary().trim() ? { summary: this.summary().trim() } : {}),
        ...(follow ? { followUpAt: follow } : {}),
      }),
      (created) => {
        this.interactions.update((list) => [created, ...list]);
        this.subject.set('');
        this.summary.set('');
        this.occurredAt.set('');
        this.followUpAt.set('');
        this.notice.set('Interacção registada.');
      },
    );
  }
}
