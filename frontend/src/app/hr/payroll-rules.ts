import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api, ApiError } from '../core/api';
import { ConfirmService } from '../ui/confirm';
import { formatDate } from '../ui/dates';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField } from '../ui/form-field';
import { Icon } from '../ui/icon';
import { Action } from '../ui/load';
import { Modal } from '../ui/modal';
import { formatMoney } from '../ui/money-input';
import { ErrorState, Skeleton } from '../ui/states';
import { EntityListPage } from '../ui/templates';
import { ToastService } from '../ui/toasts';
import { type Bracket, bracketsPayload, DAY_BASIS, pct, type RuleSet } from './payroll-model';

const emptyForm = () => ({
  code: '',
  name: '',
  currency: 'AOA',
  validFrom: '',
  inssEmployeeRate: '',
  inssEmployerRate: '',
  baseIrtSubject: true,
  baseInssSubject: true,
  irtBaseDeductsInss: true,
  dayBasis: 'FIXED_30' as RuleSet['dayBasis'],
  legalReference: '',
  brackets: [{ lower: '0', upper: '', fixedAmount: '0', rate: '', excessOver: '0' }] as Bracket[],
});

/**
 * Regras de processamento por vigência e moeda: taxas de INSS, tabela progressiva de IRT, incidência do salário base,
 * base do IRT e base de dias. Nada vem pré-preenchido com valores legais: a empresa introduz os da legislação em vigor,
 * com a fonte. Publicadas, não se alteram (nova versão com nova data).
 */
