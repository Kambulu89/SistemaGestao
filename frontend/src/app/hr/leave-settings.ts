import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api, ApiError } from '../core/api';
import { Workspace } from '../core/workspace';
import { ConfirmService } from '../ui/confirm';
import { formatDate } from '../ui/dates';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField } from '../ui/form-field';
import { Icon } from '../ui/icon';
import { Action } from '../ui/load';
import { Modal } from '../ui/modal';
import { ErrorState, Skeleton } from '../ui/states';
import { SettingsPage } from '../ui/templates';
import { ToastService } from '../ui/toasts';
import {
  COUNTING,
  daysLabel,
  FIRST_YEAR_RULE,
  LEAVE_CATEGORY,
  type LeavePolicy,
  type LeaveType,
  leaveTone,
  ROUNDING,
} from './leave-model';

interface Option {
  id: string;
  label: string;
}
interface Ref {
  id: string;
  code: string;
  name?: string;
  legalName?: string;
}

/**
 * Configuração de férias e ausências: tipos (contagem, saldo, confidencialidade) e políticas versionadas com a fonte
 * legal. Uma política publicada não muda: cria-se uma nova versão com data de início, que fecha a anterior.
 */
@Component({
  selector: 'app-leave-settings',
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
      title="Férias e ausências — configuração"
      subtitle="Valores definidos pela empresa: nenhum valor legal está fixado no sistema. Indique a fonte de cada política."
      [sections]="[
        { id: 'lv-policies', label: 'Políticas de férias' },
        { id: 'lv-types', label: 'Tipos de ausência' },
      ]"
    >
      @if (loadError()) {
        <app-error-state [error]="loadError()" (retry)="load()" />
      } @else if (!loaded()) {
        <div class="card"><app-skeleton /></div>
      } @else {
        <section id="lv-policies" tabindex="-1" class="card" aria-labelledby="lv-policies-title">
          <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 id="lv-policies-title" class="font-semibold">Políticas de férias</h2>
            <button
              type="button"
              class="btn-secondary"
              data-testid="new-policy"
              (click)="openPolicy(null, false)"
            >
              <app-icon name="plus" [size]="16" />Nova política
            </button>
          </div>
          <ul class="divide-y divide-border text-sm">
            @for (p of policies(); track p.id) {
              <li
                class="flex flex-wrap items-start justify-between gap-2 py-3"
                data-testid="policy"
              >
                <div class="min-w-0">
                  <p class="font-medium">{{ p.code }} v{{ p.policyVersion }} — {{ p.name }}</p>
                  <p class="text-muted">
                    {{ days(p.annualDays) }} dias/ano · {{ rule(p.firstYearRule) }} · transporte até
                    {{ days(p.carryoverMaxDays) }} · calendário {{ p.calendarCode }} ·
                    {{ p.legalEntityCode ?? 'todas as entidades' }} · desde {{ date(p.validFrom)
                    }}{{ p.validTo ? ' até ' + date(p.validTo) : '' }}
                  </p>
                  <p class="text-xs text-muted">Fonte: {{ p.legalReference }}</p>
                </div>
                <div class="flex flex-wrap items-center gap-2">
                  <span class="badge" [class]="tone(p.status)">{{ policyStatus[p.status] }}</span>
                  @if (p.status === 'DRAFT') {
                    <button type="button" class="btn-ghost" (click)="openPolicy(p, false)">
                      Alterar
                    </button>
                    <button
                      type="button"
                      class="btn-primary"
                      data-testid="publish-policy"
                      (click)="publish(p)"
                    >
                      Publicar
                    </button>
                  }
                  @if (p.status === 'ACTIVE') {
                    <button
                      type="button"
                      class="btn-ghost"
                      data-testid="new-version"
                      (click)="openPolicy(p, true)"
                    >
                      Nova versão
                    </button>
                  }
                </div>
              </li>
            } @empty {
              <li class="py-3 text-muted">
                Sem políticas. Sem política não há direito de férias nem contagem de dias úteis.
              </li>
            }
          </ul>
        </section>

        <section id="lv-types" tabindex="-1" class="card" aria-labelledby="lv-types-title">
          <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 id="lv-types-title" class="font-semibold">Tipos de ausência</h2>
            <button
              type="button"
              class="btn-secondary"
              data-testid="new-type"
              (click)="openType(null)"
            >
              <app-icon name="plus" [size]="16" />Novo tipo
            </button>
          </div>
          <ul class="divide-y divide-border text-sm">
            @for (t of types(); track t.id) {
              <li
                class="flex flex-wrap items-center justify-between gap-2 py-2"
                data-testid="leave-type"
              >
                <div class="min-w-0">
                  <p class="font-medium">{{ t.code }} — {{ t.name }}</p>
                  <p class="text-muted">
                    {{ category(t.category) }} · {{ counting(t.counting) }} ·
                    {{ t.paid ? 'remunerada' : 'não remunerada' }} ·
                    {{ t.deductsBalance ? 'desconta férias' : 'não desconta'
                    }}{{ t.confidential ? ' · confidencial' : ''
                    }}{{ t.requiresDocument ? ' · exige justificativo' : '' }}
                  </p>
                </div>
                <div class="flex items-center gap-2">
                  <span class="badge" [class]="tone(t.status)">{{
                    t.status === 'ACTIVE' ? 'Activo' : 'Inactivo'
                  }}</span>
                  <button type="button" class="btn-ghost" (click)="openType(t)">Alterar</button>
                </div>
              </li>
            } @empty {
              <li class="py-3 text-muted">Sem tipos de ausência.</li>
            }
          </ul>
        </section>
      }
    </app-settings-page>

    <app-modal
      [title]="typeEditing() ? 'Alterar tipo de ausência' : 'Novo tipo de ausência'"
      [open]="typeOpen()"
      (closed)="typeOpen.set(false)"
    >
      <app-error-alert [error]="action.error()" [showDetails]="false" />
      <div class="space-y-3">
        <app-field label="Código" [required]="true" [error]="action.field('code')">
          <input
            appControl
            class="input"
            data-testid="lt-code"
            [(ngModel)]="tf.code"
            [ngModelOptions]="{ standalone: true }"
          />
        </app-field>
        <app-field label="Nome" [required]="true" [error]="action.field('name')">
          <input
            appControl
            class="input"
            data-testid="lt-name"
            [(ngModel)]="tf.name"
            [ngModelOptions]="{ standalone: true }"
          />
        </app-field>
        <app-field label="Categoria" [required]="true" [error]="action.field('category')">
          <select
            appControl
            class="input"
            data-testid="lt-category"
            [(ngModel)]="tf.category"
            [ngModelOptions]="{ standalone: true }"
          >
            @for (c of categories; track c[0]) {
              <option [value]="c[0]">{{ c[1] }}</option>
            }
          </select>
        </app-field>
        <app-field label="Contagem" [required]="true" [error]="action.field('counting')">
          <select
            appControl
            class="input"
            data-testid="lt-counting"
            [(ngModel)]="tf.counting"
            [ngModelOptions]="{ standalone: true }"
          >
            @for (c of countings; track c[0]) {
              <option [value]="c[0]">{{ c[1] }}</option>
            }
          </select>
        </app-field>
        <app-field label="Máximo de dias por pedido" [error]="action.field('maxDaysPerRequest')">
          <input
            appControl
            class="input"
            inputmode="decimal"
            [(ngModel)]="tf.maxDaysPerRequest"
            [ngModelOptions]="{ standalone: true }"
          />
        </app-field>
        <fieldset class="min-w-0 space-y-2 text-sm">
          <legend class="sr-only">Regras</legend>
          <label class="flex items-center gap-2"
            ><input
              type="checkbox"
              data-testid="lt-paid"
              [(ngModel)]="tf.paid"
              [ngModelOptions]="{ standalone: true }"
            />
            Remunerada</label
          >
          <label class="flex items-center gap-2"
            ><input
              type="checkbox"
              data-testid="lt-deducts"
              [(ngModel)]="tf.deductsBalance"
              [ngModelOptions]="{ standalone: true }"
            />
            Desconta do saldo de férias</label
          >
          <label class="flex items-center gap-2"
            ><input
              type="checkbox"
              [(ngModel)]="tf.requiresDocument"
              [ngModelOptions]="{ standalone: true }"
            />
            Exige justificativo</label
          >
          <label class="flex items-center gap-2"
            ><input
              type="checkbox"
              data-testid="lt-confidential"
              [(ngModel)]="tf.confidential"
              [ngModelOptions]="{ standalone: true }"
            />
            Confidencial (ex.: dados de saúde)</label
          >
          @if (typeEditing()) {
            <label class="flex items-center gap-2"
              ><input
                type="checkbox"
                [(ngModel)]="tf.active"
                [ngModelOptions]="{ standalone: true }"
              />
              Activo</label
            >
          }
        </fieldset>
      </div>
      <ng-container actions>
        <button type="button" class="btn-secondary" (click)="typeOpen.set(false)">Cancelar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="lt-confirm"
          [disabled]="action.busy()"
          (click)="saveType()"
        >
          Guardar
        </button>
      </ng-container>
    </app-modal>

    <app-modal [title]="policyTitle()" [open]="policyOpen()" (closed)="policyOpen.set(false)">
      <app-error-alert [error]="action.error()" [showDetails]="false" />
      <div class="space-y-3">
        <app-field label="Código" [required]="true" [error]="action.field('code')">
          <input
            appControl
            class="input"
            data-testid="lp-code"
            [disabled]="!!policyBase()"
            [(ngModel)]="pf.code"
            [ngModelOptions]="{ standalone: true }"
          />
        </app-field>
        <app-field label="Nome" [required]="true" [error]="action.field('name')">
          <input
            appControl
            class="input"
            data-testid="lp-name"
            [(ngModel)]="pf.name"
            [ngModelOptions]="{ standalone: true }"
          />
        </app-field>
        <app-field
          label="Entidade legal"
          hint="Vazio: todas as entidades."
          [error]="action.field('legalEntityId')"
        >
          <select
            appControl
            class="input"
            [(ngModel)]="pf.legalEntityId"
            [ngModelOptions]="{ standalone: true }"
          >
            <option [ngValue]="null">Todas</option>
            @for (o of legalEntities(); track o.id) {
              <option [ngValue]="o.id">{{ o.label }}</option>
            }
          </select>
        </app-field>
        <app-field
          label="Calendário (dias úteis e feriados)"
          [required]="true"
          [error]="action.field('calendarId')"
        >
          <select
            appControl
            class="input"
            data-testid="lp-calendar"
            [(ngModel)]="pf.calendarId"
            [ngModelOptions]="{ standalone: true }"
          >
            <option [ngValue]="null">—</option>
            @for (o of calendars(); track o.id) {
              <option [ngValue]="o.id">{{ o.label }}</option>
            }
          </select>
        </app-field>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <app-field
            label="Dias de férias por ano"
            [required]="true"
            [error]="action.field('annualDays')"
          >
            <input
              appControl
              class="input"
              inputmode="decimal"
              data-testid="lp-annual"
              [(ngModel)]="pf.annualDays"
              [ngModelOptions]="{ standalone: true }"
            />
          </app-field>
          <app-field label="Transporte máximo (dias)" [error]="action.field('carryoverMaxDays')">
            <input
              appControl
              class="input"
              inputmode="decimal"
              [(ngModel)]="pf.carryoverMaxDays"
              [ngModelOptions]="{ standalone: true }"
            />
          </app-field>
        </div>
        <app-field
          label="Ano de admissão"
          [required]="true"
          [error]="action.field('firstYearRule')"
        >
          <select
            appControl
            class="input"
            [(ngModel)]="pf.firstYearRule"
            [ngModelOptions]="{ standalone: true }"
          >
            @for (r of rules; track r[0]) {
              <option [value]="r[0]">{{ r[1] }}</option>
            }
          </select>
        </app-field>
        @if (pf.firstYearRule === 'DAYS_PER_MONTH') {
          <app-field
            label="Dias por mês completo"
            [required]="true"
            [error]="action.field('firstYearDaysPerMonth')"
          >
            <input
              appControl
              class="input"
              inputmode="decimal"
              [(ngModel)]="pf.firstYearDaysPerMonth"
              [ngModelOptions]="{ standalone: true }"
            />
          </app-field>
        }
        <app-field label="Arredondamento" [error]="action.field('rounding')">
          <select
            appControl
            class="input"
            [(ngModel)]="pf.rounding"
            [ngModelOptions]="{ standalone: true }"
          >
            @for (r of roundings; track r[0]) {
              <option [value]="r[0]">{{ r[1] }}</option>
            }
          </select>
        </app-field>
        <app-field label="Em vigor desde" [required]="true" [error]="action.field('validFrom')">
          <input
            appControl
            class="input"
            type="date"
            data-testid="lp-from"
            [(ngModel)]="pf.validFrom"
            [ngModelOptions]="{ standalone: true }"
          />
        </app-field>
        <app-field
          label="Fonte legal / referência"
          [required]="true"
          hint="Ex.: artigo da Lei Geral do Trabalho ou acordo colectivo, confirmados pela empresa."
          [error]="action.field('legalReference')"
        >
          <textarea
            appControl
            class="input min-h-20"
            data-testid="lp-reference"
            [(ngModel)]="pf.legalReference"
            [ngModelOptions]="{ standalone: true }"
          ></textarea>
        </app-field>
      </div>
      <ng-container actions>
        <button type="button" class="btn-secondary" (click)="policyOpen.set(false)">
          Cancelar
        </button>
        <button
          type="button"
          class="btn-primary"
          data-testid="lp-confirm"
          [disabled]="action.busy()"
          (click)="savePolicy()"
        >
          Guardar rascunho
        </button>
      </ng-container>
    </app-modal>
  `,
})
export class LeaveSettings {
  private readonly api = inject(Api);
  private readonly workspace = inject(Workspace);
  private readonly toasts = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  protected readonly loaded = signal(false);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly types = signal<LeaveType[]>([]);
  protected readonly policies = signal<LeavePolicy[]>([]);
  protected readonly calendars = signal<Option[]>([]);
  protected readonly legalEntities = signal<Option[]>([]);
  protected readonly action = new Action();
  protected readonly days = daysLabel;
  protected readonly date = formatDate;
  protected readonly tone = leaveTone;
  protected readonly rule = (r: LeavePolicy['firstYearRule']) => FIRST_YEAR_RULE[r];
  protected readonly category = (c: string) => LEAVE_CATEGORY[c] ?? c;
  protected readonly counting = (c: LeaveType['counting']) => COUNTING[c];
  protected readonly categories = Object.entries(LEAVE_CATEGORY);
  protected readonly countings = Object.entries(COUNTING);
  protected readonly rules = Object.entries(FIRST_YEAR_RULE);
  protected readonly roundings = Object.entries(ROUNDING);
  protected readonly policyStatus: Record<LeavePolicy['status'], string> = {
    DRAFT: 'Rascunho',
    ACTIVE: 'Em vigor',
    RETIRED: 'Substituída',
  };
  protected readonly typeOpen = signal(false);
  protected readonly typeEditing = signal<LeaveType | null>(null);
  protected tf = this.emptyType();
  protected readonly policyOpen = signal(false);
  protected readonly policyEditing = signal<LeavePolicy | null>(null);
  protected readonly policyBase = signal<LeavePolicy | null>(null);
  protected pf = this.emptyPolicy();

  constructor() {
    void this.load();
  }

  protected policyTitle() {
    if (this.policyBase()) return `Nova versão de ${this.policyBase()!.code}`;
    return this.policyEditing() ? 'Alterar rascunho' : 'Nova política de férias';
  }

  private emptyType() {
    return {
      code: '',
      name: '',
      category: 'VACATION',
      counting: 'WORKING_DAYS',
      maxDaysPerRequest: '',
      paid: true,
      deductsBalance: true,
      requiresDocument: false,
      confidential: false,
      active: true,
    };
  }

  private emptyPolicy() {
    return {
      code: '',
      name: '',
      legalEntityId: null as string | null,
      calendarId: null as string | null,
      annualDays: '',
      carryoverMaxDays: '0',
      firstYearRule: 'PROPORTIONAL_MONTHS' as string,
      firstYearDaysPerMonth: '',
      rounding: 'NONE' as string,
      validFrom: '',
      legalReference: '',
    };
  }

  protected async load() {
    this.loadError.set(null);
    try {
      const [types, policies] = await Promise.all([
        this.api.get<LeaveType[]>('hr/leave/types'),
        this.api.get<LeavePolicy[]>('hr/leave/policies'),
      ]);
      this.types.set(types);
      this.policies.set(policies);
      this.loaded.set(true);
    } catch (error) {
      this.loadError.set(ApiError.from(error));
    }
  }

  private async loadRefs() {
    if (this.calendars().length) return;
    const page = async (url: string, label: (r: Ref) => string) => {
      try {
        return (await this.api.page<Ref>(url, { limit: 200 })).items.map((r) => ({
          id: r.id,
          label: label(r),
        }));
      } catch {
        return [];
      }
    };
    this.calendars.set(await page('calendars', (r) => `${r.code} — ${r.name}`));
    if (this.workspace.can('organization.read'))
      this.legalEntities.set(
        await page('organization/legal-entities', (r) => `${r.code} — ${r.legalName}`),
      );
  }

  protected openType(t: LeaveType | null) {
    this.action.error.set(null);
    this.typeEditing.set(t);
    this.tf = t
      ? {
          code: t.code,
          name: t.name,
          category: t.category,
          counting: t.counting,
          maxDaysPerRequest: t.maxDaysPerRequest ?? '',
          paid: t.paid,
          deductsBalance: t.deductsBalance,
          requiresDocument: t.requiresDocument,
          confidential: t.confidential,
          active: t.status === 'ACTIVE',
        }
      : this.emptyType();
    this.typeOpen.set(true);
  }

  protected async saveType() {
    const t = this.typeEditing();
    const f = this.tf;
    const body = {
      code: f.code,
      name: f.name,
      category: f.category,
      counting: f.counting,
      maxDaysPerRequest: f.maxDaysPerRequest || null,
      paid: f.paid,
      deductsBalance: f.deductsBalance,
      requiresDocument: f.requiresDocument,
      confidential: f.confidential,
      ...(t ? { status: f.active ? 'ACTIVE' : 'INACTIVE', expectedVersion: t.version } : {}),
    };
    const done = await this.action.run(() =>
      t ? this.api.patch(`hr/leave/types/${t.id}`, body) : this.api.post('hr/leave/types', body),
    );
    if (!done) return;
    this.typeOpen.set(false);
    this.toasts.show('Tipo de ausência guardado.');
    await this.load();
  }

  protected async openPolicy(p: LeavePolicy | null, newVersion: boolean) {
    this.action.error.set(null);
    await this.loadRefs();
    this.policyEditing.set(newVersion ? null : p);
    this.policyBase.set(newVersion ? p : null);
    this.pf = p
      ? {
          code: p.code,
          name: p.name,
          legalEntityId: p.legalEntityId,
          calendarId: p.calendarId,
          annualDays: p.annualDays,
          carryoverMaxDays: p.carryoverMaxDays,
          firstYearRule: p.firstYearRule,
          firstYearDaysPerMonth: p.firstYearDaysPerMonth ?? '',
          rounding: p.rounding,
          validFrom: newVersion ? '' : p.validFrom,
          legalReference: p.legalReference,
        }
      : this.emptyPolicy();
    this.policyOpen.set(true);
  }

  protected async savePolicy() {
    const f = this.pf;
    const body = {
      name: f.name,
      legalEntityId: f.legalEntityId,
      calendarId: f.calendarId,
      annualDays: f.annualDays,
      carryoverMaxDays: f.carryoverMaxDays || '0',
      firstYearRule: f.firstYearRule,
      firstYearDaysPerMonth:
        f.firstYearRule === 'DAYS_PER_MONTH' ? f.firstYearDaysPerMonth || null : null,
      rounding: f.rounding,
      validFrom: f.validFrom || null,
      legalReference: f.legalReference,
    };
    const editing = this.policyEditing();
    const base = this.policyBase();
    const done = await this.action.run(() =>
      editing
        ? this.api.patch(`hr/leave/policies/${editing.id}`, {
            ...body,
            expectedVersion: editing.version,
          })
        : this.api.post(
            'hr/leave/policies',
            base ? { ...body, fromId: base.id } : { ...body, code: f.code },
          ),
    );
    if (!done) return;
    this.policyOpen.set(false);
    this.toasts.show('Política guardada em rascunho.');
    await this.load();
  }

  protected async publish(p: LeavePolicy) {
    const ok = await this.confirm.ask({
      title: 'Publicar política',
      message: `Publicar ${p.code} v${p.policyVersion} a partir de ${formatDate(p.validFrom)}? Depois não se altera; a versão anterior fecha na véspera.`,
      confirmLabel: 'Publicar',
    });
    if (!ok) return;
    const done = await this.action.run(() =>
      this.api.post(`hr/leave/policies/${p.id}/publish`, { expectedVersion: p.version }),
    );
    if (!done) return void this.toasts.show(this.action.error()?.message ?? 'Erro.', 'error');
    this.toasts.show('Política publicada.');
    await this.load();
  }
}
