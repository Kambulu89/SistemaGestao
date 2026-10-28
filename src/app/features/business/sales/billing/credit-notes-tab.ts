import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { finalize, type Observable } from 'rxjs';
import { PermissionService } from '../../../../core/permissions/permission.service';
import { TenantContextService } from '../../../../core/tenant-context/tenant-context.service';
import { Alert } from '../../../../shared/ui/alert/alert';
import { Badge } from '../../../../shared/ui/badge/badge';
import { Button } from '../../../../shared/ui/button/button';
import { Card } from '../../../../shared/ui/card/card';
import { EmptyState } from '../../../../shared/ui/empty-state/empty-state';
import { Input } from '../../../../shared/ui/input/input';
import { LoadingState } from '../../../../shared/ui/loading-state/loading-state';
import { Select, type SelectOption } from '../../../../shared/ui/select/select';
import { Table, type TableColumn } from '../../../../shared/ui/table/table';
import { isPositiveQuantity } from '../orders/orders-model';
import { BillingApi, type CreditNoteDto, type InvoiceDto } from './billing.api';
import { billingError, CREDIT_NOTE_STATUS, formatDecimal, trimQuantity } from './billing-model';

/**
 * Notas de crédito (M05): corrigem uma factura emitida sem a alterar. O crédito é proporcional à quantidade e nunca
 * ultrapassa o que falta creditar (o servidor confere, somando as notas já emitidas). Uma nota não devolve stock.
 */
