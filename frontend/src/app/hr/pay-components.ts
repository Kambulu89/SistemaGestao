import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api, ApiError } from '../core/api';
import { formatDate } from '../ui/dates';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField } from '../ui/form-field';
import { Icon } from '../ui/icon';
import { Action } from '../ui/load';
import { Modal } from '../ui/modal';
import { formatMoney } from '../ui/money-input';
import { ErrorState, Skeleton } from '../ui/states';
import { SettingsPage } from '../ui/templates';
import { ToastService } from '../ui/toasts';
import {
  incidenceLabel,
  PAY_CALCULATION,
  PAY_CATEGORY,
  type PayComponent,
} from './compensation-model';

/**
 * Componentes de remuneração: catálogo da empresa e incidência de IRT/INSS por vigência, sempre com a fonte. Nenhuma
 * taxa ou limite legal vem pré-definido; cada nova incidência começa depois da anterior e não a altera.
 */
@Component({
  selector: 'app-pay-components',
  imports: [
    FormsModule,
    SettingsPage,
    FormField,
    FieldControl,
    Modal,
    ErrorAlert,
    ErrorState,
    Skeleton,
    Icon,
  ],
  template: `
    <app-settings-page
      title="Componentes de remuneração"
      subtitle="Subsídios, prémios, horas extra, abonos e descontos. O salário base está no contrato de cada colaborador."
      [sections]="[{ id: 'pc-list', label: 'Componentes' }]"
    >
      @if (loadError()) {
        <app-error-state [error]="loadError()" (retry)="load()" />
      } @else if (!items()) {
        <div class="card"><app-skeleton /></div>
      } @else {
        <section id="pc-list" tabindex="-1" class="card" aria-labelledby="pc-title">
          <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 id="pc-title" class="font-semibold">Componentes</h2>
            <button
              type="button"
              class="btn-secondary"
              data-testid="new-component"
              (click)="openComponent(null)"
            >
              <app-icon name="plus" [size]="16" />Novo componente
            </button>
          </div>
          <ul class="divide-y divide-border text-sm">
            @for (c of items()!; track c.id) {
              <li
                class="flex flex-wrap items-start justify-between gap-2 py-3"
                data-testid="pay-component"
              >
                <div class="min-w-0">
                  <p class="font-medium">{{ c.code }} — {{ c.name }}</p>
                  <p class="text-muted">
                    {{ category(c.category) }} · {{ calc(c.calculation) }} ·
                    {{ c.recurring ? 'mensal' : 'pontual' }} ·
                    <span [class.text-warning-text]="!c.currentIncidence">{{ incidence(c) }}</span>
                  </p>
                </div>
                <div class="flex flex-wrap items-center gap-2">
                  <span
                    class="badge"
                    [class]="
                      c.status === 'ACTIVE'
                        ? 'bg-success-soft text-success-text'
                        : 'bg-surface-2 text-muted'
                    "
                  >
                    {{ c.status === 'ACTIVE' ? 'Activo' : 'Inactivo' }}
                  </span>
                  <button type="button" class="btn-ghost" (click)="openComponent(c)">
                    Alterar
                  </button>
                  @if (c.kind === 'EARNING') {
                    <button
                      type="button"
                      class="btn-ghost"
                      data-testid="incidences"
                      (click)="openIncidences(c)"
                    >
                      Incidência
                    </button>
                  }
                </div>
              </li>
            } @empty {
              <li class="py-3 text-muted">Sem componentes.</li>
            }
          </ul>
        </section>
      }
    </app-settings-page>

    <app-modal
      [title]="editing() ? 'Alterar componente' : 'Novo componente'"
      [open]="componentOpen()"
      (closed)="componentOpen.set(false)"
    >
      <app-error-alert [error]="action.error()" [showDetails]="false" />
      <div class="space-y-3">
        <app-field label="Código" [required]="true" [error]="action.field('code')">
          <input
            appControl
            class="input"
            data-testid="pc-code"
            [(ngModel)]="cf.code"
            [ngModelOptions]="{ standalone: true }"
          />
        </app-field>
        <app-field label="Nome" [required]="true" [error]="action.field('name')">
          <input
            appControl
            class="input"
            data-testid="pc-name"
            [(ngModel)]="cf.name"
            [ngModelOptions]="{ standalone: true }"
          />
        </app-field>
        <app-field
          label="Categoria"
          [required]="true"
          [error]="action.field('category') ?? action.field('kind')"
        >
          <select
            appControl
            class="input"
            data-testid="pc-category"
            [(ngModel)]="cf.category"
            [ngModelOptions]="{ standalone: true }"
          >
            @for (c of categories; track c[0]) {
              <option [value]="c[0]">{{ c[1] }}</option>
            }
          </select>
        </app-field>
        <app-field label="Cálculo" [required]="true" [error]="action.field('calculation')">
          <select
            appControl
            class="input"
            data-testid="pc-calculation"
            [(ngModel)]="cf.calculation"
            [ngModelOptions]="{ standalone: true }"
          >
            @for (c of calculations; track c[0]) {
              <option [value]="c[0]">{{ c[1] }}</option>
            }
          </select>
        </app-field>
        <label class="flex items-center gap-2 text-sm"
          ><input
            type="checkbox"
            [(ngModel)]="cf.recurring"
            [ngModelOptions]="{ standalone: true }"
          />
          Mensal (recorrente)</label
        >
        @if (editing()) {
          <label class="flex items-center gap-2 text-sm"
            ><input
              type="checkbox"
              [(ngModel)]="cf.active"
              [ngModelOptions]="{ standalone: true }"
            />
            Activo</label
          >
        }
      </div>
      <ng-container actions>
        <button type="button" class="btn-secondary" (click)="componentOpen.set(false)">
          Cancelar
        </button>
        <button
          type="button"
          class="btn-primary"
          data-testid="pc-confirm"
          [disabled]="action.busy()"
          (click)="saveComponent()"
        >
          Guardar
        </button>
      </ng-container>
    </app-modal>

    <app-modal
      [title]="'Incidência de IRT e INSS — ' + (incOf()?.name ?? '')"
      [open]="incOf() !== null"
      (closed)="incOf.set(null)"
    >
      <app-error-alert [error]="action.error()" [showDetails]="false" />
      @if (incOf()?.incidences?.length) {
        <ul class="mb-4 space-y-1 text-sm">
          @for (i of incOf()!.incidences!; track i.validFrom) {
            <li>
              <span class="font-medium">Desde {{ date(i.validFrom) }}:</span> {{ incidenceText(i) }}
              <span class="block text-xs text-muted">Fonte: {{ i.legalReference }}</span>
            </li>
          }
        </ul>
      } @else {
        <p class="mb-4 text-sm text-warning-text">
          Sem incidência definida: o processamento não poderá tributar este componente.
        </p>
      }
      <h3 class="mb-2 text-sm font-semibold">Nova versão</h3>
      <div class="space-y-3">
        <app-field label="Em vigor desde" [required]="true" [error]="action.field('validFrom')">
          <input
            appControl
            class="input"
            type="date"
            data-testid="inc-from"
            [(ngModel)]="inc.validFrom"
            [ngModelOptions]="{ standalone: true }"
          />
        </app-field>
        <label class="flex items-center gap-2 text-sm"
          ><input
            type="checkbox"
            data-testid="inc-irt"
            [(ngModel)]="inc.irtSubject"
            [ngModelOptions]="{ standalone: true }"
          />
          Sujeito a IRT</label
        >
        @if (inc.irtSubject) {
          <app-field
            label="Parte isenta de IRT (por mês)"
            [error]="action.field('irtExemptAmount')"
          >
            <input
              appControl
              class="input"
              inputmode="decimal"
              data-testid="inc-exempt"
              [(ngModel)]="inc.irtExemptAmount"
              [ngModelOptions]="{ standalone: true }"
            />
          </app-field>
        }
        <label class="flex items-center gap-2 text-sm"
          ><input
            type="checkbox"
            data-testid="inc-inss"
            [(ngModel)]="inc.inssSubject"
            [ngModelOptions]="{ standalone: true }"
          />
          Sujeito a INSS</label
        >
        <app-field
          label="Fonte legal"
          [required]="true"
          hint="Ex.: artigo do Código do IRT ou regulamento da segurança social, confirmado pela empresa."
          [error]="action.field('legalReference')"
        >
          <textarea
            appControl
            class="input min-h-20"
            data-testid="inc-reference"
            [(ngModel)]="inc.legalReference"
            [ngModelOptions]="{ standalone: true }"
          ></textarea>
        </app-field>
      </div>
      <ng-container actions>
        <button type="button" class="btn-secondary" (click)="incOf.set(null)">Fechar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="inc-confirm"
          [disabled]="action.busy()"
          (click)="saveIncidence()"
        >
          Registar versão
        </button>
      </ng-container>
    </app-modal>
  `,
})
export class PayComponents {
  private readonly api = inject(Api);
  private readonly toasts = inject(ToastService);
  protected readonly items = signal<PayComponent[] | null>(null);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly action = new Action();
  protected readonly componentOpen = signal(false);
  protected readonly editing = signal<PayComponent | null>(null);
  protected readonly incOf = signal<PayComponent | null>(null);
  protected readonly categories = Object.entries(PAY_CATEGORY);
  protected readonly calculations = Object.entries(PAY_CALCULATION);
  protected readonly category = (c: string) => PAY_CATEGORY[c] ?? c;
  protected readonly calc = (c: keyof typeof PAY_CALCULATION) => PAY_CALCULATION[c];
  protected readonly date = formatDate;
  protected readonly incidenceText = (i: Parameters<typeof incidenceLabel>[0]) =>
    incidenceLabel(i, (v) => formatMoney(v));
  protected cf = this.emptyComponent();
  protected inc = this.emptyIncidence();

