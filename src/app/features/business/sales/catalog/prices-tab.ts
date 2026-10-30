import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { finalize, type Observable } from 'rxjs';
import { PermissionService } from '../../../../core/permissions/permission.service';
import { OrganizationApi } from '../../../tenant/data-access/organization.api';
import { Alert } from '../../../../shared/ui/alert/alert';
import { Button } from '../../../../shared/ui/button/button';
import { Card } from '../../../../shared/ui/card/card';
import { Checkbox } from '../../../../shared/ui/checkbox/checkbox';
import { EmptyState } from '../../../../shared/ui/empty-state/empty-state';
import { Input } from '../../../../shared/ui/input/input';
import { LoadingState } from '../../../../shared/ui/loading-state/loading-state';
import { Select, type SelectOption } from '../../../../shared/ui/select/select';
import { Table, type TableColumn } from '../../../../shared/ui/table/table';
import {
  CatalogApi,
  type PriceItemDto,
  type PriceListDto,
  type ResolvedPriceDto,
} from './catalog.api';
import {
  catalogError,
  formatDecimal,
  isMoney,
  isPositiveQuantity,
  isQuantity,
  isRate,
} from './catalog-model';

const COLUMNS: readonly TableColumn[] = [
  { key: 'name', label: 'Tabela' },
  { key: 'org', label: 'Organização' },
  { key: 'period', label: 'Período' },
  { key: 'priority', label: 'Prioridade' },
  { key: 'actions', label: '', align: 'end' },
];

const ITEM_COLUMNS: readonly TableColumn[] = [
  { key: 'sku', label: 'Variante (SKU)' },
  { key: 'min', label: 'A partir de', align: 'end' },
  { key: 'price', label: 'Preço unitário', align: 'end' },
  { key: 'discount', label: 'Desconto máx.', align: 'end' },
  { key: 'actions', label: '', align: 'end' },
];