@Component({
  selector: 'app-billing-credit-notes',
  imports: [
    DatePipe,
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
      <app-alert tone="success" class="mb-3 block">{{ text }}</app-alert>
    }
    @if (actionError(); as text) {
      <app-alert tone="danger" title="Não foi possível concluir a operação" class="mb-3 block">
        {{ text }}
      </app-alert>
    }

    @if (creating()) {
      <app-card>
        <h2 class="mb-4 text-base font-semibold">Nova nota de crédito</h2>
        <app-select
          label="Factura"
          placeholder="Escolha a factura a creditar"
          [required]="true"
          [options]="invoiceOptions()"
          [ngModel]="invoiceId()"
          (ngModelChange)="chooseInvoice($event ?? '')"
        />
        @if (target(); as inv) {
          <div class="mt-4 overflow-x-auto">
            <table class="w-full text-sm" data-testid="credit-lines">
              <thead>
                <tr class="text-left text-fg-muted">
                  <th class="py-1 pe-3">Descrição</th>
                  <th class="py-1 pe-3 text-end">Facturada</th>
                  <th class="py-1 pe-3 text-end">Líquido</th>
                  <th class="py-1 w-40">A creditar</th>
                </tr>
              </thead>
              <tbody>
                @for (line of inv.lines ?? []; track line.id) {
                  <tr class="border-t border-line">
                    <td class="py-2 pe-3">{{ line.description }}</td>
                    <td class="py-2 pe-3 text-end">{{ trim(line.quantity) }}</td>
                    <td class="py-2 pe-3 text-end">{{ money(line.netAmount) }}</td>
                    <td class="py-2">
                      <input
                        class="h-9 w-full rounded-lg border border-line bg-surface px-2 text-sm"
                        [attr.aria-label]="'Quantidade a creditar de ' + line.description"
                        [value]="quantities()[line.id] ?? ''"
                        (input)="setQuantity(line.id, $any($event.target).value)"
                      />
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
        <div class="mt-4 max-w-md">
          <app-input
            label="Motivo"
            [ngModel]="reason()"
            (ngModelChange)="reason.set($event ?? '')"
          />
        </div>
        @if (clientError(); as text) {
          <p class="mt-3 text-sm text-red-600" role="alert">{{ text }}</p>
        }
        <div class="mt-5 flex gap-2">
          <app-button [loading]="busy()" (click)="create()">Criar rascunho</app-button>
          <app-button variant="secondary" (click)="creating.set(false)">Fechar</app-button>
        </div>
      </app-card>
    } @else if (note(); as n) {
      <app-card>
        <div class="flex flex-wrap items-center justify-between gap-3">
          <h2 class="text-base font-semibold">
            {{ n.number ?? 'Nota de crédito em rascunho' }}
            <app-badge class="ms-2" [tone]="status(n).tone">{{ status(n).label }}</app-badge>
          </h2>
          <span class="text-sm text-fg-muted">
            Factura {{ invoiceNumber(n.invoiceId) }}
            @if (n.issuedOn) {
              · emitida em {{ n.issuedOn | date: 'dd/MM/yyyy' }}
            }
          </span>
        </div>
        <p class="mt-2 text-sm">Motivo: {{ n.reason }}</p>
        <ul class="mt-4 divide-y divide-line" data-testid="note-lines">
          @for (line of n.lines ?? []; track line.id) {
            <li class="flex items-center justify-between py-2 text-sm">
              <span>{{ lineName(line.invoiceLineId) }} × {{ trim(line.quantity) }}</span>
              <strong>{{ money(line.amount) }} + {{ money(line.taxAmount) }}</strong>
            </li>
          } @empty {
            <li class="py-2 text-sm text-fg-muted">Sem linhas.</li>
          }
        </ul>
        <p class="mt-3 text-end text-sm" data-testid="note-totals">
          Líquido {{ money(n.totals.net) }} · Imposto {{ money(n.totals.tax) }} ·
          <strong>Total {{ money(n.totals.total) }}</strong>
        </p>
        @if (clientError(); as text) {
          <p class="mt-3 text-sm text-red-600" role="alert">{{ text }}</p>
        }
        <div class="mt-4 flex flex-wrap gap-2">
          @if (n.status === 'DRAFT' && canIssue()) {
            <app-button [loading]="busy()" (click)="issue()">Emitir</app-button>
          }
          @if (n.status === 'DRAFT' && canManage()) {
            <app-button variant="secondary" [loading]="busy()" (click)="remove()"
              >Apagar rascunho</app-button
            >
          }
          <app-button variant="secondary" (click)="close()">Fechar</app-button>
        </div>
      </app-card>
    } @else {
      <div class="mb-3 flex justify-end">
        @if (canManage()) {
          <app-button (click)="startNew()">Nova nota de crédito</app-button>
        }
      </div>
      <app-card [flush]="true">
        @if (notes.isLoading() && !notes.hasValue()) {
          <app-loading-state label="A carregar notas de crédito…" />
        } @else if (notes.error()) {
          <div class="p-5">
            <app-alert tone="danger" title="Não foi possível carregar as notas de crédito">{{
              loadError()
            }}</app-alert>
          </div>
        } @else if (notes.value(); as page) {
          @if (page.items.length === 0) {
            <app-empty-state icon="document" title="Sem notas de crédito" />
          } @else {
            <app-table
              caption="Notas de crédito"
              [columns]="columns"
              [rows]="page.items"
              data-testid="credit-notes"
            >
              <ng-template let-row let-column="column">
                @switch (column.key) {
                  @case ('number') {
                    <span class="font-medium">{{ row.number ?? 'Rascunho' }}</span>
                  }
                  @case ('invoice') {
                    {{ invoiceNumber(row.invoiceId) }}
                  }
                  @case ('status') {
                    <app-badge [tone]="status(row).tone">{{ status(row).label }}</app-badge>
                  }
                  @case ('total') {
                    {{ money(row.totals.total) }}
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
    }
  `,
})
export class CreditNotesTab {
  private readonly api = inject(BillingApi);
  private readonly permissions = inject(PermissionService);
  private readonly tenantId = inject(TenantContextService).tenant;

  protected readonly canManage = computed(() => this.permissions.can('credit_note.manage'));
  protected readonly canIssue = computed(() => this.permissions.can('credit_note.issue'));
  protected readonly columns: readonly TableColumn[] = [
    { key: 'number', label: 'Número' },
    { key: 'invoice', label: 'Factura' },
    { key: 'status', label: 'Estado' },
    { key: 'total', label: 'Total', align: 'end' },
    { key: 'actions', label: '', align: 'end' },
  ];

  private readonly reload = signal(0);
  private readonly params = () => {
    const tenant = this.tenantId();
    return tenant ? { tenantId: tenant.id, reload: this.reload() } : undefined;
  };
  protected readonly notes = rxResource({
    params: this.params,
    stream: () => this.api.creditNotes({ limit: 100 }),
  });
  private readonly invoices = rxResource({
    params: this.params,
    stream: () => this.api.invoices({ limit: 200 }),
  });

  protected readonly creating = signal(false);
  protected readonly invoiceId = signal('');
  protected readonly target = signal<InvoiceDto | null>(null);
  protected readonly quantities = signal<Readonly<Record<string, string>>>({});
  protected readonly reason = signal('');
  protected readonly note = signal<CreditNoteDto | null>(null);
  /** A factura da nota aberta (para dar nome às linhas). */
  private readonly noteInvoice = signal<InvoiceDto | null>(null);
  protected readonly busy = signal(false);
  protected readonly notice = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);
  protected readonly clientError = signal<string | null>(null);

  protected readonly invoiceOptions = computed<readonly SelectOption[]>(() =>
    (this.invoices.hasValue() ? this.invoices.value().items : [])
      .filter((i) => i.status === 'ISSUED')
      .map((i) => ({ value: i.id, label: `${i.number} — ${i.totals.total} ${i.currency}` })),
  );

  protected trim = trimQuantity;
  protected money = formatDecimal;
  protected status = (n: CreditNoteDto) => CREDIT_NOTE_STATUS[n.status];
  protected loadError = () => billingError(this.notes.error(), 'Pedido falhado.');

  protected invoiceNumber(id: string): string {
    const found = (this.invoices.hasValue() ? this.invoices.value().items : []).find(
      (i) => i.id === id,
    );
    return found?.number ?? id.slice(0, 8);
  }

  protected lineName(invoiceLineId: string): string {
    return (
      this.noteInvoice()?.lines?.find((l) => l.id === invoiceLineId)?.description ??
      invoiceLineId.slice(0, 8)
    );
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
        this.actionError.set(billingError(error, 'Não foi possível concluir a operação.')),
    });
  }

  protected startNew(): void {
    this.reset();
    this.invoiceId.set('');
    this.target.set(null);
    this.quantities.set({});
    this.reason.set('');
    this.creating.set(true);
  }

  protected chooseInvoice(id: string): void {
    this.invoiceId.set(id);
    this.target.set(null);
    this.quantities.set({});
    if (!id) return;
    this.run(this.api.invoice(id), (inv) => this.target.set(inv));
  }

  protected setQuantity(lineId: string, value: string): void {
    this.quantities.update((q) => ({ ...q, [lineId]: value }));
  }

  protected create(): void {
    this.reset();
    const inv = this.target();
    if (!inv) return void this.clientError.set('Escolha a factura.');
    if (!this.reason().trim()) return void this.clientError.set('Indique o motivo.');
    const lines: { invoiceLineId: string; quantity: string }[] = [];
    for (const line of inv.lines ?? []) {
      const quantity = (this.quantities()[line.id] ?? '').trim();
      if (quantity === '' || quantity === '0') continue;
      if (!isPositiveQuantity(quantity)) {
        return void this.clientError.set(`«${line.description}»: quantidade positiva.`);
      }
      lines.push({ invoiceLineId: line.id, quantity });
    }
    if (lines.length === 0)
      return void this.clientError.set('Indique a quantidade de pelo menos uma linha.');
    this.run(
      this.api.createCreditNote({ invoiceId: inv.id, reason: this.reason().trim(), lines }),
      (created) => {
        this.creating.set(false);
        this.noteInvoice.set(inv);
        this.note.set(created);
        this.notice.set('Rascunho criado. Reveja as linhas e emita a nota.');
        this.reload.update((n) => n + 1);
      },
    );
  }

  protected open(row: CreditNoteDto): void {
    this.reset();
    this.run(this.api.creditNote(row.id), (full) =>
      this.run(this.api.invoice(full.invoiceId), (inv) => {
        this.noteInvoice.set(inv);
        this.note.set(full);
      }),
    );
  }

  protected close(): void {
    this.note.set(null);
    this.creating.set(false);
    this.reload.update((n) => n + 1);
  }

  protected issue(): void {
    const current = this.note();
    if (!current) return;
    this.reset();
    this.run(this.api.issueCreditNote(current.id), (result) => {
      this.note.set(result.creditNote);
      this.notice.set(
        result.idempotent
          ? 'A nota já estava emitida.'
          : `Nota de crédito ${result.creditNote.number} emitida.`,
      );
    });
  }

  protected remove(): void {
    const current = this.note();
    if (!current) return;
    this.reset();
    this.run(this.api.deleteCreditNote(current.id), () => {
      this.note.set(null);
      this.notice.set('Rascunho apagado.');
      this.reload.update((n) => n + 1);
    });
  }
}
