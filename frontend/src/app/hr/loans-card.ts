import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField } from '../ui/form-field';
import { Icon } from '../ui/icon';
import { Action } from '../ui/load';
import { Modal } from '../ui/modal';
import { formatMoney, MoneyInput } from '../ui/money-input';
import { ToastService } from '../ui/toasts';
import {
  type EmployeeLoans,
  installmentPreview,
  type Loan,
  LOAN_KIND,
  LOAN_STATUS,
  type LoanKind,
  type LoanStatus,
  loanTone,
  periodLabel,
} from './loans-model';

/**
 * Adiantamentos e empréstimos na ficha do colaborador: saldo em dívida e pedidos. Só aparece a quem a API deixa ver
 * empréstimos deste colaborador.
 */
@Component({
  selector: 'app-loans-card',
  imports: [FormsModule, RouterLink, FormField, FieldControl, Modal, ErrorAlert, Icon, MoneyInput],
  template: `
    @if (data(); as d) {
      <section class="card" aria-labelledby="loans-title" data-testid="loans">
        <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 id="loans-title" class="font-semibold">Adiantamentos e empréstimos</h2>
          @if (d.access.manage) {
            <button type="button" class="btn-secondary" data-testid="new-loan" (click)="open()">
              <app-icon name="plus" [size]="16" />Novo pedido
            </button>
          }
        </div>
        @if (d.outstanding) {
          <p class="mb-3 text-sm" data-testid="loans-outstanding">
            Em dívida: <strong class="tabular-nums">{{ money(d.outstanding) }}</strong>
          </p>
        }
        @if (d.items.length) {
          <ul class="divide-y divide-border text-sm">
            @for (l of d.items; track l.id) {
              <li class="flex flex-wrap items-center justify-between gap-2 py-2">
                <a class="link" [routerLink]="['/rh/emprestimos', l.id]">
                  {{ l.code }} · {{ kind(l.kind) }} de {{ money(l.principal) }} {{ l.currency }}
                </a>
                <span class="flex items-center gap-2">
                  @if (l.status === 'ACTIVE') {
                    <span class="text-muted tabular-nums"
                      >falta {{ money(l.outstandingAmount) }}</span
                    >
                  }
                  <span class="badge" [class]="tone(l.status)">{{ status(l.status) }}</span>
                </span>
              </li>
            }
          </ul>
        } @else {
          <p class="text-sm text-muted">Sem adiantamentos nem empréstimos.</p>
        }
      </section>
    }

    <app-modal
      title="Novo adiantamento ou empréstimo"
      [open]="opened()"
      (closed)="opened.set(false)"
    >
      <app-error-alert [error]="action.error()" [showDetails]="false" />
      <p class="mb-3 text-sm text-muted">
        Fica em rascunho. O plano de prestações cria-se na aprovação e desconta-se no processamento
        salarial, sem juros.
      </p>
      <div class="space-y-3">
        <app-field label="Tipo" [required]="true" [error]="action.field('kind')">
          <select
            appControl
            class="input"
            data-testid="loan-kind"
            [ngModel]="form.kind()"
            [ngModelOptions]="{ standalone: true }"
            (ngModelChange)="setKind($event)"
          >
            <option value="ADVANCE">Adiantamento (uma prestação)</option>
            <option value="LOAN">Empréstimo (várias prestações)</option>
          </select>
        </app-field>
        <app-field label="Montante" [required]="true" [error]="action.field('principal')">
          <app-money-input
            data-testid="loan-principal"
            [currency]="currencyHint()"
            [ngModel]="form.principal()"
            [ngModelOptions]="{ standalone: true }"
            (ngModelChange)="form.principal.set($event)"
          />
        </app-field>
        <div class="grid gap-3 sm:grid-cols-2">
          <app-field
            label="Prestações"
            [required]="true"
            [error]="action.field('installmentsCount')"
          >
            <input
              appControl
              class="input"
              type="number"
              min="1"
              max="120"
              data-testid="loan-count"
              [disabled]="form.kind() === 'ADVANCE'"
              [ngModel]="form.count()"
              [ngModelOptions]="{ standalone: true }"
              (ngModelChange)="form.count.set($event)"
            />
          </app-field>
          <app-field
            label="Primeiro desconto (mês)"
            [required]="true"
            [error]="action.field('firstPeriod')"
          >
            <input
              appControl
              class="input"
              type="month"
              data-testid="loan-first"
              [ngModel]="form.first()"
              [ngModelOptions]="{ standalone: true }"
              (ngModelChange)="form.first.set($event)"
            />
          </app-field>
        </div>
        @if (preview(); as p) {
          <p class="text-sm text-muted" data-testid="loan-preview">
            {{ form.count() }} × {{ money(p.regular) }}
            @if (p.last !== p.regular) {
              (a última {{ money(p.last) }})
            }
            @if (form.first()) {
              a partir de {{ month(form.first()) }}
            }
          </p>
        }
        <app-field label="Motivo" [required]="true" [error]="action.field('reason')">
          <textarea
            appControl
            class="input min-h-20"
            data-testid="loan-reason"
            [ngModel]="form.reason()"
            [ngModelOptions]="{ standalone: true }"
            (ngModelChange)="form.reason.set($event)"
          ></textarea>
        </app-field>
        @if (action.field('currency')) {
          <p class="field-error">{{ action.field('currency') }}</p>
        }
      </div>
      <ng-container actions>
        <button type="button" class="btn-secondary" (click)="opened.set(false)">Cancelar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="loan-confirm"
          [disabled]="action.busy()"
          (click)="save()"
        >
          Guardar rascunho
        </button>
      </ng-container>
    </app-modal>
  `,
})
export class LoansCard {
  readonly employeeId = input.required<string>();
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  protected readonly data = signal<EmployeeLoans | null>(null);
  protected readonly opened = signal(false);
  protected readonly action = new Action();
  protected readonly form = {
    kind: signal<LoanKind>('ADVANCE'),
    principal: signal<string | null>(null),
    count: signal<number | null>(1),
    first: signal(''),
    reason: signal(''),
  };
  protected readonly preview = computed(() =>
    installmentPreview(this.form.principal(), this.form.count()),
  );
  protected readonly currencyHint = computed(
    () => this.data()?.items.find((l) => l.status === 'ACTIVE')?.currency ?? 'AOA',
  );
  protected readonly money = (v: string) => formatMoney(v);
  protected readonly month = periodLabel;
  protected readonly tone = loanTone;
  protected readonly status = (s: LoanStatus) => LOAN_STATUS[s];
  protected readonly kind = (k: LoanKind) => LOAN_KIND[k];

