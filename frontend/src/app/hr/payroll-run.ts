import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api, ApiError } from '../core/api';
import { Breadcrumbs } from '../core/breadcrumbs';
import { AuditHistory } from '../ui/audit-history';
import { ConfirmService } from '../ui/confirm';
import { formatDate, formatDateTime } from '../ui/dates';
import { FieldList } from '../ui/detail-drawer';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField } from '../ui/form-field';
import { Kpi } from '../ui/kpi';
import { Action } from '../ui/load';
import { Modal } from '../ui/modal';
import { formatMoney, MoneyInput } from '../ui/money-input';
import { PageDetail } from '../ui/page-detail';
import { ErrorState, Skeleton } from '../ui/states';
import { ToastService } from '../ui/toasts';
import {
  monthName,
  nextStep,
  type PayrollRun,
  pct,
  type ResultDetail,
  RUN_STATUS,
  type RunResult,
  runTitle,
  runTone,
} from './payroll-model';

interface Option {
  id: string;
  label: string;
}

/**
 * Lote de processamento: recibos por colaborador com erros, valores variáveis, exclusões, calcular (simulação sem
 * efeitos), pedir aprovação, aprovar ou recusar (outra pessoa), fechar (descontos dos empréstimos e fecho do mês).
 */
@Component({
  selector: 'app-payroll-run',
  imports: [
    FormsModule,
    PageDetail,
    FieldList,
    AuditHistory,
    Modal,
    FormField,
    FieldControl,
    ErrorAlert,
    ErrorState,
    Skeleton,
    Kpi,
    MoneyInput,
  ],
  template: `
    @if (loadError()) {
      <app-error-state [error]="loadError()" (retry)="reload()" />
    } @else if (!r()) {
      <div class="card"><app-skeleton /></div>
    } @else {
      @let x = r()!;
      <app-page-detail
        [title]="title(x)"
        [subtitle]="x.code + ' · ' + x.legalEntity.code + ' — ' + x.legalEntity.name"
      >
        <ng-container actions>
          @if (x.access?.edit) {
            <button
              type="button"
              class="btn-primary"
              data-testid="ps-calculate"
              [disabled]="action.busy()"
              (click)="calculate()"
            >
              {{ x.status === 'DRAFT' ? 'Calcular' : 'Recalcular' }}
            </button>
          }
          @if (x.access?.manage && x.status === 'CALCULATED') {
            <button type="button" class="btn-primary" data-testid="ps-submit" (click)="submit()">
              Pedir aprovação
            </button>
          }
          @if (x.access?.approve) {
            <button type="button" class="btn-primary" data-testid="ps-approve" (click)="approve()">
              Aprovar
            </button>
            <button
              type="button"
              class="btn-secondary"
              data-testid="ps-reject"
              (click)="rejecting.set(true)"
            >
              Recusar
            </button>
          }
          @if (x.access?.manage && x.status === 'APPROVED') {
            <button type="button" class="btn-primary" data-testid="ps-close" (click)="close()">
              Fechar
            </button>
          }
          @if (x.access?.edit) {
            <button type="button" class="btn-secondary" data-testid="ps-cancel" (click)="cancel()">
              Cancelar lote
            </button>
          }
        </ng-container>

        <p class="mb-4 flex flex-wrap items-center gap-2 text-sm">
          <span class="badge" [class]="tone(x.status)" data-testid="ps-status">{{
            status(x.status)
          }}</span>
          <span class="text-muted" data-testid="ps-next">{{ next(x) }}</span>
        </p>

        @if (x.status !== 'DRAFT') {
          <div class="mb-4 grid gap-3 sm:grid-cols-2 2xl:grid-cols-4">
            <app-kpi label="Colaboradores" [value]="x.employeesCount" testId="ps-kpi-count" />
            <app-kpi
              label="Com erros"
              [value]="x.errorsCount"
              [tone]="x.errorsCount ? 'danger' : 'success'"
              testId="ps-kpi-errors"
            />
            <app-kpi label="Líquido a pagar" [value]="money(x.totals.net)" testId="ps-kpi-net" />
            <app-kpi
              label="Custo para a empresa"
              [value]="money(x.totals.employerCost)"
              testId="ps-kpi-cost"
            />
          </div>
        }

        <section class="card" aria-labelledby="ps-results-title">
          <h2 id="ps-results-title" class="mb-3 font-semibold">Recibos</h2>
          @if (!x.results?.length) {
            <p class="text-sm text-muted">
              {{
                x.status === 'DRAFT'
                  ? 'Ainda não calculado.'
                  : 'Nenhum colaborador a processar neste lote.'
              }}
            </p>
          } @else {
            <div class="overflow-x-auto">
              <table class="w-full text-sm" data-testid="ps-results">
                <caption class="sr-only">
                  Recibos calculados
                </caption>
                <thead>
                  <tr class="text-left text-muted">
                    <th scope="col" class="py-1 pr-3 font-medium">Colaborador</th>
                    <th scope="col" class="py-1 pr-3 text-right font-medium">Bruto</th>
                    <th scope="col" class="py-1 pr-3 text-right font-medium">INSS</th>
                    <th scope="col" class="py-1 pr-3 text-right font-medium">IRT</th>
                    <th scope="col" class="py-1 pr-3 text-right font-medium">Descontos</th>
                    <th scope="col" class="py-1 pr-3 text-right font-medium">Líquido</th>
                    <th scope="col" class="py-1 font-medium">
                      <span class="sr-only">Acções</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  @for (p of x.results; track p.id) {
                    <tr
                      class="border-t border-border"
                      [attr.data-testid]="'ps-row-' + p.employee.code"
                    >
                      <td class="py-1 pr-3">
                        {{ p.employee.code }} — {{ p.employee.fullName }}
                        @for (e of p.errors; track $index) {
                          <p class="text-xs text-danger-text">{{ e.message }}</p>
                        }
                      </td>
                      @if (p.status === 'OK') {
                        <td class="py-1 pr-3 text-right whitespace-nowrap tabular-nums">
                          {{ money(p.gross!) }}
                        </td>
                        <td class="py-1 pr-3 text-right whitespace-nowrap tabular-nums">
                          {{ money(p.inssEmployee!) }}
                        </td>
                        <td class="py-1 pr-3 text-right whitespace-nowrap tabular-nums">
                          {{ money(p.irt!) }}
                        </td>
                        <td class="py-1 pr-3 text-right whitespace-nowrap tabular-nums">
                          {{ money(other(p)) }}
                        </td>
                        <td class="py-1 pr-3 text-right font-medium whitespace-nowrap tabular-nums">
                          {{ money(p.net!) }}
                        </td>
                      } @else {
                        <td colspan="5" class="py-1 pr-3">
                          <span class="badge bg-danger-soft text-danger-text">Com erros</span>
                        </td>
                      }
                      <td class="py-1 text-right whitespace-nowrap">
                        <button
                          type="button"
                          class="btn-ghost px-2 py-1"
                          [attr.aria-label]="'Ver recibo de ' + p.employee.fullName"
                          (click)="openResult(p)"
                        >
                          Ver
                        </button>
                        @if (x.access?.edit) {
                          <button
                            type="button"
                            class="btn-ghost px-2 py-1"
                            [attr.data-testid]="'ps-exclude-' + p.employee.code"
                            [attr.aria-label]="'Excluir ' + p.employee.fullName + ' do lote'"
                            (click)="exclude(p.employee.id, true)"
                          >
                            Excluir
                          </button>
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
          @if (x.excludedEmployeeIds.length) {
            <p class="mt-3 text-sm text-muted">
              {{ x.excludedEmployeeIds.length }} colaborador(es) excluído(s) deste lote.
              @if (x.access?.edit) {
                <button
                  type="button"
                  class="link"
                  data-testid="ps-include-all"
                  (click)="includeAll()"
                >
                  Voltar a incluir
                </button>
              }
            </p>
          }
        </section>

        @if (x.kind !== 'RETRO') {
          <section class="card mt-4" aria-labelledby="ps-inputs-title">
            <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 id="ps-inputs-title" class="font-semibold">
                {{ x.kind === 'REGULAR' ? 'Valores variáveis' : 'Pagamentos do lote' }}
              </h2>
              @if (x.access?.edit) {
                <button
                  type="button"
                  class="btn-secondary"
                  data-testid="ps-add-input"
                  (click)="openInput()"
                >
                  Adicionar valor
                </button>
              }
            </div>
            @if (x.inputs?.length) {
              <ul class="divide-y divide-border text-sm">
                @for (i of x.inputs; track i.id) {
                  <li class="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span
                      >{{ i.employee.code }} — {{ i.employee.fullName }} ·
                      {{ i.component.name }}</span
                    >
                    <span class="flex items-center gap-2">
                      <span class="tabular-nums">{{ money(i.amount) }}</span>
                      @if (x.access?.edit) {
                        <button
                          type="button"
                          class="btn-ghost px-2 py-1"
                          [attr.aria-label]="
                            'Remover ' + i.component.name + ' de ' + i.employee.fullName
                          "
                          (click)="removeInput(i.employee.id, i.component.id)"
                        >
                          Remover
                        </button>
                      }
                    </span>
                  </li>
                }
              </ul>
            } @else {
              <p class="text-sm text-muted">
                {{
                  x.kind === 'REGULAR'
                    ? 'Sem valores variáveis (horas extra, prémios pontuais…). Os fixos vêm da ficha de cada colaborador.'
                    : 'Sem pagamentos: o extra só processa o que se lança aqui.'
                }}
              </p>
            }
          </section>
        }

        <div aside>
          <section class="card" aria-labelledby="ps-summary">
            <h2 id="ps-summary" class="mb-3 font-semibold">Resumo</h2>
            <app-field-list
              [fields]="[
                {
                  label: 'Mês',
                  value: month(x.period) + (x.periodStatus === 'CLOSED' ? ' (fechado)' : ''),
                },
                { label: 'Regras', value: x.ruleSet?.code ?? null },
                { label: 'Bruto', value: x.status === 'DRAFT' ? null : money(x.totals.gross) },
                {
                  label: 'INSS (trabalhador)',
                  value: x.status === 'DRAFT' ? null : money(x.totals.inssEmployee),
                },
                { label: 'IRT', value: x.status === 'DRAFT' ? null : money(x.totals.irt) },
                {
                  label: 'Empréstimos',
                  value: x.status === 'DRAFT' ? null : money(x.totals.loans),
                },
                {
                  label: 'INSS (patronal)',
                  value: x.status === 'DRAFT' ? null : money(x.totals.inssEmployer),
                },
                { label: 'Preparado por', value: x.createdBy },
                {
                  label: 'Calculado por',
                  value: x.calculatedBy ? x.calculatedBy + ' · ' + dateTime(x.calculatedAt) : null,
                },
                {
                  label: 'Decidido por',
                  value: x.decidedBy ? x.decidedBy + ' · ' + dateTime(x.decidedAt) : null,
                },
                { label: 'Comentário', value: x.decisionComment },
                {
                  label: 'Fechado por',
                  value: x.closedBy ? x.closedBy + ' · ' + dateTime(x.closedAt) : null,
                },
              ]"
            />
          </section>
          <app-audit-history entityType="payroll_run" [entityId]="x.id" [refreshKey]="x.version" />
        </div>
      </app-page-detail>
    }

    <app-modal title="Recusar lote" [open]="rejecting()" (closed)="rejecting.set(false)">
      <app-error-alert [error]="action.error()" [showDetails]="false" />
      <p class="mb-3 text-sm text-muted">O lote volta a "Calculado" para ser corrigido.</p>
      <app-field label="Motivo" [required]="true" [error]="action.field('comment')">
        <textarea
          appControl
          class="input min-h-20"
          data-testid="ps-reject-reason"
          [(ngModel)]="comment"
          [ngModelOptions]="{ standalone: true }"
        ></textarea>
      </app-field>
      <ng-container actions>
        <button type="button" class="btn-secondary" (click)="rejecting.set(false)">Voltar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="ps-reject-confirm"
          [disabled]="action.busy()"
          (click)="reject()"
        >
          Recusar
        </button>
      </ng-container>
    </app-modal>

    <app-modal title="Adicionar valor" [open]="adding()" (closed)="adding.set(false)">
      <app-error-alert [error]="action.error()" [showDetails]="false" />
      <div class="space-y-3">
        <app-field label="Colaborador" [required]="true" [error]="action.field('employeeId')">
          <select
            appControl
            class="input"
            data-testid="ps-input-employee"
            [(ngModel)]="inputForm.employeeId"
            [ngModelOptions]="{ standalone: true }"
          >
            <option [ngValue]="null">—</option>
            @for (e of employees(); track e.id) {
              <option [ngValue]="e.id">{{ e.label }}</option>
            }
          </select>
        </app-field>
        <app-field label="Componente" [required]="true" [error]="action.field('componentId')">
          <select
            appControl
            class="input"
            data-testid="ps-input-component"
            [(ngModel)]="inputForm.componentId"
            [ngModelOptions]="{ standalone: true }"
          >
            <option [ngValue]="null">—</option>
            @for (c of components(); track c.id) {
              <option [ngValue]="c.id">{{ c.label }}</option>
            }
          </select>
        </app-field>
        <app-field label="Montante" [required]="true" [error]="action.field('amount')">
          <app-money-input
            data-testid="ps-input-amount"
            [(ngModel)]="inputForm.amount"
            [ngModelOptions]="{ standalone: true }"
          />
        </app-field>
        <app-field label="Nota" [error]="action.field('note')">
          <input
            appControl
            class="input"
            [(ngModel)]="inputForm.note"
            [ngModelOptions]="{ standalone: true }"
          />
        </app-field>
      </div>
      <ng-container actions>
        <button type="button" class="btn-secondary" (click)="adding.set(false)">Cancelar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="ps-input-confirm"
          [disabled]="action.busy()"
          (click)="saveInput()"
        >
          Guardar
        </button>
      </ng-container>
    </app-modal>

    <app-modal
      [title]="'Recibo — ' + (detail()?.employee?.fullName ?? '')"
      [open]="!!detail()"
      [side]="true"
      (closed)="detail.set(null)"
    >
      @if (detail(); as d) {
        <div data-testid="ps-payslip">
          @for (e of d.errors; track $index) {
            <p class="mb-2 rounded-card bg-danger-soft p-2 text-sm text-danger-text">
              {{ e.message }}
            </p>
          }
          @if (d.lines.length) {
            <table class="w-full text-sm">
              <caption class="sr-only">
                Linhas do recibo
              </caption>
              <tbody>
                @for (l of d.lines; track $index) {
                  <tr class="border-t border-border" [class.text-muted]="l.kind === 'EMPLOYER'">
                    <td class="py-1 pr-3">
                      {{ l.name }}
                      @if (l.kind === 'EMPLOYER') {
                        <span class="text-xs">(encargo da empresa)</span>
                      }
                    </td>
                    <td class="py-1 text-right whitespace-nowrap tabular-nums">
                      {{ l.kind === 'DEDUCTION' ? '−' : '' }}{{ money(l.amount) }}
                    </td>
                  </tr>
                }
                <tr class="border-t-2 border-border font-semibold">
                  <td class="py-1 pr-3">Líquido</td>
                  <td class="py-1 text-right tabular-nums" data-testid="ps-payslip-net">
                    {{ money(d.totals.net ?? '0') }}
                  </td>
                </tr>
              </tbody>
            </table>
            <app-field-list
              class="mt-4 block"
              [fields]="[
                { label: 'Base de INSS', value: d.bases.inss ? money(d.bases.inss) : null },
                { label: 'Base de IRT', value: d.bases.irt ? money(d.bases.irt) : null },
                {
                  label: 'Custo para a empresa',
                  value: d.totals.employerCost ? money(d.totals.employerCost) : null,
                },
                { label: 'Regras usadas', value: rulesLabel(d) },
              ]"
            />
          }
        </div>
      }
    </app-modal>
  `,
})
export class PayrollRunPage {
  readonly id = input.required<string>();
  private readonly api = inject(Api);
  private readonly toasts = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  protected readonly r = signal<PayrollRun | null>(null);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly action = new Action();
  protected readonly rejecting = signal(false);
  protected readonly adding = signal(false);
  protected readonly detail = signal<ResultDetail | null>(null);
  protected readonly employees = signal<Option[]>([]);
  protected readonly components = signal<Option[]>([]);
  protected comment = '';
  protected inputForm = {
    employeeId: null as string | null,
    componentId: null as string | null,
    amount: null as string | null,
    note: '',
  };
  protected readonly title = runTitle;
  protected readonly month = monthName;
  protected readonly next = nextStep;
  protected readonly tone = runTone;
  protected readonly status = (s: PayrollRun['status']) => RUN_STATUS[s];
  protected readonly money = (v: string) => formatMoney(v);
  protected readonly dateTime = formatDateTime;
  protected readonly busy = computed(() => this.action.busy());

