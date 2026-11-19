import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api, ApiError } from '../core/api';
import { ConfirmService } from '../ui/confirm';
import { formatDate, formatDateTime } from '../ui/dates';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField } from '../ui/form-field';
import { Icon } from '../ui/icon';
import { Action } from '../ui/load';
import { Modal } from '../ui/modal';
import { formatMoney } from '../ui/money-input';
import { ErrorState, Skeleton } from '../ui/states';
import { EntityListPage } from '../ui/templates';
import { ToastService } from '../ui/toasts';
import {
  type Bracket,
  bracketsPayload,
  CASE_FIELD,
  type CaseResult,
  DAY_BASIS,
  pct,
  publishBlockers,
  type RuleSet,
  type TestCase,
  testCasesPayload,
} from './payroll-model';

const emptyCase = (): TestCase => ({
  description: '',
  source: '',
  baseSalary: '',
  allowancesSubject: '',
  allowancesIrtOnly: '',
  allowancesExempt: '',
  expectedInssEmployee: '',
  expectedIrt: '',
  expectedInssEmployer: '',
  expectedNet: '',
});

const emptyForm = () => ({
  code: '',
  name: '',
  currency: 'AOA',
  validFrom: '',
  validTo: '',
  inssEmployeeRate: '',
  inssEmployerRate: '',
  baseIrtSubject: true,
  baseInssSubject: true,
  irtBaseDeductsInss: true,
  dayBasis: 'FIXED_30' as RuleSet['dayBasis'],
  legalReference: '',
  brackets: [{ lower: '0', upper: '', fixedAmount: '0', rate: '', excessOver: '0' }] as Bracket[],
  testCases: [] as TestCase[],
});

interface Simulation {
  errors: { message: string }[];
  lines: { name: string; kind: string; amount: string }[];
  totals: Record<string, string>;
}