@Component({
  selector: 'app-payroll-rules',
  imports: [
    FormsModule,
    EntityListPage,
    Modal,
    FormField,
    FieldControl,
    ErrorAlert,
    ErrorState,
    Skeleton,
    Icon,
  ],
  template: `
    <app-entity-list-page
      title="Regras de processamento"
      subtitle="Taxas de INSS e tabela de IRT por vigência, sempre com a fonte. Confirme os valores na legislação em vigor."
      permission="hr.payroll.settings"
      feature="hr"
    >
      <button
        actions
        type="button"
        class="btn-primary"
        data-testid="new-rules"
        (click)="open(null)"
      >
        <app-icon name="plus" [size]="16" />Nova versão
      </button>
      @if (loadError()) {
        <app-error-state [error]="loadError()" (retry)="load()" />
      } @else if (!items()) {
        <div class="card"><app-skeleton /></div>
      } @else if (!items()!.length) {
        <p class="card text-sm text-muted">
          Sem regras: o processamento dá erro "sem regras" até haver uma versão publicada.
        </p>
      } @else {
        <div class="space-y-4">
          @for (r of items(); track r.id) {
            <section class="card" [attr.data-testid]="'rules-' + r.code">
              <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h2 class="font-semibold">
                  {{ r.code }} — {{ r.name }}
                  <span
                    class="badge ml-1"
                    [class]="
                      r.status === 'PUBLISHED'
                        ? 'bg-success-soft text-success-text'
                        : 'bg-info-soft text-info-text'
                    "
                    >{{ r.status === 'PUBLISHED' ? 'Publicada' : 'Rascunho' }}</span
                  >
                </h2>
                @if (r.status === 'DRAFT') {
                  <span class="flex gap-2">
                    <button type="button" class="btn-secondary" (click)="open(r)">Editar</button>
                    <button
                      type="button"
                      class="btn-primary"
                      [attr.data-testid]="'publish-' + r.code"
                      (click)="publish(r)"
                    >
                      Publicar
                    </button>
                    <button type="button" class="btn-ghost" (click)="remove(r)">Apagar</button>
                  </span>
                }
              </div>
              <p class="text-sm text-muted">
                {{ r.currency }} · em vigor desde {{ date(r.validFrom) }} · fonte:
                {{ r.legalReference }}
              </p>
              <p class="mt-2 text-sm">
                INSS {{ pct(r.inssEmployeeRate) }}% (trabalhador) e {{ pct(r.inssEmployerRate) }}%
                (empresa) · salário base
                {{ r.baseIrtSubject ? 'sujeito a IRT' : 'não sujeito a IRT' }} e
                {{ r.baseInssSubject ? 'a INSS' : 'não a INSS' }} · base do IRT
                {{ r.irtBaseDeductsInss ? 'depois do INSS do trabalhador' : 'sem deduzir o INSS' }}
                · dias: {{ dayBasis(r) }}
              </p>
              <div class="mt-2 overflow-x-auto">
                <table class="w-full text-sm">
                  <caption class="sr-only">
                    Tabela de IRT
                  </caption>
                  <thead>
                    <tr class="text-left text-muted">
                      <th scope="col" class="py-1 pr-3 font-medium">De</th>
                      <th scope="col" class="py-1 pr-3 font-medium">Até</th>
                      <th scope="col" class="py-1 pr-3 text-right font-medium">Parcela fixa</th>
                      <th scope="col" class="py-1 pr-3 text-right font-medium">Taxa</th>
                      <th scope="col" class="py-1 text-right font-medium">Sobre o excesso de</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (b of r.brackets; track $index) {
                      <tr class="border-t border-border">
                        <td class="py-1 pr-3 whitespace-nowrap tabular-nums">
                          {{ money(b.lower) }}
                        </td>
                        <td class="py-1 pr-3 whitespace-nowrap tabular-nums">
                          {{ b.upper ? money(b.upper) : 'em diante' }}
                        </td>
                        <td class="py-1 pr-3 text-right whitespace-nowrap tabular-nums">
                          {{ money(b.fixedAmount) }}
                        </td>
                        <td class="py-1 pr-3 text-right tabular-nums">{{ pct(b.rate) }}%</td>
                        <td class="py-1 text-right whitespace-nowrap tabular-nums">
                          {{ money(b.excessOver) }}
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            </section>
          }
        </div>
      }
    </app-entity-list-page>

    <app-modal
      [title]="editing() ? 'Editar ' + editing()!.code : 'Nova versão das regras'"
      [open]="opened()"
      (closed)="opened.set(false)"
    >
      <app-error-alert [error]="action.error()" [showDetails]="false" />
      <div class="space-y-3">
        <div class="grid gap-3 sm:grid-cols-2">
          <app-field label="Código" [required]="true" [error]="action.field('code')">
            <input
              appControl
              class="input"
              data-testid="rs-code"
              [(ngModel)]="f.code"
              [ngModelOptions]="{ standalone: true }"
            />
          </app-field>
          <app-field label="Nome" [required]="true" [error]="action.field('name')">
            <input
              appControl
              class="input"
              data-testid="rs-name"
              [(ngModel)]="f.name"
              [ngModelOptions]="{ standalone: true }"
            />
          </app-field>
          <app-field label="Moeda" [required]="true" [error]="action.field('currency')">
            <input
              appControl
              class="input"
              maxlength="3"
              [(ngModel)]="f.currency"
              [ngModelOptions]="{ standalone: true }"
            />
          </app-field>
          <app-field label="Em vigor desde" [required]="true" [error]="action.field('validFrom')">
            <input
              appControl
              class="input"
              type="date"
              data-testid="rs-from"
              [(ngModel)]="f.validFrom"
              [ngModelOptions]="{ standalone: true }"
            />
          </app-field>
          <app-field
            label="INSS do trabalhador (%)"
            [required]="true"
            [error]="action.field('inssEmployeeRate')"
          >
            <input
              appControl
              class="input"
              inputmode="decimal"
              data-testid="rs-inss"
              [(ngModel)]="f.inssEmployeeRate"
              [ngModelOptions]="{ standalone: true }"
            />
          </app-field>
          <app-field
            label="INSS da empresa (%)"
            [required]="true"
            [error]="action.field('inssEmployerRate')"
          >
            <input
              appControl
              class="input"
              inputmode="decimal"
              data-testid="rs-inss-employer"
              [(ngModel)]="f.inssEmployerRate"
              [ngModelOptions]="{ standalone: true }"
            />
          </app-field>
        </div>
        <app-field
          label="Fonte (diploma, artigo, publicação)"
          [required]="true"
          [error]="action.field('legalReference')"
        >
          <textarea
            appControl
            class="input min-h-16"
            data-testid="rs-reference"
            [(ngModel)]="f.legalReference"
            [ngModelOptions]="{ standalone: true }"
          ></textarea>
        </app-field>
        <fieldset class="space-y-1 text-sm">
          <legend class="mb-1 font-medium">Incidência e bases</legend>
          <label class="flex items-center gap-2"
            ><input
              type="checkbox"
              [(ngModel)]="f.baseIrtSubject"
              [ngModelOptions]="{ standalone: true }"
            />Salário base sujeito a IRT</label
          >
          <label class="flex items-center gap-2"
            ><input
              type="checkbox"
              [(ngModel)]="f.baseInssSubject"
              [ngModelOptions]="{ standalone: true }"
            />Salário base sujeito a INSS</label
          >
          <label class="flex items-center gap-2"
            ><input
              type="checkbox"
              [(ngModel)]="f.irtBaseDeductsInss"
              [ngModelOptions]="{ standalone: true }"
            />A base do IRT deduz o INSS do trabalhador</label
          >
        </fieldset>
        <app-field
          label="Base de dias (mês incompleto e faltas)"
          [error]="action.field('dayBasis')"
        >
          <select
            appControl
            class="input"
            [(ngModel)]="f.dayBasis"
            [ngModelOptions]="{ standalone: true }"
          >
            <option value="FIXED_30">30 dias</option>
            <option value="CALENDAR">Dias do mês</option>
          </select>
        </app-field>
        <fieldset class="min-w-0">
          <legend class="mb-1 text-sm font-medium">
            Tabela de IRT (parcela fixa + taxa × (base − excesso))
          </legend>
          @if (action.field('brackets')) {
            <p class="field-error">{{ action.field('brackets') }}</p>
          }
          <ul class="space-y-2">
            @for (b of f.brackets; track $index; let i = $index) {
              <li
                class="grid grid-cols-2 gap-2 sm:grid-cols-[repeat(5,minmax(0,1fr))_auto]"
                data-testid="rs-bracket"
              >
                <input
                  class="input text-right"
                  inputmode="decimal"
                  placeholder="De"
                  [attr.aria-label]="'De, escalão ' + (i + 1)"
                  [attr.data-testid]="'rs-lower-' + i"
                  [(ngModel)]="b.lower"
                  [ngModelOptions]="{ standalone: true }"
                />
                <input
                  class="input text-right"
                  inputmode="decimal"
                  placeholder="Até (vazio = sem limite)"
                  [attr.aria-label]="'Até, escalão ' + (i + 1)"
                  [attr.data-testid]="'rs-upper-' + i"
                  [(ngModel)]="b.upper"
                  [ngModelOptions]="{ standalone: true }"
                />
                <input
                  class="input text-right"
                  inputmode="decimal"
                  placeholder="Parcela fixa"
                  [attr.aria-label]="'Parcela fixa, escalão ' + (i + 1)"
                  [attr.data-testid]="'rs-fixed-' + i"
                  [(ngModel)]="b.fixedAmount"
                  [ngModelOptions]="{ standalone: true }"
                />
                <input
                  class="input text-right"
                  inputmode="decimal"
                  placeholder="Taxa %"
                  [attr.aria-label]="'Taxa, escalão ' + (i + 1)"
                  [attr.data-testid]="'rs-rate-' + i"
                  [(ngModel)]="b.rate"
                  [ngModelOptions]="{ standalone: true }"
                />
                <input
                  class="input text-right"
                  inputmode="decimal"
                  placeholder="Excesso de"
                  [attr.aria-label]="'Excesso de, escalão ' + (i + 1)"
                  [attr.data-testid]="'rs-excess-' + i"
                  [(ngModel)]="b.excessOver"
                  [ngModelOptions]="{ standalone: true }"
                />
                <button
                  type="button"
                  class="btn-ghost px-2"
                  [attr.aria-label]="'Remover escalão ' + (i + 1)"
                  (click)="f.brackets.splice(i, 1)"
                >
                  <app-icon name="close" [size]="16" />
                </button>
                @if (bracketError(i)) {
                  <p class="field-error col-span-2 sm:col-span-6">{{ bracketError(i) }}</p>
                }
              </li>
            }
          </ul>
          <button
            type="button"
            class="btn-ghost mt-2"
            data-testid="rs-add-bracket"
            (click)="addBracket()"
          >
            <app-icon name="plus" [size]="16" />Adicionar escalão
          </button>
        </fieldset>
      </div>
      <ng-container actions>
        <button type="button" class="btn-secondary" (click)="opened.set(false)">Cancelar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="rs-confirm"
          [disabled]="action.busy()"
          (click)="save()"
        >
          Guardar rascunho
        </button>
      </ng-container>
    </app-modal>
  `,
})
export class PayrollRules {
  private readonly api = inject(Api);
  private readonly toasts = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  protected readonly items = signal<RuleSet[] | null>(null);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly opened = signal(false);
  protected readonly editing = signal<RuleSet | null>(null);
  protected readonly action = new Action();
  protected f = emptyForm();
  protected readonly pct = pct;
  protected readonly money = (v: string) => formatMoney(v);
  protected readonly date = formatDate;
  protected readonly dayBasis = (r: RuleSet) => DAY_BASIS[r.dayBasis];