  constructor() {
    effect(() => {
      const id = this.id();
      untracked(() => void this.load(id));
    });
  }

  /** Descontos autorizados + prestações de empréstimos. */
  protected other(p: RunResult) {
    const c = (v: string | null) => {
      const [i, f = ''] = (v ?? '0').replace('-', '').split('.');
      const n = BigInt(i) * 100n + BigInt(f.padEnd(2, '0'));
      return v?.startsWith('-') ? -n : n;
    };
    const t = c(p.deductions) + c(p.loans);
    const s = (t < 0n ? -t : t).toString().padStart(3, '0');
    return `${t < 0n ? '-' : ''}${s.slice(0, -2)}.${s.slice(-2)}`;
  }

  protected rulesLabel(d: ResultDetail) {
    const r = d.snapshot?.rules;
    return r ? `${r.code} (desde ${formatDate(r.validFrom)}; ${r.legalReference})` : null;
  }

  protected reload() {
    void this.load(this.id());
  }

  private async load(id: string) {
    this.loadError.set(null);
    try {
      const x = await this.api.get<PayrollRun>(`hr/payroll/runs/${id}`);
      this.r.set(x);
      this.breadcrumbs.setCurrent(`${x.code} — ${runTitle(x)}`);
    } catch (error) {
      this.loadError.set(ApiError.from(error));
    }
  }

