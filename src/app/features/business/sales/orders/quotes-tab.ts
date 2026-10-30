import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { finalize, type Observable } from 'rxjs';
import { PermissionService } from '../../../../core/permissions/permission.service';
import { Alert } from '../../../../shared/ui/alert/alert';
import { Badge } from '../../../../shared/ui/badge/badge';
import { Button } from '../../../../shared/ui/button/button';
import { Card } from '../../../../shared/ui/card/card';
import { EmptyState } from '../../../../shared/ui/empty-state/empty-state';
import { Input } from '../../../../shared/ui/input/input';
import { LoadingState } from '../../../../shared/ui/loading-state/loading-state';
import { Select, type SelectOption } from '../../../../shared/ui/select/select';
import { Table, type TableColumn } from '../../../../shared/ui/table/table';
import { SalesLines, type NewLineRequest } from './lines-editor';
import { OrdersApi, type QuoteDto, type QuoteStatus } from './orders.api';
import { documentError, formatDecimal, QUOTE_STATUS } from './orders-model';

const COLUMNS: readonly TableColumn[] = [
  { key: 'number', label: 'Proposta' },
  { key: 'customer', label: 'Cliente' },
  { key: 'validity', label: 'Validade' },
  { key: 'total', label: 'Total', align: 'end' },
  { key: 'status', label: 'Estado' },
  { key: 'actions', label: '', align: 'end' },
];

const STATUSES: readonly SelectOption[] = (Object.keys(QUOTE_STATUS) as QuoteStatus[]).map(
  (value) => ({ value, label: QUOTE_STATUS[value].label }),
);