  constructor() {
    void this.load();
  }

  protected incidence(c: PayComponent) {
    if (c.kind === 'DEDUCTION') return 'desconto';
    return c.currentIncidence
      ? incidenceLabel({ validFrom: '', ...c.currentIncidence }, (v) => formatMoney(v))
      : 'incidência por definir';
  }

  private emptyComponent() {
    return {
      code: '',
      name: '',
      category: 'ALLOWANCE',
      calculation: 'FIXED',
      recurring: true,
      active: true,
    };
  }

  private emptyIncidence() {
    return {
      validFrom: '',
      irtSubject: true,
      irtExemptAmount: '',
      inssSubject: true,
      legalReference: '',
    };
  }

  protected async load() {
    this.loadError.set(null);
    try {
      this.items.set(await this.api.get<PayComponent[]>('hr/pay-components'));
    } catch (error) {
      this.loadError.set(ApiError.from(error));
    }
  }

  protected openComponent(c: PayComponent | null) {
    this.action.error.set(null);
    this.editing.set(c);
    this.cf = c
      ? {
          code: c.code,
          name: c.name,
          category: c.category,
          calculation: c.calculation,
          recurring: c.recurring,
          active: c.status === 'ACTIVE',
        }
      : this.emptyComponent();
    this.componentOpen.set(true);
  }