  private async post(path: string, body: Record<string, unknown>, message: string) {
    const x = this.r()!;
    const done = await this.action.run(() =>
      this.api.post<PayrollRun>(`hr/payroll/runs/${x.id}/${path}`, {
        ...body,
        expectedVersion: x.version,
      }),
    );
    if (!done) {
      const e = this.action.error();
      this.toasts.show(e?.details?.[0]?.message ?? e?.message ?? 'Erro.', 'error');
      return false;
    }
    await this.load(x.id);
    this.toasts.show(message);
    return true;
  }

  protected calculate() {
    return this.post('calculate', {}, 'Lote calculado.');
  }

  protected submit() {
    return this.post('submit', {}, 'Lote enviado para aprovação.');
  }

  protected approve() {
    return this.post('decision', { decision: 'APPROVE' }, 'Lote aprovado.');
  }

  protected async reject() {
    const x = this.r()!;
    const done = await this.action.run(() =>
      this.api.post(`hr/payroll/runs/${x.id}/decision`, {
        decision: 'REJECT',
        comment: this.comment.trim() || undefined,
        expectedVersion: x.version,
      }),
    );
    if (!done) return;
    this.rejecting.set(false);
    await this.load(x.id);
    this.toasts.show('Lote recusado: volta a calculado.');
  }