/** Propostas: rascunho → enviada → aceite (converte-se numa encomenda) ou rejeitada; a validade expira-as. */
@Component({
  selector: 'app-sales-quotes',
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
    SalesLines,
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

    @if (!quote() && !creating()) {
      <div class="mb-4 flex flex-wrap items-end gap-3">
        <div class="min-w-48 flex-1">
          <app-input
            label="Pesquisar"
            placeholder="Número"
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
        @if (canManage()) {
          <app-button (click)="startNew()">Nova proposta</app-button>
        }
      </div>
      <app-card [flush]="true">
        @if (quotes.isLoading() && !quotes.hasValue()) {
          <app-loading-state label="A carregar propostas…" />
        } @else if (quotes.error()) {
          <div class="p-5">
            <app-alert tone="danger" title="Não foi possível carregar as propostas">{{
              loadError()
            }}</app-alert>
          </div>
        } @else if (quotes.value(); as page) {
          @if (page.items.length === 0) {
            <app-empty-state icon="document" title="Sem propostas" />
          } @else {
            <app-table
              caption="Propostas"
              [columns]="columns"
              [rows]="page.items"
              data-testid="quotes"
            >
              <ng-template let-row let-column="column">
                @switch (column.key) {
                  @case ('number') {
                    <span class="font-medium">{{ row.number ?? 'Rascunho' }}</span>
                  }
                  @case ('customer') {
                    {{ customerName(row.customerId) }}
                  }
                  @case ('validity') {
                    {{ row.validUntil }}
                  }
                  @case ('total') {
                    {{ money(row.totals.total) }} {{ row.currency }}
                  }
                  @case ('status') {
                    <app-badge [tone]="status(row.status).tone">{{
                      status(row.status).label
                    }}</app-badge>
                  }
                  @case ('actions') {
                    <app-button size="sm" variant="secondary" (click)="open(row)">Abrir</app-button>
                  }
                }
              </ng-template>
            </app-table>
          }
        }
      </app-card>
    } @else if (creating()) {
      <app-card>
        <h2 class="mb-4 text-base font-semibold">Nova proposta</h2>
        @if (clientError(); as text) {
          <app-alert tone="danger" class="mb-4 block">{{ text }}</app-alert>
        }
        <div class="grid gap-4 sm:grid-cols-2">
          <app-select
            label="Cliente"
            [required]="true"
            [options]="customerOptions()"
            [ngModel]="customerId()"
            (ngModelChange)="customerId.set($event ?? '')"
          />
          <app-input
            label="Válida até"
            type="date"
            [required]="true"
            [ngModel]="validUntil()"
            (ngModelChange)="validUntil.set($event ?? '')"
          />
        </div>
        <div class="mt-5 flex gap-2">
          <app-button [loading]="busy()" (click)="create()">Criar proposta</app-button>
          <app-button variant="secondary" (click)="creating.set(false)">Fechar</app-button>
        </div>
      </app-card>
    } @else if (quote(); as q) {
      <app-card>
        <div class="flex flex-wrap items-center justify-between gap-3">
          <h2 class="text-base font-semibold">
            {{ q.number ?? 'Proposta em rascunho' }}
            <app-badge class="ms-2" [tone]="status(q.status).tone">{{
              status(q.status).label
            }}</app-badge>
          </h2>
          <span class="text-sm text-fg-muted">
            {{ customerName(q.customerId) }} · válida até {{ q.validUntil }} · {{ q.currency }}
          </span>
        </div>
        <div class="mt-4 flex flex-wrap gap-2">
          @if (canManage() && q.status === 'DRAFT') {
            <app-button [loading]="busy()" (click)="send()">Enviar</app-button>
          }
          @if (canManage() && q.status === 'SENT') {
            <app-button [loading]="busy()" (click)="accept()">Aceitar e criar encomenda</app-button>
            <app-button variant="secondary" [loading]="busy()" (click)="reject()"
              >Rejeitar</app-button
            >
          }
          <app-button variant="secondary" (click)="close()">Fechar</app-button>
        </div>
      </app-card>
      <div class="mt-4">
        <app-sales-lines
          [lines]="q.lines ?? []"
          [totals]="q.totals"
          [currency]="q.currency"
          [editable]="canManage() && q.status === 'DRAFT'"
          [busy]="busy()"
          (added)="addLine($event)"
          (removed)="removeLine($event)"
        />
      </div>
    }
  `,
})
export class QuotesTab {
  private readonly api = inject(OrdersApi);
  private readonly permissions = inject(PermissionService);

  protected readonly columns = COLUMNS;
  protected readonly statuses = STATUSES;
  protected readonly canManage = computed(() => this.permissions.can('quote.manage'));

  protected readonly query = signal('');
  protected readonly statusFilter = signal('');
  private readonly reload = signal(0);

  protected readonly quotes = rxResource({
    params: () => ({ q: this.query().trim(), status: this.statusFilter(), reload: this.reload() }),
    stream: ({ params }) =>
      this.api.quotes({ q: params.q || undefined, status: params.status || undefined, limit: 100 }),
  });
  protected readonly loadError = computed(() =>
    documentError(this.quotes.error(), 'Tente novamente.'),
  );

  private readonly customers = rxResource({ stream: () => this.api.customers() });
  protected readonly customerOptions = computed<readonly SelectOption[]>(() =>
    (this.customers.hasValue() ? this.customers.value() : []).map((c) => ({
      value: c.id,
      label: `${c.partyName} (${c.code})`,
    })),
  );

  protected readonly notice = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);
  protected readonly clientError = signal<string | null>(null);
  protected readonly busy = signal(false);

  protected readonly creating = signal(false);
  protected readonly customerId = signal('');
  protected readonly validUntil = signal('');
  protected readonly quote = signal<QuoteDto | null>(null);

  protected status(status: QuoteStatus) {
    return QUOTE_STATUS[status];
  }

  protected money(value: string): string {
    return formatDecimal(value);
  }

  protected customerName(id: string): string {
    const list = this.customers.hasValue() ? this.customers.value() : [];
    return list.find((c) => c.id === id)?.partyName ?? '—';
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
        this.actionError.set(documentError(error, 'Não foi possível concluir a operação.')),
    });
  }

  protected startNew(): void {
    this.reset();
    this.customerId.set('');
    const inThirtyDays = new Date(Date.now() + 30 * 86_400_000);
    this.validUntil.set(inThirtyDays.toISOString().slice(0, 10));
    this.creating.set(true);
  }

  protected create(): void {
    this.reset();
    const customer = (this.customers.hasValue() ? this.customers.value() : []).find(
      (c) => c.id === this.customerId(),
    );
    if (!customer) return void this.clientError.set('Escolha o cliente.');
    if (!this.validUntil()) return void this.clientError.set('Indique a validade.');
    this.run(
      this.api.createQuote({
        organizationId: customer.organizationId,
        customerId: customer.id,
        validUntil: this.validUntil(),
      }),
      (created) => {
        this.creating.set(false);
        this.quote.set(created);
        this.notice.set('Proposta criada. Acrescente as linhas.');
      },
    );
  }

  protected open(row: QuoteDto): void {
    this.reset();
    this.run(this.api.quote(row.id), (full) => this.quote.set(full));
  }

  protected close(): void {
    this.quote.set(null);
    this.reload.update((n) => n + 1);
  }

  protected addLine(request: NewLineRequest): void {
    const current = this.quote();
    if (!current) return;
    this.reset();
    this.run(this.api.variantIdBySku(request.sku), (variantId) =>
      this.run(
        this.api.addQuoteLine(current.id, {
          variantId,
          quantity: request.quantity,
          ...(request.discountRate ? { discountRate: request.discountRate } : {}),
        }),
        (updated) => this.quote.set(updated),
      ),
    );
  }

  protected removeLine(lineId: string): void {
    const current = this.quote();
    if (!current) return;
    this.reset();
    this.run(this.api.removeQuoteLine(current.id, lineId), (updated) => this.quote.set(updated));
  }

  protected send(): void {
    const current = this.quote();
    if (!current) return;
    this.reset();
    this.run(this.api.sendQuote(current.id), (sent) => {
      this.quote.set(sent);
      this.notice.set(`Proposta ${sent.number} enviada.`);
    });
  }

  protected reject(): void {
    const current = this.quote();
    if (!current) return;
    this.reset();
    this.run(this.api.rejectQuote(current.id), (rejected) => {
      this.quote.set(rejected);
      this.notice.set('Proposta rejeitada.');
    });
  }

  protected accept(): void {
    const current = this.quote();
    if (!current) return;
    this.reset();
    this.run(this.api.acceptQuote(current.id), (result) => {
      this.quote.set(result.quote);
      this.notice.set(
        result.idempotent
          ? 'A proposta já tinha sido aceite: a encomenda é a mesma.'
          : 'Proposta aceite. Foi criada uma encomenda em rascunho (separador Encomendas).',
      );
    });
  }
}