  constructor() {
    effect(() => {
      const id = this.employeeId();
      untracked(() => void this.load(id));
    });
  }

  private async load(id: string) {
    try {
      this.data.set(await this.api.get<EmployeeLoans>(`hr/employees/${id}/loans`));
    } catch {
      this.data.set(null);
    }
  }

  protected setKind(k: LoanKind) {
    this.form.kind.set(k);
    if (k === 'ADVANCE') this.form.count.set(1);
  }

  protected open() {
    this.action.error.set(null);
    const next = new Date();
    next.setUTCMonth(next.getUTCMonth() + 1, 1);
    this.form.kind.set('ADVANCE');
    this.form.principal.set(null);
    this.form.count.set(1);
    this.form.first.set(next.toISOString().slice(0, 7));
    this.form.reason.set('');
    this.opened.set(true);
  }

  protected async save() {
    const count = Number(this.form.count());
    const result = await this.action.run(() =>
      this.api.post<Loan>(`hr/employees/${this.employeeId()}/loans`, {
        kind: this.form.kind(),
        principal: this.form.principal(),
        installmentsCount: Number.isInteger(count) ? count : null,
        firstPeriod: this.form.first() || null,
        reason: this.form.reason(),
      }),
    );
    if (!result) return;
    this.opened.set(false);
    this.toasts.show('Pedido guardado em rascunho.');
    await this.router.navigate(['/rh/emprestimos', result.id]);
  }
}