  protected async close() {
    const ok = await this.confirm.ask({
      title: 'Fechar lote',
      message:
        'Depois de fechado o lote não se altera: regista os descontos dos empréstimos e, no regular, fecha o mês.',
      confirmLabel: 'Fechar lote',
    });
    if (ok) await this.post('close', {}, 'Lote fechado.');
  }

  protected async cancel() {
    const ok = await this.confirm.ask({
      title: 'Cancelar lote',
      message: 'Cancelar este processamento?',
      confirmLabel: 'Cancelar lote',
      danger: true,
    });
    if (ok) await this.post('cancel', {}, 'Lote cancelado.');
  }

  protected exclude(employeeId: string, excluded: boolean) {
    return this.post(
      'exclusions',
      { employeeId, excluded },
      excluded ? 'Colaborador excluído: recalcule.' : 'Colaborador incluído: recalcule.',
    );
  }

  protected async includeAll() {
    for (const id of [...this.r()!.excludedEmployeeIds]) {
      const ok = await this.exclude(id, false);
      if (!ok) return;
    }
  }

  protected async openResult(p: RunResult) {
    try {
      this.detail.set(
        await this.api.get<ResultDetail>(`hr/payroll/runs/${this.r()!.id}/results/${p.id}`),
      );
    } catch (error) {
      this.toasts.show(ApiError.from(error).message, 'error');
    }
  }