  constructor() {
    void this.load();
  }

  protected async load() {
    this.loadError.set(null);
    try {
      this.items.set(await this.api.get<RuleSet[]>('hr/payroll/rule-sets'));
    } catch (error) {
      this.loadError.set(ApiError.from(error));
    }
  }

  protected bracketError(i: number) {
    for (const k of ['lower', 'upper', 'fixedAmount', 'rate', 'excessOver']) {
      const e = this.action.field(`brackets.${i}.${k}`);
      if (e) return e;
    }
    return null;
  }

  protected addBracket() {
    const last = this.f.brackets[this.f.brackets.length - 1];
    this.f.brackets.push({
      lower: '',
      upper: '',
      fixedAmount: '0',
      rate: '',
      excessOver: last?.upper ?? '',
    });
  }

  protected open(r: RuleSet | null) {
    this.action.error.set(null);
    this.editing.set(r);
    this.f = r
      ? {
          code: r.code,
          name: r.name,
          currency: r.currency,
          validFrom: r.validFrom,
          inssEmployeeRate: pct(r.inssEmployeeRate).replace(',', '.'),
          inssEmployerRate: pct(r.inssEmployerRate).replace(',', '.'),
          baseIrtSubject: r.baseIrtSubject,
          baseInssSubject: r.baseInssSubject,
          irtBaseDeductsInss: r.irtBaseDeductsInss,
          dayBasis: r.dayBasis,
          legalReference: r.legalReference,
          brackets: r.brackets.map((b) => ({
            ...b,
            upper: b.upper ?? '',
            rate: pct(b.rate).replace(',', '.'),
          })),
        }
      : emptyForm();
    this.opened.set(true);
  }

