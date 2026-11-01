import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { finalize } from 'rxjs';
import type { ApiError } from '../../../core/api/api-error.model';
import { errorMessage } from '../../../core/api/error-message';
import {
  PLAN_STATUS_LABELS,
  formatLimit,
  formatPrice,
} from '../../../core/subscription/subscription-labels';
import { Alert } from '../../../shared/ui/alert/alert';
import { Badge } from '../../../shared/ui/badge/badge';
import { Button } from '../../../shared/ui/button/button';
import { Card } from '../../../shared/ui/card/card';
import { Checkbox } from '../../../shared/ui/checkbox/checkbox';
import { Dialog } from '../../../shared/ui/dialog/dialog';
import { EmptyState } from '../../../shared/ui/empty-state/empty-state';
import { Input } from '../../../shared/ui/input/input';
import { LoadingState } from '../../../shared/ui/loading-state/loading-state';
import { PageHeader } from '../../../shared/ui/page-header/page-header';
import { Select } from '../../../shared/ui/select/select';
import { Table, type TableColumn } from '../../../shared/ui/table/table';
import { PlatformApi, type PlanStatus, type PlanVersionDto } from '../data-access/platform.api';

const splitCodes = (text: string): string[] =>
  text
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);

/** Versões de planos (C02). Uma versão publicada é imutável: para mudar preços ou limites cria-se outra revisão. */
@Component({
  selector: 'app-plans',
  imports: [
    ReactiveFormsModule,
    Alert,
    Badge,
    Button,
    Card,
    Checkbox,
    Dialog,
    EmptyState,
    Input,
    LoadingState,
    PageHeader,
    Select,
    Table,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <app-page-header
      title="Planos"
      description="Versões de cada plano: preço, limites e direitos. Uma versão publicada nunca muda; as assinaturas mantêm os termos que contrataram."
    />

    @if (notice(); as text) {
      <app-alert tone="success" class="mb-4 block">{{ text }}</app-alert>
    }
    @if (actionError(); as text) {
      <app-alert tone="danger" title="Não foi possível concluir a operação" class="mb-4 block">
        {{ text }}
      </app-alert>
    }

    <div class="mb-3 flex items-center justify-between">
      <h2 class="text-base font-semibold">Versões</h2>
      <app-button (click)="openCreate()">Nova revisão</app-button>
    </div>

    <app-card [flush]="true">
      @if (plans.isLoading() && !plans.hasValue()) {
        <app-loading-state label="A carregar planos…" />
      } @else if (plans.error()) {
        <div class="p-5">
          <app-alert tone="danger" title="Não foi possível carregar os planos">{{
            loadError()
          }}</app-alert>
        </div>
      } @else if (plans.value(); as list) {
        @if (list.length === 0) {
          <app-empty-state icon="card" title="Ainda não há planos" />
        } @else {
          <app-table caption="Versões de planos" [columns]="columns" [rows]="list">
            <ng-template let-row let-column="column">
              @switch (column.key) {
                @case ('plan') {
                  <span class="font-medium">{{ row.name }}</span>
                  <code class="ms-2 text-xs text-fg-muted"
                    >{{ row.planCode }} · r{{ row.revision }}</code
                  >
                }
                @case ('price') {
                  {{ price(row) }}
                }
                @case ('members') {
                  {{ limit(row.limits.members) }}
                }
                @case ('entitlements') {
                  {{ row.entitlements.modules.length }} módulos ·
                  {{ row.entitlements.features.length }} funcionalidades
                }
                @case ('status') {
                  <app-badge [tone]="status(row.status).tone">{{
                    status(row.status).label
                  }}</app-badge>
                }
                @case ('actions') {
                  <span class="flex justify-end gap-1">
                    @if (row.status === 'DRAFT') {
                      <app-button size="sm" variant="secondary" (click)="publish(row)"
                        >Publicar</app-button
                      >
                    } @else if (row.status === 'PUBLISHED') {
                      <app-button size="sm" variant="danger" (click)="retire(row)"
                        >Retirar</app-button
                      >
                    }
                  </span>
                }
              }
            </ng-template>
          </app-table>
        }
      }
    </app-card>

    <app-dialog [open]="creating()" title="Nova revisão de plano" (closed)="creating.set(false)">
      <form [formGroup]="form" (ngSubmit)="create()" novalidate class="space-y-3">
        <app-input
          label="Código do plano"
          formControlName="planCode"
          [required]="true"
          hint="Um código existente cria a revisão seguinte desse plano."
        />
        <app-input label="Nome" formControlName="name" [required]="true" />
        <div class="grid grid-cols-2 gap-3">
          <app-input
            label="Preço"
            formControlName="price"
            [required]="true"
            hint="Decimal, ex.: 49.90"
          />
          <app-input label="Moeda" formControlName="currency" [required]="true" />
        </div>
        <app-select
          label="Periodicidade"
          formControlName="billingInterval"
          [required]="true"
          [options]="intervals"
        />
        <app-checkbox label="Membros ilimitados" formControlName="unlimitedMembers" />
        @if (!form.controls.unlimitedMembers.value) {
          <app-input
            label="Limite de membros"
            type="number"
            formControlName="members"
            [required]="true"
            min="0"
          />
        }
        <app-input
          label="Módulos licenciados"
          formControlName="modules"
          hint="Códigos separados por vírgulas (do registo de módulos)."
        />
        <app-input
          label="Funcionalidades licenciadas"
          formControlName="features"
          hint="Além das que vêm por omissão com cada módulo."
        />
        <p class="text-xs text-fg-muted">
          A revisão fica em rascunho até ser publicada; depois de publicada não se altera.
        </p>
        <div class="flex justify-end gap-2 pt-2">
          <app-button variant="secondary" (click)="creating.set(false)">Cancelar</app-button>
          <app-button type="submit" [loading]="busy()">Criar rascunho</app-button>
        </div>
      </form>
    </app-dialog>
  `,
})
export class Plans {
  private readonly api = inject(PlatformApi);

  protected readonly columns: readonly TableColumn[] = [
    { key: 'plan', label: 'Plano' },
    { key: 'price', label: 'Preço' },
    { key: 'members', label: 'Membros' },
    { key: 'entitlements', label: 'Direitos' },
    { key: 'status', label: 'Estado' },
    { key: 'actions', label: 'Acções', align: 'end' },
  ];
  protected readonly intervals = [
    { value: 'MONTH', label: 'Mensal' },
    { value: 'YEAR', label: 'Anual' },
  ];

  protected readonly plans = rxResource({ stream: () => this.api.listPlans() });
  protected readonly loadError = computed(() => errorMessage(this.plans.error()));

  protected readonly creating = signal(false);
  protected readonly busy = signal(false);
  protected readonly notice = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);

  protected readonly form = inject(NonNullableFormBuilder).group({
    planCode: ['', [Validators.required, Validators.pattern(/^[a-z][a-z0-9_]{1,59}$/)]],
    name: ['', [Validators.required, Validators.maxLength(160)]],
    price: ['', [Validators.required, Validators.pattern(/^\d{1,15}(\.\d{1,4})?$/)]],
    currency: ['AOA', [Validators.required, Validators.pattern(/^[A-Za-z]{3}$/)]],
    billingInterval: ['MONTH', Validators.required],
    unlimitedMembers: [false],
    members: [5 as number | null],
    modules: [''],
    features: [''],
  });

  protected price(plan: PlanVersionDto): string {
    return formatPrice(plan.price, plan.currency, plan.billingInterval);
  }
  protected limit = formatLimit;
  protected status(status: PlanStatus) {
    return PLAN_STATUS_LABELS[status];
  }

  protected openCreate(): void {
    this.clearMessages();
    this.form.reset();
    this.creating.set(true);
  }

  protected create(): void {
    // Um campo escondido (limite com «ilimitado») não pode deixar erros de uma tentativa anterior.
    this.form.controls.members.updateValueAndValidity();
    const v = this.form.getRawValue();
    const membersMissing = !v.unlimitedMembers && (v.members === null || v.members < 0);
    if (this.form.invalid || membersMissing) {
      this.form.markAllAsTouched();
      if (membersMissing) this.form.controls.members.setErrors({ required: true });
      return;
    }
    this.busy.set(true);
    this.api
      .createPlan({
        planCode: v.planCode.trim(),
        name: v.name.trim(),
        currency: v.currency.trim().toUpperCase(),
        price: v.price.trim(),
        billingInterval: v.billingInterval as 'MONTH' | 'YEAR',
        limits: { members: v.unlimitedMembers ? null : v.members },
        entitlements: { modules: splitCodes(v.modules), features: splitCodes(v.features) },
      })
      .pipe(finalize(() => this.busy.set(false)))
      .subscribe({
        next: (plan) => {
          this.creating.set(false);
          this.notice.set(`Revisão ${plan.revision} de ${plan.planCode} criada em rascunho.`);
          this.plans.reload();
        },
        error: (error: ApiError) => {
          const head = (path: string) => path.split('.')[0] ?? path;
          const field = error.fieldErrors?.find((d) => head(d.path) in this.form.controls);
          if (field) {
            const control = this.form.controls[head(field.path) as keyof typeof this.form.controls];
            control.setErrors({ server: { message: field.message } });
            control.markAsTouched();
            return;
          }
          this.creating.set(false);
          this.actionError.set(error.message);
        },
      });
  }

  protected publish(plan: PlanVersionDto): void {
    this.transition(
      this.api.publishPlan(plan.planCode, plan.revision),
      `${plan.planCode} r${plan.revision} publicada.`,
    );
  }

  protected retire(plan: PlanVersionDto): void {
    this.transition(
      this.api.retirePlan(plan.planCode, plan.revision),
      `${plan.planCode} r${plan.revision} retirada: deixa de poder ser contratada.`,
    );
  }

  private transition(call: ReturnType<PlatformApi['publishPlan']>, message: string): void {
    this.clearMessages();
    call.subscribe({
      next: () => {
        this.notice.set(message);
        this.plans.reload();
      },
      error: (error: ApiError) => {
        this.plans.reload();
        this.actionError.set(error.message);
      },
    });
  }

  private clearMessages(): void {
    this.notice.set(null);
    this.actionError.set(null);
  }
}
