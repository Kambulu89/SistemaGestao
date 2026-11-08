import { Component, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { formatDate } from '../ui/dates';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField } from '../ui/form-field';
import { Icon } from '../ui/icon';
import { Action } from '../ui/load';
import { Modal } from '../ui/modal';
import { formatMoney, MoneyInput } from '../ui/money-input';
import { ToastService } from '../ui/toasts';
import {
  type Contract,
  CONTRACT_STATUS,
  CONTRACT_TYPE,
  type ContractStatus,
  contractPayload,
  contractTone,
} from './contracts-model';

/** Contratos na ficha do colaborador: só aparece a quem a API deixa ver contratos (confidenciais). */
@Component({
  selector: 'app-contracts-card',
  imports: [FormsModule, RouterLink, FormField, FieldControl, Modal, MoneyInput, ErrorAlert, Icon],
  template: `
    @if (items(); as list) {
      <section class="card" aria-labelledby="contracts-title" data-testid="contracts">
        <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 id="contracts-title" class="font-semibold">Contratos</h2>
          @if (canManage()) {
            <button type="button" class="btn-secondary" data-testid="new-contract" (click)="open()">
              <app-icon name="plus" [size]="16" />Novo contrato
            </button>
          }
        </div>
        @if (list.length) {
          <ul class="divide-y divide-border text-sm">
            @for (c of list; track c.id) {
              <li class="flex flex-wrap items-center justify-between gap-2 py-2">
                <div class="min-w-0">
                  <a class="link" [routerLink]="['/rh/contratos', c.id]">{{ c.code }}</a>
                  <span class="text-muted">
                    · {{ type(c.contractType) }} · {{ date(c.startDate)
                    }}{{ c.currentTerms.endDate ? ' – ' + date(c.currentTerms.endDate) : '' }}</span
                  >
                  @if (c.termExceeded) {
                    <p class="text-xs text-warning-text">Termo ultrapassado: renove ou termine.</p>
                  }
                </div>
                <span class="badge" [class]="tone(c.status)">{{ status(c.status) }}</span>
              </li>
            }
          </ul>
        } @else {
          <p class="text-sm text-muted">Sem contratos.</p>
        }
      </section>
    }

    <app-modal title="Novo contrato" [open]="opened()" (closed)="opened.set(false)">
      <app-error-alert [error]="action.error()" [showDetails]="false" />
      <p class="mb-3 text-sm text-muted">
        Fica em rascunho até ser activado. Depois só muda por adenda.
      </p>
      <div class="space-y-3">
        <app-field label="Número" [required]="true" [error]="action.field('code')">
          <input
            appControl
            class="input"
            data-testid="ct-code"
            [(ngModel)]="form['code']"
            [ngModelOptions]="{ standalone: true }"
          />
        </app-field>
        <app-field label="Tipo" [required]="true" [error]="action.field('contractType')">
          <select
            appControl
            class="input"
            data-testid="ct-type"
            [(ngModel)]="form['contractType']"
            [ngModelOptions]="{ standalone: true }"
          >
            @for (t of types; track t[0]) {
              <option [value]="t[0]">{{ t[1] }}</option>
            }
          </select>
        </app-field>
        <app-field label="Início" [required]="true" [error]="action.field('startDate')">
          <input
            appControl
            class="input"
            type="date"
            data-testid="ct-start"
            [(ngModel)]="form['startDate']"
            [ngModelOptions]="{ standalone: true }"
          />
        </app-field>
        <app-field
          label="Termo"
          [required]="form['contractType'] === 'FIXED_TERM'"
          [error]="action.field('endDate')"
        >
          <input
            appControl
            class="input"
            type="date"
            data-testid="ct-end"
            [(ngModel)]="form['endDate']"
            [ngModelOptions]="{ standalone: true }"
          />
        </app-field>
        <app-field label="Fim do período experimental" [error]="action.field('probationEndDate')">
          <input
            appControl
            class="input"
            type="date"
            [(ngModel)]="form['probationEndDate']"
            [ngModelOptions]="{ standalone: true }"
          />
        </app-field>
        <app-field label="Horas semanais" [required]="true" [error]="action.field('weeklyHours')">
          <input
            appControl
            class="input"
            inputmode="decimal"
            data-testid="ct-hours"
            [(ngModel)]="form['weeklyHours']"
            [ngModelOptions]="{ standalone: true }"
          />
        </app-field>
        <app-field label="Horário" [error]="action.field('workSchedule')">
          <input
            appControl
            class="input"
            [(ngModel)]="form['workSchedule']"
            [ngModelOptions]="{ standalone: true }"
          />
        </app-field>
        <app-field label="Moeda" [required]="true" [error]="action.field('currency')">
          <input
            appControl
            class="input uppercase"
            maxlength="3"
            [(ngModel)]="form['currency']"
            [ngModelOptions]="{ standalone: true }"
          />
        </app-field>
        <app-field
          label="Remuneração base (mensal)"
          [required]="true"
          [error]="action.field('baseSalary')"
        >
          <app-money-input
            data-testid="ct-salary"
            [currency]="currency()"
            [(ngModel)]="form['baseSalary']"
            [ngModelOptions]="{ standalone: true }"
          />
        </app-field>
      </div>
      <ng-container actions>
        <button type="button" class="btn-secondary" (click)="opened.set(false)">Cancelar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="ct-confirm"
          [disabled]="action.busy()"
          (click)="save()"
        >
          Criar contrato
        </button>
      </ng-container>
    </app-modal>
  `,
})
export class ContractsCard {
  readonly employeeId = input.required<string>();
  readonly hireDate = input<string | null>(null);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  protected readonly items = signal<Contract[] | null>(null);
  protected readonly canManage = signal(false);
  protected readonly opened = signal(false);
  protected readonly action = new Action();
  protected readonly date = formatDate;
  protected readonly money = (v: string) => formatMoney(v);
  protected readonly tone = contractTone;
  protected readonly type = (t: keyof typeof CONTRACT_TYPE) => CONTRACT_TYPE[t];
  protected readonly status = (s: ContractStatus) => CONTRACT_STATUS[s];
  protected readonly types = Object.entries(CONTRACT_TYPE);
  protected form: Record<string, unknown> = {};

  constructor() {
    effect(() => {
      const id = this.employeeId();
      untracked(() => void this.load(id));
    });
  }

  protected currency() {
    return String(this.form['currency'] ?? 'AOA').toUpperCase();
  }

  private async load(id: string) {
    try {
      const r = await this.api.get<{ items: Contract[]; canManage: boolean }>(
        `hr/employees/${id}/contracts`,
      );
      this.items.set(r.items);
      this.canManage.set(r.canManage);
    } catch {
      // Sem acesso a contratos: o cartão não aparece.
      this.items.set(null);
    }
  }

  protected open() {
    this.action.error.set(null);
    this.form = {
      contractType: 'PERMANENT',
      startDate: this.hireDate() ?? '',
      weeklyHours: '40',
      currency: 'AOA',
    };
    this.opened.set(true);
  }

  protected async save() {
    const result = await this.action.run(() =>
      this.api.post<Contract>(
        `hr/employees/${this.employeeId()}/contracts`,
        contractPayload(this.form, null),
      ),
    );
    if (!result) return;
    this.opened.set(false);
    this.toasts.show('Contrato criado em rascunho.');
    await this.router.navigate(['/rh/contratos', result.id]);
  }
}