/** Tabelas de preços (M03): períodos, prioridade, escalões por quantidade e resolução do preço. */
@Component({
  selector: 'app-catalog-prices',
  imports: [
    FormsModule,
    Alert,
    Button,
    Card,
    Checkbox,
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

    @if (!selected()) {
      <div class="mb-4 flex justify-end gap-2">
        @if (canManage()) {
          <app-button (click)="startNew()">Nova tabela de preços</app-button>
        }
      </div>
      <app-card [flush]="true">
        @if (lists.isLoading() && !lists.hasValue()) {
          <app-loading-state label="A carregar tabelas de preços…" />
        } @else if (lists.error()) {
          <div class="p-5">
            <app-alert tone="danger" title="Não foi possível carregar as tabelas">{{
              loadError()
            }}</app-alert>
          </div>
        } @else if (lists.value(); as list) {
          @if (list.length === 0) {
            <app-empty-state icon="tag" title="Sem tabelas de preços" />
          } @else {
            <app-table
              caption="Tabelas de preços"
              [columns]="columns"
              [rows]="list"
              data-testid="price-lists"
            >
              <ng-template let-row let-column="column">
                @switch (column.key) {
                  @case ('name') {
                    <span class="font-medium">{{ row.name }}</span>
                    <span class="block text-xs text-fg-muted">
                      {{ row.currency }}{{ row.taxInclusive ? ' · IVA incluído' : '' }}
                    </span>
                  }
                  @case ('org') {
                    {{ orgName(row.organizationId) }}
                  }
                  @case ('period') {
                    {{ row.validFrom }} → {{ row.validTo ?? 'sem fim' }}
                  }
                  @case ('priority') {
                    {{ row.priority }}
                  }
                  @case ('actions') {
                    <app-button size="sm" variant="secondary" (click)="open(row)">{{
                      canManage() ? 'Abrir' : 'Ver'
                    }}</app-button>
                  }
                }
              </ng-template>
            </app-table>
          }
        }
      </app-card>

      <app-card class="mt-6 block">
        <h3 class="mb-1 text-sm font-semibold">Qual é o preço?</h3>
        <p class="mb-3 text-xs text-fg-muted">
          Resolve o preço de uma variante tal como um documento o faria: tabela aplicável, escalão e
          origem.
        </p>
        <div class="grid gap-4 sm:grid-cols-3">
          <app-select
            label="Organização"
            [options]="orgOptions()"
            [ngModel]="rOrg()"
            (ngModelChange)="rOrg.set($event ?? '')"
          />
          <app-input
            label="SKU da variante"
            [ngModel]="rSku()"
            (ngModelChange)="rSku.set($event ?? '')"
          />
          <app-input
            label="Moeda"
            hint="Ex.: AOA"
            [ngModel]="rCurrency()"
            (ngModelChange)="rCurrency.set(($event ?? '').toUpperCase())"
          />
          <app-input
            label="Quantidade"
            [ngModel]="rQuantity()"
            (ngModelChange)="rQuantity.set($event ?? '')"
          />
          <app-input
            label="Data"
            type="date"
            hint="Vazio = hoje."
            [ngModel]="rDate()"
            (ngModelChange)="rDate.set($event ?? '')"
          />
        </div>
        <app-button class="mt-4" [loading]="busy()" (click)="resolve()">Resolver preço</app-button>
        @if (resolved(); as r) {
          <dl class="mt-4 grid gap-2 text-sm sm:grid-cols-2" data-testid="resolved">
            <div>
              <dt class="text-xs text-fg-muted">Preço unitário</dt>
              <dd class="font-semibold">{{ money(r.unitPrice) }} {{ r.currency }}</dd>
            </div>
            <div>
              <dt class="text-xs text-fg-muted">Desconto máximo</dt>
              <dd>{{ r.maxDiscount }}</dd>
            </div>
            <div>
              <dt class="text-xs text-fg-muted">Origem</dt>
              <dd>
                {{ r.priceListName }} (prioridade {{ r.priority }}, a partir de {{ r.minQuantity }})
              </dd>
            </div>
            <div>
              <dt class="text-xs text-fg-muted">Impostos</dt>
              <dd>{{ r.taxInclusive ? 'IVA incluído' : 'IVA não incluído' }}</dd>
            </div>
          </dl>
        }
      </app-card>
    } @else {
      <app-card>
        <h2 class="mb-4 text-base font-semibold">
          {{ selected()!.id ? 'Tabela ' + name() : 'Nova tabela de preços' }}
        </h2>
        @if (clientError(); as text) {
          <app-alert tone="danger" class="mb-4 block">{{ text }}</app-alert>
        }
        <div class="grid gap-4 sm:grid-cols-2">
          <app-input
            label="Nome"
            [required]="true"
            [ngModel]="name()"
            (ngModelChange)="name.set($event ?? '')"
          />
          <app-select
            label="Organização"
            [required]="true"
            hint="Imutável depois de criada."
            [options]="orgOptions()"
            [disabled]="!!selected()!.id"
            [ngModel]="orgId()"
            (ngModelChange)="orgId.set($event ?? '')"
          />
          <app-input
            label="Moeda"
            [required]="true"
            hint="ISO 4217 (ex.: AOA). Imutável depois de criada."
            [disabled]="!!selected()!.id"
            [ngModel]="currency()"
            (ngModelChange)="currency.set(($event ?? '').toUpperCase())"
          />
          <app-input
            label="Prioridade"
            type="number"
            hint="De -1000 a 1000; a mais alta vence. Empate com preços diferentes é ambíguo."
            [ngModel]="priority()"
            (ngModelChange)="priority.set(asInt($event))"
          />
          <app-input
            label="Válida desde"
            type="date"
            [required]="true"
            [ngModel]="validFrom()"
            (ngModelChange)="validFrom.set($event ?? '')"
          />
          <app-input
            label="Válida até"
            type="date"
            hint="Vazio = sem fim."
            [ngModel]="validTo()"
            (ngModelChange)="validTo.set($event ?? '')"
          />
          <app-checkbox
            label="Preços com IVA incluído"
            [ngModel]="taxInclusive()"
            (ngModelChange)="taxInclusive.set(!!$event)"
          />
        </div>
        <div class="mt-5 flex gap-2">
          @if (canManage()) {
            <app-button [loading]="busy()" (click)="save()">Guardar</app-button>
          }
          <app-button variant="secondary" (click)="close()">Fechar</app-button>
        </div>
      </app-card>

      @if (selected()!.id) {
        <h3 class="mb-3 mt-8 text-base font-semibold">Preços por variante</h3>
        <app-card [flush]="true">
          @if (items().length === 0) {
            <app-empty-state icon="tag" title="Sem preços nesta tabela" />
          } @else {
            <app-table caption="Itens" [columns]="itemColumns" [rows]="items()" data-testid="items">
              <ng-template let-row let-column="column">
                @switch (column.key) {
                  @case ('sku') {
                    <span class="font-medium">{{ row.sku }}</span>
                  }
                  @case ('min') {
                    {{ row.minQuantity }}
                  }
                  @case ('price') {
                    {{ money(row.unitPrice) }}
                  }
                  @case ('discount') {
                    {{ row.maxDiscount }}
                  }
                  @case ('actions') {
                    @if (canManage()) {
                      <app-button
                        size="sm"
                        variant="secondary"
                        [disabled]="busy()"
                        (click)="removeItem(row)"
                        >Remover</app-button
                      >
                    }
                  }
                }
              </ng-template>
            </app-table>
          }
        </app-card>
        @if (canManage()) {
          <app-card class="mt-4 block">
            <h4 class="mb-3 text-sm font-semibold">Novo preço</h4>
            <div class="grid gap-4 sm:grid-cols-4">
              <app-input
                label="SKU da variante"
                [required]="true"
                [ngModel]="itemSku()"
                (ngModelChange)="itemSku.set($event ?? '')"
              />
              <app-input
                label="Quantidade mínima"
                hint="Vazio = 1."
                [ngModel]="itemMin()"
                (ngModelChange)="itemMin.set($event ?? '')"
              />
              <app-input
                label="Preço unitário"
                [required]="true"
                [ngModel]="itemPrice()"
                (ngModelChange)="itemPrice.set($event ?? '')"
              />
              <app-input
                label="Desconto máximo (0 a 1)"
                hint="Vazio = 0."
                [ngModel]="itemDiscount()"
                (ngModelChange)="itemDiscount.set($event ?? '')"
              />
            </div>
            <app-button class="mt-4" [loading]="busy()" (click)="addItem()"
              >Acrescentar preço</app-button
            >
          </app-card>
        }
      }
    }
  `,
})
export class PricesTab {
  private readonly api = inject(CatalogApi);
  private readonly organizations = inject(OrganizationApi);
  private readonly permissions = inject(PermissionService);

  protected readonly columns = COLUMNS;
  protected readonly itemColumns = ITEM_COLUMNS;
  protected readonly canManage = computed(() => this.permissions.can('price.manage'));

  private readonly reload = signal(0);
  protected readonly lists = rxResource({
    params: () => ({ reload: this.reload() }),
    stream: () => this.api.priceLists(),
  });
  protected readonly loadError = computed(() =>
    catalogError(this.lists.error(), 'Tente novamente.'),
  );

  private readonly orgs = rxResource({ stream: () => this.organizations.listOrganizations() });
  protected readonly orgOptions = computed<readonly SelectOption[]>(() =>
    (this.orgs.hasValue() ? this.orgs.value() : []).map((o) => ({
      value: o.id,
      label: o.tradeName ?? o.legalName,
    })),
  );

  protected readonly notice = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);
  protected readonly clientError = signal<string | null>(null);
  protected readonly busy = signal(false);

  protected readonly selected = signal<{ id: string | null; version: number } | null>(null);
  protected readonly name = signal('');
  protected readonly orgId = signal('');
  protected readonly currency = signal('');
  protected readonly priority = signal<number | null>(0);
  protected readonly validFrom = signal('');
  protected readonly validTo = signal('');
  protected readonly taxInclusive = signal(false);
  protected readonly items = signal<readonly PriceItemDto[]>([]);
  protected readonly itemSku = signal('');
  protected readonly itemMin = signal('');
  protected readonly itemPrice = signal('');
  protected readonly itemDiscount = signal('');
  /** SKU → id das variantes, para os itens e para o resolvedor. */
  private readonly variantIds = new Map<string, string>();

  protected readonly rOrg = signal('');
  protected readonly rSku = signal('');
  protected readonly rCurrency = signal('');
  protected readonly rQuantity = signal('1');
  protected readonly rDate = signal('');
  protected readonly resolved = signal<ResolvedPriceDto | null>(null);

  protected money(value: string): string {
    return formatDecimal(value);
  }

  protected orgName(id: string): string {
    return this.orgOptions().find((o) => o.value === id)?.label ?? '—';
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
        this.actionError.set(catalogError(error, 'Não foi possível concluir a operação.')),
    });
  }

  protected startNew(): void {
    this.reset();
    this.name.set('');
    this.orgId.set(this.orgOptions()[0]?.value ?? '');
    this.currency.set('');
    this.priority.set(0);
    this.validFrom.set(new Date().toISOString().slice(0, 10));
    this.validTo.set('');
    this.taxInclusive.set(false);
    this.items.set([]);
    this.selected.set({ id: null, version: 0 });
  }

  protected open(row: PriceListDto): void {
    this.reset();
    this.run(this.api.priceList(row.id), (full) => this.show(full));
  }

  private show(list: PriceListDto): void {
    this.name.set(list.name);
    this.orgId.set(list.organizationId);
    this.currency.set(list.currency);
    this.priority.set(list.priority);
    this.validFrom.set(list.validFrom);
    this.validTo.set(list.validTo ?? '');
    this.taxInclusive.set(list.taxInclusive);
    this.items.set(list.items ?? []);
    for (const item of list.items ?? []) this.variantIds.set(item.sku, item.variantId);
    this.selected.set({ id: list.id, version: list.version });
  }

  protected close(): void {
    this.selected.set(null);
    this.reload.update((n) => n + 1);
  }

  protected save(): void {
    const state = this.selected();
    if (!state) return;
    this.reset();
    if (!this.name().trim()) return void this.clientError.set('O nome é obrigatório.');
    if (!this.validFrom()) return void this.clientError.set('Indique desde quando a tabela vale.');
    const priority = this.priority();
    if (priority === null || priority < -1000 || priority > 1000) {
      return void this.clientError.set('A prioridade é um inteiro entre -1000 e 1000.');
    }
    if (this.validTo() && this.validTo() < this.validFrom()) {
      return void this.clientError.set('O fim do período não pode ser anterior ao início.');
    }
    const body = {
      name: this.name().trim(),
      validFrom: this.validFrom(),
      validTo: this.validTo() || null,
      taxInclusive: this.taxInclusive(),
      priority,
    };
    if (state.id) {
      this.run(this.api.updatePriceList(state.id, state.version, body), (saved) => {
        this.selected.set({ id: saved.id, version: saved.version });
        this.notice.set('Tabela guardada.');
      });
      return;
    }
    if (!this.orgId()) return void this.clientError.set('Escolha a organização.');
    if (!/^[A-Z]{3}$/.test(this.currency())) {
      return void this.clientError.set('A moeda tem três letras (ex.: AOA).');
    }
    this.run(
      this.api.createPriceList({
        ...body,
        organizationId: this.orgId(),
        currency: this.currency(),
      }),
      (created) => {
        this.show(created);
        this.notice.set('Tabela criada.');
      },
    );
  }

  /** O servidor pede o id da variante; o utilizador conhece o SKU. */
  private resolveVariant(sku: string, then: (variantId: string) => void): void {
    const known = this.variantIds.get(sku);
    if (known) return then(known);
    this.run(this.api.products({ q: sku, limit: 20 }), (page) => {
      const hit = page.items.find((p) => p.code === sku) ?? page.items[0];
      if (!hit) return void this.actionError.set(`Nenhuma variante com o SKU «${sku}».`);
      this.run(this.api.product(hit.id), (full) => {
        const variant = full.variants?.find((v) => v.sku === sku);
        if (!variant) return void this.actionError.set(`Nenhuma variante com o SKU «${sku}».`);
        this.variantIds.set(sku, variant.id);
        then(variant.id);
      });
    });
  }

  protected addItem(): void {
    const state = this.selected();
    if (!state?.id) return;
    this.reset();
    const sku = this.itemSku().trim();
    const min = this.itemMin().trim();
    const discount = this.itemDiscount().trim();
    if (!sku) return void this.clientError.set('Indique o SKU da variante.');
    if (!isMoney(this.itemPrice())) {
      return void this.clientError.set('Preço: número não negativo com até 4 casas decimais.');
    }
    if (min && !isPositiveQuantity(min)) {
      return void this.clientError.set('Quantidade mínima: número positivo com até 6 casas.');
    }
    if (discount && !isRate(discount)) {
      return void this.clientError.set('Desconto máximo: um valor entre 0 e 1.');
    }
    const listId = state.id;
    this.resolveVariant(sku, (variantId) =>
      this.run(
        this.api.addPriceItem(listId, {
          variantId,
          unitPrice: this.itemPrice().trim(),
          minQuantity: min || undefined,
          maxDiscount: discount || undefined,
        }),
        (created) => {
          this.items.update((list) => [...list, { ...created, sku }]);
          this.itemSku.set('');
          this.itemMin.set('');
          this.itemPrice.set('');
          this.itemDiscount.set('');
          this.notice.set('Preço acrescentado.');
        },
      ),
    );
  }

  protected removeItem(item: PriceItemDto): void {
    this.reset();
    this.run(this.api.deletePriceItem(item.id), () => {
      this.items.update((list) => list.filter((i) => i.id !== item.id));
      this.notice.set('Preço removido.');
    });
  }

  protected resolve(): void {
    this.reset();
    this.resolved.set(null);
    const sku = this.rSku().trim();
    if (!this.rOrg() || !sku) {
      return void this.actionError.set('Indique a organização e o SKU da variante.');
    }
    if (!/^[A-Z]{3}$/.test(this.rCurrency())) {
      return void this.actionError.set('A moeda tem três letras (ex.: AOA).');
    }
    if (!isQuantity(this.rQuantity()) || !isPositiveQuantity(this.rQuantity())) {
      return void this.actionError.set('A quantidade tem de ser positiva.');
    }
    this.resolveVariant(sku, (variantId) =>
      this.run(
        this.api.resolvePrice({
          variantId,
          organizationId: this.rOrg(),
          currency: this.rCurrency(),
          quantity: this.rQuantity().trim(),
          date: this.rDate() || undefined,
        }),
        (result) => this.resolved.set(result),
      ),
    );
  }
}
