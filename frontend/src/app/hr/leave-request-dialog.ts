import { Component, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api } from '../core/api';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField } from '../ui/form-field';
import { Action } from '../ui/load';
import { Modal } from '../ui/modal';
import { ToastService } from '../ui/toasts';
import {
  type Balance,
  daysLabel,
  fitsBalance,
  type LeaveRequest,
  type LeaveType,
} from './leave-model';

interface Option {
  id: string;
  label: string;
}

/**
 * Pedido de ausência: o servidor conta os dias (calendário da política) e verifica saldo, sobreposições e o ano; o
 * formulário mostra a contagem e o saldo antes de enviar. Sem colaborador fixo, quem gere escolhe; quem pede para si
 * usa a sua ficha.
 */
@Component({
  selector: 'app-leave-request-dialog',
  imports: [FormsModule, FormField, FieldControl, Modal, ErrorAlert],
  template: `
    <app-modal title="Pedido de ausência" [open]="open()" (closed)="closed.emit()">
      <app-error-alert [error]="action.error()" [showDetails]="false" />
      <div class="space-y-3">
        @if (!employeeId()) {
          <app-field label="Colaborador" [required]="true" [error]="action.field('employeeId')">
            <select
              appControl
              class="input"
              data-testid="lr-employee"
              [(ngModel)]="form.employeeId"
              [ngModelOptions]="{ standalone: true }"
              (ngModelChange)="refresh()"
            >
              <option [ngValue]="null">—</option>
              @for (e of employees(); track e.id) {
                <option [ngValue]="e.id">{{ e.label }}</option>
              }
            </select>
          </app-field>
        }
        <app-field label="Tipo" [required]="true" [error]="action.field('leaveTypeId')">
          <select
            appControl
            class="input"
            data-testid="lr-type"
            [(ngModel)]="form.leaveTypeId"
            [ngModelOptions]="{ standalone: true }"
            (ngModelChange)="refresh()"
          >
            <option [ngValue]="null">—</option>
            @for (t of types(); track t.id) {
              <option [ngValue]="t.id">{{ t.name }}</option>
            }
          </select>
        </app-field>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <app-field label="Início" [required]="true" [error]="action.field('startDate')">
            <input
              appControl
              class="input"
              type="date"
              data-testid="lr-start"
              [(ngModel)]="form.startDate"
              [ngModelOptions]="{ standalone: true }"
              (ngModelChange)="refresh()"
            />
          </app-field>
          <app-field label="Fim" [required]="true" [error]="action.field('endDate')">
            <input
              appControl
              class="input"
              type="date"
              data-testid="lr-end"
              [(ngModel)]="form.endDate"
              [ngModelOptions]="{ standalone: true }"
              (ngModelChange)="refresh()"
            />
          </app-field>
        </div>
        @if (preview(); as p) {
          <p class="rounded-card bg-surface-2 p-3 text-sm" role="status" data-testid="lr-preview">
            {{ days(p.days) }} dia(s)
            @if (p.deductsBalance) {
              · disponível {{ days(p.balance.available) }} em {{ p.balance.year }}
              @if (!fits(p.days, p.balance.available)) {
                <span class="text-danger-text"> — saldo insuficiente</span>
              }
            } @else {
              · não desconta férias
            }
          </p>
        } @else if (previewError()) {
          <p class="text-sm text-danger-text" role="status">{{ previewError() }}</p>
        }
        @if (selectedType()?.requiresDocument) {
          <p class="text-sm text-muted">
            Este tipo exige justificativo: anexe-o no pedido depois de o enviar.
          </p>
        }
        <app-field
          label="Motivo / observações"
          [error]="action.field('reason')"
          [hint]="
            selectedType()?.confidential
              ? 'Confidencial: só visível para si e para quem trata dados pessoais.'
              : null
          "
        >
          <textarea
            appControl
            class="input min-h-20"
            data-testid="lr-reason"
            [(ngModel)]="form.reason"
            [ngModelOptions]="{ standalone: true }"
          ></textarea>
        </app-field>
      </div>
      <ng-container actions>
        <button type="button" class="btn-secondary" (click)="closed.emit()">Cancelar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="lr-confirm"
          [disabled]="action.busy()"
          (click)="save()"
        >
          Enviar pedido
        </button>
      </ng-container>
    </app-modal>
  `,
})
export class LeaveRequestDialog {
  readonly open = input(false);
  /** Colaborador fixo (ficha ou self-service); sem ele, escolhe-se da lista (quem gere). */
  readonly employeeId = input<string | null>(null);
  readonly closed = output<void>();
  readonly created = output<LeaveRequest>();
  private readonly api = inject(Api);
  private readonly toasts = inject(ToastService);
  protected readonly action = new Action();
  protected readonly types = signal<LeaveType[]>([]);
  protected readonly employees = signal<Option[]>([]);
  protected readonly preview = signal<{
    days: string;
    deductsBalance: boolean;
    balance: Balance;
  } | null>(null);
  protected readonly previewError = signal<string | null>(null);
  protected readonly selectedType = signal<LeaveType | null>(null);
  protected readonly days = daysLabel;
  protected readonly fits = fitsBalance;
  protected form = this.empty();
  private seq = 0;

  private empty() {
    return {
      employeeId: null as string | null,
      leaveTypeId: null as string | null,
      startDate: '',
      endDate: '',
      reason: '',
    };
  }

  /** Chamado por quem abre o diálogo (carrega tipos e, se preciso, colaboradores). */
  async prepare() {
    this.form = this.empty();
    this.preview.set(null);
    this.previewError.set(null);
    this.action.error.set(null);
    try {
      this.types.set(
        (await this.api.get<LeaveType[]>('hr/leave/types')).filter((t) => t.status === 'ACTIVE'),
      );
    } catch {
      this.types.set([]);
    }
    if (!this.employeeId()) {
      try {
        const page = await this.api.page<{ id: string; code: string; fullName: string }>(
          'hr/employees',
          {
            status: 'ACTIVE',
            limit: 200,
          },
        );
        this.employees.set(
          page.items.map((e) => ({ id: e.id, label: `${e.code} — ${e.fullName}` })),
        );
      } catch {
        this.employees.set([]);
      }
    }
  }

  protected async refresh() {
    this.selectedType.set(this.types().find((t) => t.id === this.form.leaveTypeId) ?? null);
    const body = this.body();
    this.preview.set(null);
    this.previewError.set(null);
    if (!body.employeeId || !body.leaveTypeId || !body.startDate || !body.endDate) return;
    const seq = ++this.seq;
    try {
      const p = await this.api.post<{ days: string; deductsBalance: boolean; balance: Balance }>(
        'hr/leave/requests/preview',
        body,
      );
      if (seq === this.seq) this.preview.set(p);
    } catch (error) {
      if (seq !== this.seq) return;
      const e = error as { details?: { message: string }[]; message?: string };
      this.previewError.set(e.details?.[0]?.message ?? e.message ?? 'Período inválido.');
    }
  }

  private body() {
    return {
      employeeId: this.employeeId() ?? this.form.employeeId,
      leaveTypeId: this.form.leaveTypeId,
      startDate: this.form.startDate,
      endDate: this.form.endDate,
      reason: this.form.reason || null,
    };
  }

  protected async save() {
    const result = await this.action.run(() =>
      this.api.post<LeaveRequest>('hr/leave/requests', this.body()),
    );
    if (!result) return;
    this.toasts.show('Pedido de ausência enviado.');
    this.created.emit(result);
  }
}