  protected async save() {
    const e = this.editing();
    const body = {
      ...this.f,
      currency: this.f.currency.trim().toUpperCase(),
      inssEmployeeRate: this.f.inssEmployeeRate.trim().replace(',', '.'),
      inssEmployerRate: this.f.inssEmployerRate.trim().replace(',', '.'),
      validFrom: this.f.validFrom || null,
      brackets: bracketsPayload(this.f.brackets),
    };
    const done = await this.action.run(() =>
      e
        ? this.api.patch(`hr/payroll/rule-sets/${e.id}`, { ...body, expectedVersion: e.version })
        : this.api.post('hr/payroll/rule-sets', body),
    );
    if (!done) return;
    this.opened.set(false);
    await this.load();
    this.toasts.show('Regras guardadas em rascunho.');
  }

  protected async publish(r: RuleSet) {
    const ok = await this.confirm.ask({
      title: 'Publicar regras',
      message: `Publicadas, as regras ${r.code} passam a ser usadas a partir de ${formatDate(r.validFrom)} e não se alteram. Confirmou os valores na fonte indicada?`,
      confirmLabel: 'Publicar',
    });
    if (!ok) return;
    const done = await this.action.run(() =>
      this.api.post(`hr/payroll/rule-sets/${r.id}/publish`, { expectedVersion: r.version }),
    );
    if (!done) {
      const err = this.action.error();
      this.toasts.show(err?.details?.[0]?.message ?? err?.message ?? 'Erro.', 'error');
      return;
    }
    await this.load();
    this.toasts.show('Regras publicadas.');
  }

  protected async remove(r: RuleSet) {
    const ok = await this.confirm.ask({
      title: 'Apagar rascunho',
      message: `Apagar o rascunho ${r.code}?`,
      confirmLabel: 'Apagar',
      danger: true,
    });
    if (!ok) return;
    const done = await this.action.run(() =>
      this.api.delete(`hr/payroll/rule-sets/${r.id}`).then(() => true),
    );
    if (done) {
      await this.load();
      this.toasts.show('Rascunho apagado.');
    }
  }
}