  protected async saveComponent() {
    const c = this.editing();
    const f = this.cf;
    const body = {
      code: f.code,
      name: f.name,
      category: f.category,
      kind: f.category === 'DEDUCTION' ? 'DEDUCTION' : 'EARNING',
      calculation: f.calculation,
      recurring: f.recurring,
      ...(c ? { status: f.active ? 'ACTIVE' : 'INACTIVE', expectedVersion: c.version } : {}),
    };
    const done = await this.action.run(() =>
      c
        ? this.api.patch(`hr/pay-components/${c.id}`, body)
        : this.api.post('hr/pay-components', body),
    );
    if (!done) return;
    this.componentOpen.set(false);
    this.toasts.show('Componente guardado.');
    await this.load();
  }

  protected async openIncidences(c: PayComponent) {
    this.action.error.set(null);
    this.inc = this.emptyIncidence();
    try {
      this.incOf.set(await this.api.get<PayComponent>(`hr/pay-components/${c.id}`));
    } catch (error) {
      this.toasts.show(ApiError.from(error).message, 'error');
    }
  }

  protected async saveIncidence() {
    const c = this.incOf()!;
    const i = this.inc;
    const result = await this.action.run(() =>
      this.api.post<PayComponent>(`hr/pay-components/${c.id}/incidences`, {
        validFrom: i.validFrom || null,
        irtSubject: i.irtSubject,
        irtExemptAmount:
          i.irtSubject && i.irtExemptAmount ? i.irtExemptAmount.replace(',', '.') : null,
        inssSubject: i.inssSubject,
        legalReference: i.legalReference,
      }),
    );
    if (!result) return;
    this.incOf.set(result);
    this.inc = this.emptyIncidence();
    this.toasts.show('Incidência registada.');
    await this.load();
  }
}
