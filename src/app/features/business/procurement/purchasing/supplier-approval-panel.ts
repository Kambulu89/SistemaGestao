import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { finalize, type Observable } from 'rxjs';
import { PermissionService } from '../../../../core/permissions/permission.service';
import { Alert } from '../../../../shared/ui/alert/alert';
import { Badge } from '../../../../shared/ui/badge/badge';
import { Button } from '../../../../shared/ui/button/button';
import { Input } from '../../../../shared/ui/input/input';
import { Textarea } from '../../../../shared/ui/textarea/textarea';
import {
  PurchasingApi,
  type ApprovalDecision,
  type SupplierApprovalEventDto,
  type SupplierDto,
} from './purchasing.api';
import { APPROVAL_STATUS, approvalActions, isIsoDate, purchasingError } from './purchasing-model';

const ACTION_LABEL: Readonly<Record<SupplierApprovalEventDto['action'], string>> = {
  SUBMIT: 'Análise pedida',
  APPROVE: 'Homologado',
  APPROVE_CONDITIONALLY: 'Homologado com condições',
  REJECT: 'Rejeitado',
  SUSPEND: 'Suspenso',
};

/**
 * Homologação de um fornecedor: pedir a análise (`supplier.manage`) e decidir (`supplier.approve`). Os botões seguem o
 * estado, mas é o servidor que decide — incluindo a segregação de funções (quem pediu não aprova) e a validade.
 */
