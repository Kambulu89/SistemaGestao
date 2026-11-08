import { Component, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { formatDate } from '../ui/dates';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField } from '../ui/form-field';
import { Action } from '../ui/load';
import { Modal } from '../ui/modal';
import { ToastService } from '../ui/toasts';
import { daysLabel, LEDGER_KIND, type LedgerEntry, type LeaveSummary } from './leave-model';
import { LeaveRequestDialog } from './leave-request-dialog';

/** Férias na ficha do colaborador: saldo do ano, conta-corrente, pedir ausência e ajustes (quem gere). */
@Component({
  selector: 'app-leave-card',
  imports: [
    FormsModule,
    RouterLink,
    FormField,
    FieldControl,
    Modal,
    ErrorAlert,
    LeaveRequestDialog,
  ],
  template: `
    @if (data(); as d) {
      <section class="card" aria-labelledby="leave-title" data-testid="leave-card">
        <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 id="leave-title" class="font-semibold">Férias</h2>
          <div class="flex flex-wrap items-center gap-2">
            <label class="sr-only" for="leave-year">Ano</label>
            <select
              id="leave-year"
              class="input w-24"
              [ngModel]="year()"
              [ngModelOptions]="{ standalone: true }"
              (ngModelChange)="setYear($event)"
            >
              @for (y of years; track y) {
                <option [ngValue]="y">{{ y }}</option>
              }
            </select>
            @if (d.access.request) {
              <button
                type="button"
                class="btn-secondary"
                data-testid="leave-request"
                (click)="request()"
              >
                Pedir ausência
              </button>
            }
            @if (d.access.manage) {
              <button
                type="button"
                class="btn-secondary"
                data-testid="leave-adjust"
                (click)="openAdjust()"
              >
                Ajustar
              </button>
            }
          </div>
        </div>
        <dl class="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4" data-testid="leave-balance">
          <div>
            <dt class="text-muted">Direito</dt>
            <dd class="text-lg font-semibold tabular-nums">{{ days(d.balance.entitled) }}</dd>
          </div>
          <div>
            <dt class="text-muted">Gozados</dt>
            <dd class="text-lg font-semibold tabular-nums">{{ days(d.balance.taken) }}</dd>
          </div>
          <div>
            <dt class="text-muted">Pendentes</dt>
            <dd class="text-lg font-semibold tabular-nums">{{ days(d.balance.pending) }}</dd>
          </div>
          <div>
            <dt class="text-muted">Disponível</dt>
            <dd class="text-lg font-semibold tabular-nums" data-testid="leave-available">
              {{ days(d.balance.available) }}
            </dd>
          </div>
        </dl>
        @if (d.policy) {
          <p class="mt-2 text-xs text-muted">
            Política {{ d.policy.code }} v{{ d.policy.policyVersion }} ·
            {{ d.policy.legalReference }}
          </p>
        } @else {
          <p class="mt-2 text-xs text-warning-text">
            Sem política de férias em vigor para esta entidade.
          </p>
        }
        @if (d.ledger.length) {
          <details class="mt-3 text-sm">
            <summary class="cursor-pointer text-link">Conta-corrente de {{ year() }}</summary>
            <ul class="mt-2 space-y-1">
              @for (l of d.ledger; track l.id) {
                <li class="flex justify-between gap-2">
                  <span>
                    {{ kind(l.kind) }} · {{ date(l.effectiveDate) }}
                    @if (l.leaveRequestId) {
                      ·
                      <a class="link" [routerLink]="['/rh/ausencias', l.leaveRequestId]">pedido</a>
                    }
                    @if (l.reason) {
                      <span class="text-muted"> · {{ l.reason }}</span>
                    }
                  </span>
                  <span class="tabular-nums">{{ days(l.days) }}</span>
                </li>
              }
            </ul>
          </details>
        }
      </section>
    }

    <app-leave-request-dialog
      [open]="requesting()"
      [employeeId]="employeeId()"
      (closed)="requesting.set(false)"
      (created)="afterRequest()"
    />

    <app-modal title="Ajustar saldo de férias" [open]="adjusting()" (closed)="adjusting.set(false)">
      <app-error-alert [error]="action.error()" [showDetails]="false" />
      <p class="mb-3 text-sm text-muted">
        Fica na conta-corrente com o motivo; não altera registos anteriores.
      </p>
      <div class="space-y-3">
        <app-field
          label="Dias (negativo para retirar)"
          [required]="true"
          [error]="action.field('days')"
        >
          <input
            appControl
            class="input"
            inputmode="decimal"
            data-testid="adj-days"
            [(ngModel)]="adj.days"
            [ngModelOptions]="{ standalone: true }"
          />
        </app-field>
        <app-field label="Motivo" [required]="true" [error]="action.field('reason')">
          <textarea
            appControl
            class="input min-h-20"
            data-testid="adj-reason"
            [(ngModel)]="adj.reason"
            [ngModelOptions]="{ standalone: true }"
          ></textarea>
        </app-field>
      </div>
      <ng-container actions>
        <button type="button" class="btn-secondary" (click)="adjusting.set(false)">Cancelar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="adj-confirm"
          [disabled]="action.busy()"
          (click)="adjust()"
        >
          Registar ajuste
        </button>
      </ng-container>
    </app-modal>
  `,
})
export class LeaveCard {
  readonly employeeId = input.required<string>();
  private readonly api = inject(Api);
  private readonly toasts = inject(ToastService);
  private readonly dialog = viewChild.required(LeaveRequestDialog);
  protected readonly data = signal<LeaveSummary | null>(null);
  protected readonly year = signal(new Date().getFullYear());
  protected readonly years = [0, 1, 2].map((n) => new Date().getFullYear() + 1 - n);
  protected readonly requesting = signal(false);
  protected readonly adjusting = signal(false);
  protected readonly action = new Action();
  protected adj = { days: '', reason: '' };
  protected readonly days = daysLabel;
  protected readonly date = formatDate;
  protected readonly kind = (k: LedgerEntry['kind']) => LEDGER_KIND[k];

  constructor() {
    effect(() => {
      const id = this.employeeId();
      const y = this.year();
      untracked(() => void this.load(id, y));
    });
  }

  private async load(id: string, year: number) {
    try {
      this.data.set(await this.api.get<LeaveSummary>(`hr/employees/${id}/leave`, { year }));
    } catch {
      this.data.set(null);
    }
  }

  protected setYear(y: number) {
    this.year.set(Number(y));
  }

  protected async request() {
    await this.dialog().prepare();
    this.requesting.set(true);
  }

  protected afterRequest() {
    this.requesting.set(false);
    void this.load(this.employeeId(), this.year());
  }

  protected openAdjust() {
    this.action.error.set(null);
    this.adj = { days: '', reason: '' };
    this.adjusting.set(true);
  }

  protected async adjust() {
    const done = await this.action.run(() =>
      this.api.post(`hr/employees/${this.employeeId()}/leave/adjustments`, {
        year: this.year(),
        days: this.adj.days.trim().replace(',', '.'),
        reason: this.adj.reason,
      }),
    );
    if (!done) return;
    this.adjusting.set(false);
    this.toasts.show('Ajuste registado.');
    void this.load(this.employeeId(), this.year());
  }
}