  protected async openInput() {
    const x = this.r()!;
    this.action.error.set(null);
    this.inputForm = { employeeId: null, componentId: null, amount: null, note: '' };
    try {
      const page = await this.api.page<{ id: string; code: string; fullName: string }>(
        'hr/employees',
        { legalEntityId: x.legalEntity.id, limit: 200 },
      );
      this.employees.set(page.items.map((e) => ({ id: e.id, label: `${e.code} — ${e.fullName}` })));
    } catch {
      this.employees.set([]);
    }
    try {
      const list =
        await this.api.get<
          { id: string; code: string; name: string; calculation: string; status: string }[]
        >('hr/pay-components');
      this.components.set(
        list
          .filter(
            (c) => c.status === 'ACTIVE' && (x.kind !== 'REGULAR' || c.calculation === 'VARIABLE'),
          )
          .map((c) => ({ id: c.id, label: `${c.code} — ${c.name}` })),
      );
    } catch {
      this.components.set([]);
    }
    this.adding.set(true);
  }

  protected async saveInput() {
    const x = this.r()!;
    const done = await this.action.run(() =>
      this.api.put(`hr/payroll/runs/${x.id}/inputs`, {
        employeeId: this.inputForm.employeeId,
        componentId: this.inputForm.componentId,
        amount: this.inputForm.amount,
        note: this.inputForm.note.trim() || undefined,
        expectedVersion: x.version,
      }),
    );
    if (!done) return;
    this.adding.set(false);
    await this.load(x.id);
    this.toasts.show('Valor guardado: recalcule o lote.');
  }

  protected async removeInput(employeeId: string, componentId: string) {
    const x = this.r()!;
    const done = await this.action.run(() =>
      this.api.put(`hr/payroll/runs/${x.id}/inputs`, {
        employeeId,
        componentId,
        amount: null,
        expectedVersion: x.version,
      }),
    );
    if (!done) {
      this.toasts.show(this.action.error()?.message ?? 'Erro.', 'error');
      return;
    }
    await this.load(x.id);
    this.toasts.show('Valor removido: recalcule o lote.');
  }

  protected readonly pct = pct;
}
