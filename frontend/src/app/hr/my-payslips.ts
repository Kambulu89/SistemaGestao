import { Component, inject, signal } from '@angular/core';
import { Api, ApiError } from '../core/api';
import { formatMoney } from '../ui/money-input';
import { PageHeader } from '../ui/page-header';
import { ErrorState, Skeleton } from '../ui/states';
import { ToastService } from '../ui/toasts';
import { monthName, type MyPayslip, RUN_KIND } from './payroll-model';
import { saveFile } from './save-file';

/** Os recibos de vencimento do próprio (lotes fechados), em PDF. Ninguém mais os vê aqui. */
@Component({
  selector: 'app-my-payslips',
  imports: [PageHeader, ErrorState, Skeleton],
  template: `
    <app-page-header
      title="Os meus recibos"
      subtitle="Recibos de vencimento dos processamentos fechados. Só você os vê aqui."
    />
    @if (error()) {
      <app-error-state [error]="error()" (retry)="load()" />
    } @else if (!items()) {
      <div class="card"><app-skeleton /></div>
    } @else if (!items()!.length) {
      <p class="card text-sm text-muted">Ainda não há recibos.</p>
    } @else {
      <ul class="card divide-y divide-border text-sm" data-testid="my-payslips">
        @for (p of items(); track p.id) {
          <li class="flex flex-wrap items-center justify-between gap-2 py-2">
            <span>
              <span class="font-medium">{{ month(p.period) }}</span>
              · {{ kind(p) }} · {{ p.company }}
            </span>
            <span class="flex items-center gap-3">
              <span class="tabular-nums">{{ money(p.net) }} {{ p.currency }}</span>
              <span
                class="badge"
                [class]="
                  p.paid ? 'bg-success-soft text-success-text' : 'bg-warning-soft text-warning-text'
                "
                >{{ p.paid ? 'Pago' : 'Por pagar' }}</span
              >
              <button
                type="button"
                class="btn-secondary"
                [attr.aria-label]="'Descarregar recibo de ' + month(p.period)"
                [attr.data-testid]="'my-payslip-' + p.runCode"
                (click)="download(p)"
              >
                PDF
              </button>
            </span>
          </li>
        }
      </ul>
    }
  `,
})
export class MyPayslips {
  private readonly api = inject(Api);
  private readonly toasts = inject(ToastService);
  protected readonly items = signal<MyPayslip[] | null>(null);
  protected readonly error = signal<ApiError | null>(null);
  protected readonly money = (v: string) => formatMoney(v);
  protected readonly month = monthName;
  protected readonly kind = (p: MyPayslip) => RUN_KIND[p.kind];

  constructor() {
    void this.load();
  }

  protected async load() {
    this.error.set(null);
    try {
      this.items.set(await this.api.get<MyPayslip[]>('hr/payslips'));
    } catch (e) {
      this.error.set(ApiError.from(e));
    }
  }

  protected async download(p: MyPayslip) {
    try {
      const { blob, fileName } = await this.api.download(`hr/payslips/${p.id}`);
      saveFile(blob, fileName ?? `recibo-${p.period.slice(0, 7)}.pdf`);
    } catch (e) {
      this.toasts.show(ApiError.from(e).message, 'error');
    }
  }
}