@Component({
  selector: 'app-supplier-approval-panel',
  imports: [FormsModule, Alert, Badge, Button, Input, Textarea],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="mt-5 border-t border-line pt-4" data-testid="supplier-approval">
      <div class="flex flex-wrap items-center gap-2">
        <h3 class="text-sm font-semibold">Homologação</h3>
        <app-badge [tone]="state().tone">{{ state().label }}</app-badge>
        @if (supplier().approvalValidUntil; as until) {
          <span class="text-sm text-fg-muted">válida até {{ until }}</span>
        }
      </div>
      @if (supplier().approvalConditions; as conditions) {
        <p class="mt-2 text-sm" data-testid="approval-conditions">Condições: {{ conditions }}</p>
      }
      @if (supplier().critical && !inForce()) {
        <p class="mt-2 text-sm text-fg-muted">
          Fornecedor crítico: só recebe novas encomendas depois de homologado.
        </p>
      }

      @if (error(); as text) {
        <app-alert tone="danger" class="mt-3 block">{{ text }}</app-alert>
      }

      @if (canSubmit() || canDecide() || canSuspend()) {
        <div class="mt-3 grid gap-3 sm:grid-cols-2">
          <app-input
            label="Motivo (homologação)"
            [ngModel]="reason()"
            (ngModelChange)="reason.set($event ?? '')"
          />
          @if (canDecide()) {
            <app-input
              label="Válida até (opcional)"
              type="date"
              [ngModel]="validUntil()"
              (ngModelChange)="validUntil.set($event ?? '')"
            />
            <div class="sm:col-span-2">
              <app-textarea
                label="Condições (para homologar com condições)"
                [rows]="2"
                [ngModel]="conditions()"
                (ngModelChange)="conditions.set($event ?? '')"
              />
            </div>
          }
        </div>
        <div class="mt-3 flex flex-wrap gap-2">
          @if (canSubmit()) {
            <app-button variant="secondary" [loading]="busy()" (click)="submit()">{{
              supplier().approvalStatus === 'PENDING' ? 'Pedir análise' : 'Pedir nova análise'
            }}</app-button>
          }
          @if (canDecide()) {
            <app-button [loading]="busy()" (click)="decide('APPROVE')">Homologar</app-button>
            <app-button
              variant="secondary"
              [loading]="busy()"
              (click)="decide('APPROVE_CONDITIONALLY')"
              >Homologar com condições</app-button
            >
            <app-button variant="danger" [loading]="busy()" (click)="decide('REJECT')"
              >Rejeitar</app-button
            >
          }
          @if (canSuspend()) {
            <app-button variant="danger" [loading]="busy()" (click)="decide('SUSPEND')"
              >Suspender</app-button
            >
          }
        </div>
      }

      <h4 class="mt-5 text-sm font-semibold">Histórico</h4>
      @if (history.value(); as events) {
        @if (events.length === 0) {
          <p class="mt-1 text-sm text-fg-muted">Sem movimentos de homologação.</p>
        } @else {
          <ol class="mt-2 space-y-1 text-sm" data-testid="approval-history">
            @for (event of events; track event.id) {
              <li>
                <span class="text-fg-muted">{{
                  event.occurredAt.slice(0, 16).replace('T', ' ')
                }}</span>
                — {{ label(event) }}
                @if (event.reason) {
                  <span class="text-fg-muted">({{ event.reason }})</span>
                }
                @if (event.validUntil) {
                  <span class="text-fg-muted">· válida até {{ event.validUntil }}</span>
                }
              </li>
            }
          </ol>
        }
      } @else if (history.error()) {
        <p class="mt-1 text-sm text-red-600">Não foi possível carregar o histórico.</p>
      }
    </section>
  `,
})
export class SupplierApprovalPanel {
  private readonly api = inject(PurchasingApi);
  private readonly permissions = inject(PermissionService);

  readonly supplier = input.required<SupplierDto>();
  readonly changed = output<SupplierDto>();

  protected readonly reason = signal('');
  protected readonly conditions = signal('');
  protected readonly validUntil = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly state = computed(() => APPROVAL_STATUS[this.supplier().approvalStatus]);
  protected readonly inForce = computed(() =>
    ['APPROVED', 'CONDITIONALLY_APPROVED'].includes(this.supplier().approvalStatus),
  );
  private readonly actions = computed(() => approvalActions(this.supplier().approvalStatus));
  protected readonly canSubmit = computed(
    () => this.actions().submit && this.permissions.can('supplier.manage'),
  );
  protected readonly canDecide = computed(
    () => this.actions().decide && this.permissions.can('supplier.approve'),
  );
  protected readonly canSuspend = computed(
    () => this.actions().suspend && this.permissions.can('supplier.approve'),
  );

  protected readonly history = rxResource({
    params: () => ({ id: this.supplier().id, version: this.supplier().version }),
    stream: ({ params }) => this.api.supplierApprovalEvents(params.id),
  });

  protected label(event: SupplierApprovalEventDto): string {
    return ACTION_LABEL[event.action];
  }

  private run(call: Observable<SupplierDto>): void {
    this.busy.set(true);
    call.pipe(finalize(() => this.busy.set(false))).subscribe({
      next: (saved) => {
        this.reason.set('');
        this.conditions.set('');
        this.validUntil.set('');
        this.changed.emit(saved);
      },
      error: (error: unknown) =>
        this.error.set(purchasingError(error, 'Não foi possível alterar a homologação.')),
    });
  }

  protected submit(): void {
    this.error.set(null);
    const s = this.supplier();
    this.run(this.api.submitSupplierApproval(s.id, s.version, this.reason().trim() || null));
  }

  protected decide(action: ApprovalDecision): void {
    this.error.set(null);
    const reason = this.reason().trim();
    const conditions = this.conditions().trim();
    const validUntil = this.validUntil().trim();
    if ((action === 'REJECT' || action === 'SUSPEND') && !reason) {
      return void this.error.set('Indique o motivo.');
    }
    if (action === 'APPROVE_CONDITIONALLY' && !conditions) {
      return void this.error.set('Indique as condições da homologação.');
    }
    const approving = action === 'APPROVE' || action === 'APPROVE_CONDITIONALLY';
    if (approving && validUntil && !isIsoDate(validUntil)) {
      return void this.error.set('A validade é uma data (AAAA-MM-DD).');
    }
    const s = this.supplier();
    this.run(
      this.api.decideSupplierApproval(s.id, s.version, {
        action,
        reason: reason || null,
        ...(action === 'APPROVE_CONDITIONALLY' ? { conditions } : {}),
        ...(approving && validUntil ? { validUntil } : {}),
      }),
    );
  }
}