/**
 * Regras de IRT/INSS por vigência e moeda: taxas, tabela progressiva, incidência do salário base, base do IRT e base de
 * dias, com validade e fonte. Para publicar: casos de teste oficiais (com fonte) que dêem o valor esperado e a
 * confirmação, por uma pessoa, de que os valores são os das normas em vigor. Nada vem pré-preenchido com valores legais.
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
      title="Regras de IRT e INSS"
      subtitle="Taxas e tabela por vigência, com fonte, casos de teste oficiais e confirmação das normas em vigor antes de publicar."
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
                <span class="flex flex-wrap gap-2">
                  <button
                    type="button"
                    class="btn-secondary"
                    [attr.data-testid]="'simulate-' + r.code"
                    (click)="openSimulation(r)"
                  >
                    Simular
                  </button>
                  @if (r.testCases.length) {
                    <button
                      type="button"
                      class="btn-secondary"
                      [attr.data-testid]="'verify-' + r.code"
                      (click)="verify(r)"
                    >
                      Verificar casos
                    </button>
                  }
                  @if (r.status === 'DRAFT') {
                    <button type="button" class="btn-secondary" (click)="open(r)">Editar</button>
                    @if (!r.confirmedAt) {
                      <button
                        type="button"
                        class="btn-secondary"
                        [attr.data-testid]="'confirm-' + r.code"
                        (click)="openConfirm(r)"
                      >
                        Confirmar normas
                      </button>
                    }
                    <button
                      type="button"
                      class="btn-primary"
                      [attr.data-testid]="'publish-' + r.code"
                      (click)="publish(r)"
                    >
                      Publicar
                    </button>
                    <button type="button" class="btn-ghost" (click)="remove(r)">Apagar</button>
                  }
                </span>
              </div>
              <p class="text-sm text-muted">
                {{ r.currency }} · em vigor de {{ date(r.validFrom) }}
                {{ r.validTo ? 'até ' + date(r.validTo) : 'em diante (até à versão seguinte)' }} ·
                fonte: {{ r.legalReference }}
              </p>
              @if (r.confirmedAt) {
                <p class="mt-1 text-sm" [attr.data-testid]="'confirmed-' + r.code">
                  Normas confirmadas por {{ r.confirmedBy }} em {{ dateTime(r.confirmedAt) }}:
                  {{ r.confirmationNote }}
                </p>
              }
              @if (blockers(r).length) {
                <ul
                  class="mt-2 list-disc rounded-card bg-warning-soft p-3 pl-7 text-sm text-warning-text"
                  role="status"
                >
                  @for (b of blockers(r); track b) {
                    <li>{{ b }}</li>
                  }
                </ul>
              }
              <p class="mt-2 text-sm">
                INSS {{ pct(r.inssEmployeeRate) }}% (trabalhador) e {{ pct(r.inssEmployerRate) }}%
                (empresa) · salário base
                {{ r.baseIrtSubject ? 'sujeito a IRT' : 'não sujeito a IRT' }} e
                {{ r.baseInssSubject ? 'a INSS' : 'não a INSS' }} · base do IRT
                {{ r.irtBaseDeductsInss ? 'depois do INSS do trabalhador' : 'sem deduzir o INSS' }}
                · dias: {{ dayBasis(r) }}
              </p>
              <details class="mt-2 text-sm">
                <summary class="cursor-pointer text-link">
                  Tabela de IRT ({{ r.brackets.length }} escalões)
                </summary>
                <div class="mt-2 overflow-x-auto">
                  <table class="w-full">
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
              </details>
              <h3 class="mt-3 mb-1 text-sm font-semibold">Casos de teste oficiais</h3>
              @if (!r.testCases.length) {
                <p class="text-sm text-muted">Nenhum caso registado.</p>
              } @else {
                <ul class="divide-y divide-border text-sm" [attr.data-testid]="'cases-' + r.code">
                  @for (c of r.testCases; track $index; let i = $index) {
                    <li class="py-2">
                      <div class="flex flex-wrap items-center justify-between gap-2">
                        <span
                          >{{ c.description }}
                          <span class="text-muted">· {{ c.source }}</span></span
                        >
                        @if (result(r, i); as x) {
                          <span
                            class="badge"
                            [class]="
                              x.pass
                                ? 'bg-success-soft text-success-text'
                                : 'bg-danger-soft text-danger-text'
                            "
                            >{{ x.pass ? 'Passa' : 'Falha' }}</span
                          >
                        }
                      </div>
                      <p class="text-muted">
                        Base {{ money(c.baseSalary) }} · esperado INSS
                        {{ money(c.expectedInssEmployee) }}, IRT {{ money(c.expectedIrt) }}
                      </p>
                      @if (result(r, i); as x) {
                        @for (m of x.mismatches; track m.field) {
                          <p class="text-danger-text">
                            {{ field(m.field) }}: esperado {{ money(m.expected) }}, calculado
                            {{ money(m.actual) }}
                          </p>
                        }
                        @for (e of x.errors; track $index) {
                          <p class="text-danger-text">{{ e.message }}</p>
                        }
                      }
                    </li>
                  }
                </ul>
              }
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
            label="Em vigor até"
            hint="Vazio: até à versão seguinte."
            [error]="action.field('validTo')"
          >
            <input
              appControl
              class="input"
              type="date"
              data-testid="rs-to"
              [(ngModel)]="f.validTo"
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
        <fieldset class="min-w-0">
          <legend class="mb-1 text-sm font-medium">Casos de teste oficiais</legend>
          <p class="mb-2 text-xs text-muted">
            Exemplos publicados pela autoridade (ou por quem a empresa reconheça), com o resultado
            esperado. Têm de passar para confirmar e publicar.
          </p>
          <ul class="space-y-3">
            @for (c of f.testCases; track $index; let i = $index) {
              <li class="rounded-card border border-border p-2" data-testid="rs-case">
                <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <input
                    class="input"
                    placeholder="Descrição"
                    [attr.aria-label]="'Descrição do caso ' + (i + 1)"
                    [attr.data-testid]="'rs-case-desc-' + i"
                    [(ngModel)]="c.description"
                    [ngModelOptions]="{ standalone: true }"
                  />
                  <input
                    class="input"
                    placeholder="Fonte do caso"
                    [attr.aria-label]="'Fonte do caso ' + (i + 1)"
                    [attr.data-testid]="'rs-case-source-' + i"
                    [(ngModel)]="c.source"
                    [ngModelOptions]="{ standalone: true }"
                  />
                </div>
                <div class="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <input
                    class="input text-right"
                    inputmode="decimal"
                    placeholder="Salário base"
                    [attr.aria-label]="'Salário base, caso ' + (i + 1)"
                    [attr.data-testid]="'rs-case-base-' + i"
                    [(ngModel)]="c.baseSalary"
                    [ngModelOptions]="{ standalone: true }"
                  />
                  <input
                    class="input text-right"
                    inputmode="decimal"
                    placeholder="Abonos IRT+INSS"
                    [attr.aria-label]="'Abonos sujeitos a IRT e INSS, caso ' + (i + 1)"
                    [(ngModel)]="c.allowancesSubject"
                    [ngModelOptions]="{ standalone: true }"
                  />
                  <input
                    class="input text-right"
                    inputmode="decimal"
                    placeholder="Abonos só IRT"
                    [attr.aria-label]="'Abonos só IRT, caso ' + (i + 1)"
                    [(ngModel)]="c.allowancesIrtOnly"
                    [ngModelOptions]="{ standalone: true }"
                  />
                  <input
                    class="input text-right"
                    inputmode="decimal"
                    placeholder="Abonos isentos"
                    [attr.aria-label]="'Abonos isentos, caso ' + (i + 1)"
                    [(ngModel)]="c.allowancesExempt"
                    [ngModelOptions]="{ standalone: true }"
                  />
                  <input
                    class="input text-right"
                    inputmode="decimal"
                    placeholder="INSS esperado"
                    [attr.aria-label]="'INSS esperado, caso ' + (i + 1)"
                    [attr.data-testid]="'rs-case-inss-' + i"
                    [(ngModel)]="c.expectedInssEmployee"
                    [ngModelOptions]="{ standalone: true }"
                  />
                  <input
                    class="input text-right"
                    inputmode="decimal"
                    placeholder="IRT esperado"
                    [attr.aria-label]="'IRT esperado, caso ' + (i + 1)"
                    [attr.data-testid]="'rs-case-irt-' + i"
                    [(ngModel)]="c.expectedIrt"
                    [ngModelOptions]="{ standalone: true }"
                  />
                  <input
                    class="input text-right"
                    inputmode="decimal"
                    placeholder="INSS empresa (opc.)"
                    [attr.aria-label]="'INSS da empresa esperado, caso ' + (i + 1)"
                    [(ngModel)]="c.expectedInssEmployer"
                    [ngModelOptions]="{ standalone: true }"
                  />
                  <input
                    class="input text-right"
                    inputmode="decimal"
                    placeholder="Líquido (opc.)"
                    [attr.aria-label]="'Líquido esperado, caso ' + (i + 1)"
                    [attr.data-testid]="'rs-case-net-' + i"
                    [(ngModel)]="c.expectedNet"
                    [ngModelOptions]="{ standalone: true }"
                  />
                </div>
                @if (caseError(i); as e) {
                  <p class="field-error mt-1">{{ e }}</p>
                }
                <button
                  type="button"
                  class="btn-ghost mt-1"
                  [attr.aria-label]="'Remover caso ' + (i + 1)"
                  (click)="f.testCases.splice(i, 1)"
                >
                  Remover caso
                </button>
              </li>
            }
          </ul>
          <button
            type="button"
            class="btn-ghost mt-2"
            data-testid="rs-add-case"
            (click)="f.testCases.push(newCase())"
          >
            <app-icon name="plus" [size]="16" />Adicionar caso
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

    <app-modal
      title="Confirmar normas em vigor"
      [open]="!!confirming()"
      (closed)="confirming.set(null)"
    >
      <app-error-alert [error]="action.error()" />
      <p class="mb-3 text-sm text-muted">
        Confirme que as taxas, a tabela e as bases de {{ confirming()?.code }} correspondem às
        normas em vigor na fonte indicada ({{ confirming()?.legalReference }}). Os casos de teste
        são verificados de novo.
      </p>
      <app-field
        label="O que foi conferido e onde"
        [required]="true"
        [error]="action.field('note')"
      >
        <textarea
          appControl
          class="input min-h-20"
          data-testid="rs-confirm-note"
          [(ngModel)]="confirmNote"
          [ngModelOptions]="{ standalone: true }"
        ></textarea>
      </app-field>
      <label class="mt-2 flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          data-testid="rs-confirm-check"
          [(ngModel)]="confirmChecked"
          [ngModelOptions]="{ standalone: true }"
        />
        Conferi os valores na legislação em vigor e assumo esta confirmação.
      </label>
      <ng-container actions>
        <button type="button" class="btn-secondary" (click)="confirming.set(null)">Voltar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="rs-confirm-save"
          [disabled]="action.busy() || !confirmChecked"
          (click)="confirmRules()"
        >
          Confirmar
        </button>
      </ng-container>
    </app-modal>

    <app-modal
      [title]="'Simular — ' + (simulating()?.code ?? '')"
      [open]="!!simulating()"
      (closed)="simulating.set(null)"
    >
      <app-error-alert [error]="action.error()" [showDetails]="false" />
      <p class="mb-3 text-sm text-muted">
        Recibo de um mês completo com estas regras. Nada é gravado.
      </p>
      <div class="grid grid-cols-2 gap-2">
        <app-field label="Salário base" [required]="true" [error]="action.field('baseSalary')">
          <input
            appControl
            class="input text-right"
            inputmode="decimal"
            data-testid="sim-base"
            [(ngModel)]="sim.baseSalary"
            [ngModelOptions]="{ standalone: true }"
          />
        </app-field>
        <app-field label="Abonos IRT+INSS">
          <input
            appControl
            class="input text-right"
            inputmode="decimal"
            [(ngModel)]="sim.allowancesSubject"
            [ngModelOptions]="{ standalone: true }"
          />
        </app-field>
        <app-field label="Abonos só IRT">
          <input
            appControl
            class="input text-right"
            inputmode="decimal"
            data-testid="sim-irt-only"
            [(ngModel)]="sim.allowancesIrtOnly"
            [ngModelOptions]="{ standalone: true }"
          />
        </app-field>
        <app-field label="Abonos isentos">
          <input
            appControl
            class="input text-right"
            inputmode="decimal"
            [(ngModel)]="sim.allowancesExempt"
            [ngModelOptions]="{ standalone: true }"
          />
        </app-field>
      </div>
      @if (simResult(); as x) {
        <table class="mt-3 w-full text-sm" data-testid="sim-result">
          <caption class="sr-only">
            Resultado da simulação
          </caption>
          <tbody>
            @for (l of x.lines; track $index) {
              <tr class="border-t border-border" [class.text-muted]="l.kind === 'EMPLOYER'">
                <td class="py-1 pr-3">{{ l.name }}</td>
                <td class="py-1 text-right tabular-nums">
                  {{ l.kind === 'DEDUCTION' ? '−' : '' }}{{ money(l.amount) }}
                </td>
              </tr>
            }
            <tr class="border-t-2 border-border font-semibold">
              <td class="py-1 pr-3">Líquido</td>
              <td class="py-1 text-right tabular-nums" data-testid="sim-net">
                {{ money(x.totals['net']) }}
              </td>
            </tr>
          </tbody>
        </table>
        <p class="mt-2 text-sm text-muted">
          Base de INSS {{ money(x.totals['inssBase']) }} · base de IRT
          {{ money(x.totals['irtBase']) }}
        </p>
        @for (e of x.errors; track $index) {
          <p class="mt-1 text-sm text-danger-text">{{ e.message }}</p>
        }
      }
      <ng-container actions>
        <button type="button" class="btn-secondary" (click)="simulating.set(null)">Fechar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="sim-run"
          [disabled]="action.busy()"
          (click)="runSimulation()"
        >
          Simular
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
  protected readonly confirming = signal<RuleSet | null>(null);
  protected readonly simulating = signal<RuleSet | null>(null);
  protected readonly simResult = signal<Simulation | null>(null);
  protected readonly results = signal<Record<string, CaseResult[]>>({});
  protected readonly action = new Action();
  protected f = emptyForm();
  protected sim = {
    baseSalary: '',
    allowancesSubject: '',
    allowancesIrtOnly: '',
    allowancesExempt: '',
  };
  protected confirmNote = '';
  protected confirmChecked = false;
  protected readonly pct = pct;
  protected readonly money = (v: string) => formatMoney(v);
  protected readonly date = formatDate;
  protected readonly dateTime = formatDateTime;
  protected readonly dayBasis = (r: RuleSet) => DAY_BASIS[r.dayBasis];
  protected readonly blockers = publishBlockers;
  protected readonly field = (k: string) => CASE_FIELD[k] ?? k;
  protected readonly newCase = emptyCase;

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

  protected result(r: RuleSet, i: number) {
    return this.results()[r.id]?.[i] ?? null;
  }

  protected bracketError(i: number) {
    for (const k of ['lower', 'upper', 'fixedAmount', 'rate', 'excessOver']) {
      const e = this.action.field(`brackets.${i}.${k}`);
      if (e) return e;
    }
    return null;
  }

  protected caseError(i: number) {
    const details = this.action.error()?.details ?? [];
    const d = details.find((x) => x.path?.startsWith(`testCases.${i}.`));
    return d ? d.message : null;
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
    const plain = (v: string | null) => (v ? v.replace(/\.00$/, '') : '');
    this.f = r
      ? {
          code: r.code,
          name: r.name,
          currency: r.currency,
          validFrom: r.validFrom,
          validTo: r.validTo ?? '',
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
          testCases: r.testCases.map((c) => ({
            ...c,
            baseSalary: plain(c.baseSalary),
            allowancesSubject: plain(c.allowancesSubject),
            allowancesIrtOnly: plain(c.allowancesIrtOnly),
            allowancesExempt: plain(c.allowancesExempt),
            expectedInssEmployee: plain(c.expectedInssEmployee),
            expectedIrt: plain(c.expectedIrt),
            expectedInssEmployer: plain(c.expectedInssEmployer),
            expectedNet: plain(c.expectedNet),
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
      validTo: this.f.validTo || null,
      brackets: bracketsPayload(this.f.brackets),
      testCases: testCasesPayload(this.f.testCases),
    };
    const done = await this.action.run(() =>
      e
        ? this.api.patch(`hr/payroll/rule-sets/${e.id}`, { ...body, expectedVersion: e.version })
        : this.api.post('hr/payroll/rule-sets', body),
    );
    if (!done) return;
    this.opened.set(false);
    await this.load();
    this.toasts.show(
      e?.confirmedAt
        ? 'Regras guardadas: a confirmação anterior foi retirada.'
        : 'Regras guardadas em rascunho.',
    );
  }

  protected async verify(r: RuleSet) {
    try {
      const v = await this.api.post<{ total: number; passed: number; results: CaseResult[] }>(
        `hr/payroll/rule-sets/${r.id}/verify`,
        {},
      );
      this.results.update((m) => ({ ...m, [r.id]: v.results }));
      this.toasts.show(
        `${v.passed} de ${v.total} caso(s) passam.`,
        v.passed === v.total ? 'success' : 'error',
      );
    } catch (error) {
      this.toasts.show(ApiError.from(error).message, 'error');
    }
  }

  protected openSimulation(r: RuleSet) {
    this.action.error.set(null);
    this.simResult.set(null);
    this.simulating.set(r);
  }

  protected async runSimulation() {
    const r = this.simulating()!;
    const result = await this.action.run(() =>
      this.api.post<Simulation>(`hr/payroll/rule-sets/${r.id}/simulate`, this.sim),
    );
    if (result) this.simResult.set(result);
  }

  protected openConfirm(r: RuleSet) {
    this.action.error.set(null);
    this.confirmNote = '';
    this.confirmChecked = false;
    this.confirming.set(r);
  }

  protected async confirmRules() {
    const r = this.confirming()!;
    const done = await this.action.run(() =>
      this.api.post(`hr/payroll/rule-sets/${r.id}/confirm`, {
        note: this.confirmNote,
        expectedVersion: r.version,
      }),
    );
    if (!done) return;
    this.confirming.set(null);
    await this.load();
    this.toasts.show('Normas confirmadas.');
  }

  protected async publish(r: RuleSet) {
    const ok = await this.confirm.ask({
      title: 'Publicar regras',
      message: `Publicadas, as regras ${r.code} passam a ser usadas a partir de ${formatDate(r.validFrom)} e não se alteram.`,
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
