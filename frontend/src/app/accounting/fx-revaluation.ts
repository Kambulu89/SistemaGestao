import { Component, inject, signal, computed } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ConfirmService } from '../ui/confirm';
import { formatDate } from '../ui/dates';
import { ErrorAlert } from '../ui/error-alert';
import { Action, Loadable } from '../ui/load';
import { PageHeader } from '../ui/page-header';
import { ToastService } from '../ui/toasts';
import type { FxPreview, FxRevaluation } from './model';
import { accountingDeps, entityReferences, legalEntityOptions, moneyText } from './shared';

interface Option {
  id: string;
  label: string;
}

const GAIN_LOSS = [
  ['unrealizedGainAccountId', 'Ganhos não realizados'],
  ['unrealizedLossAccountId', 'Perdas não realizadas'],
  ['realizedGainAccountId', 'Ganhos realizados'],
  ['realizedLossAccountId', 'Perdas realizadas'],
] as const;
type GainLossKey = (typeof GAIN_LOSS)[number][0];

/**
 * Diferenças cambiais: actualiza ao câmbio da data os saldos em moeda estrangeira das contas escolhidas (não
 * realizadas) e regista o resíduo dos saldos já liquidados (realizadas). Gera um rascunho para aprovar.
 */
@Component({
  selector: 'app-fx-revaluation',
  imports: [FormsModule, RouterLink, PageHeader, ErrorAlert],
  template: `
    <app-page-header
      title="Diferenças cambiais"
      subtitle="Actualização dos saldos em moeda estrangeira ao câmbio da data e diferenças realizadas na liquidação."
    />
    <form class="card mb-4 space-y-3" (ngSubmit)="preview()" aria-label="Diferenças cambiais">
      <div class="flex flex-wrap items-end gap-2">
        <div>
          <label class="label" for="fx-le">Entidade legal</label>
          <select
            id="fx-le"
            name="le"
            class="input w-64"
            [(ngModel)]="legalEntityId"
            (ngModelChange)="entityChanged()"
          >
            @for (e of entities(); track e.id) {
              <option [ngValue]="e.id">{{ e.label }}</option>
            }
          </select>
        </div>
        <div>
          <label class="label" for="fx-date">Data</label>
          <input
            id="fx-date"
            name="date"
            type="date"
            class="input w-44"
            [(ngModel)]="date"
            (ngModelChange)="result.set(null)"
          />
        </div>
        <div>
          <label class="label" for="fx-journal">Diário</label>
          <select id="fx-journal" name="journal" class="input w-56" [(ngModel)]="journalId">
            <option [ngValue]="null">—</option>
            @for (j of journals(); track j.id) {
              <option [ngValue]="j.id">{{ j.label }}</option>
            }
          </select>
        </div>
      </div>
      <fieldset>
        <legend class="label">Contas a actualizar (itens monetários em moeda estrangeira)</legend>
        <div class="grid max-h-48 gap-1 overflow-y-auto text-sm sm:grid-cols-2 lg:grid-cols-3">
          @for (a of accounts(); track a.id) {
            <label class="flex items-center gap-2">
              <input
                type="checkbox"
                [name]="'acc-' + a.id"
                [ngModel]="chosen().has(a.id)"
                (ngModelChange)="toggle(a.id, $event)"
              />
              {{ a.label }}
            </label>
          }
        </div>
      </fieldset>
      <div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        @for (g of gainLoss; track g[0]) {
          <div>
            <label class="label" [for]="'fx-' + g[0]">{{ g[1] }}</label>
            <select class="input" [id]="'fx-' + g[0]" [name]="g[0]" [(ngModel)]="targets[g[0]]">
              <option [ngValue]="null">—</option>
              @for (a of accounts(); track a.id) {
                <option [ngValue]="a.id">{{ a.label }}</option>
              }
            </select>
          </div>
        }
      </div>
      <div class="flex gap-2">
        <button
          type="submit"
          class="btn-secondary"
          [disabled]="action.busy() || chosen().size === 0"
        >
          Simular
        </button>
        @if (canRun()) {
          <button type="button" class="btn-primary" [disabled]="action.busy()" (click)="run()">
            Gerar rascunho
          </button>
        }
      </div>
      <app-error-alert [error]="action.error()" [showDetails]="true" />
    </form>

    @if (result(); as r) {
      <section class="card mb-4" aria-labelledby="fx-result">
        <h2 id="fx-result" class="mb-2 font-semibold">Resultado em {{ date }}</h2>
        @if (r.missingRates.length) {
          <p class="mb-2 text-sm text-danger-text" role="alert">
            Sem câmbio para {{ r.missingRates.join(', ') }}→{{ r.functionalCurrency }} nesta data:
            registe-o em Configurações → Câmbios.
          </p>
        }
        @if (r.pendingRevaluation) {
          <p class="mb-2 text-sm text-danger-text" role="alert">
            A actualização de {{ r.pendingRevaluation }} ainda não está contabilizada.
          </p>
        }
        @if (r.entryId) {
          <p class="mb-2 text-sm" role="status" data-testid="fx-status">
            Rascunho criado:
            <a class="btn-link" [routerLink]="['/contabilidade/lancamentos', r.entryId]"
              >abrir o lançamento</a
            >
            para submeter e aprovar.
          </p>
        }
        @if (r.lines.length === 0) {
          <p class="text-sm text-muted" role="status">Não há diferenças cambiais nesta data.</p>
        } @else {
          <div class="overflow-x-auto">
            <table class="w-full min-w-[48rem] text-sm">
              <caption class="sr-only">
                Diferenças cambiais por saldo
              </caption>
              <thead>
                <tr class="border-b border-border text-left">
                  <th scope="col" class="p-2">Conta</th>
                  <th scope="col" class="p-2">Moeda / terceiro</th>
                  <th scope="col" class="p-2">Tipo</th>
                  <th scope="col" class="p-2 text-right">Saldo em moeda</th>
                  <th scope="col" class="p-2 text-right">Câmbio</th>
                  <th scope="col" class="p-2 text-right">Funcional antes</th>
                  <th scope="col" class="p-2 text-right">Funcional depois</th>
                  <th scope="col" class="p-2 text-right">Diferença</th>
                </tr>
              </thead>
              <tbody>
                @for (l of r.lines; track l.accountId + l.currency + l.thirdPartyRef + l.kind) {
                  <tr class="border-b border-border">
                    <td class="p-2">{{ l.accountCode }} — {{ l.accountName }}</td>
                    <td class="p-2">
                      {{ l.currency }}{{ l.thirdPartyRef ? ' · ' + l.thirdPartyRef : '' }}
                    </td>
                    <td class="p-2">{{ l.kind === 'REALIZED' ? 'Realizada' : 'Não realizada' }}</td>
                    <td class="p-2 text-right">{{ money(l.foreignBalance) }}</td>
                    <td class="p-2 text-right">{{ l.rate ?? '—' }}</td>
                    <td class="p-2 text-right">{{ money(l.functionalBefore) }}</td>
                    <td class="p-2 text-right">{{ money(l.functionalAfter) }}</td>
                    <td class="p-2 text-right">{{ money(l.difference) }}</td>
                  </tr>
                }
              </tbody>
              <tfoot>
                <tr class="font-semibold" data-testid="fx-totals">
                  <th scope="row" colspan="7" class="p-2 text-left">
                    Ganhos {{ money(r.gains) }} · perdas {{ money(r.losses) }}
                  </th>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>
        }
      </section>
    }

    <section class="card" aria-labelledby="fx-history">
      <h2 id="fx-history" class="mb-2 font-semibold">Actualizações anteriores</h2>
      @if (history.value()?.length) {
        <ul class="divide-y divide-border text-sm">
          @for (h of history.value(); track h.id) {
            <li class="flex flex-wrap justify-between gap-2 py-1">
              <span
                >{{ day(h.date) }} · {{ h.lines }} saldo(s) · ganhos {{ money(h.gains) }} · perdas
                {{ money(h.losses) }}
                @if (h.reversed) {
                  (estornada)
                }
              </span>
              <a class="btn-link" [routerLink]="['/contabilidade/lancamentos', h.entryId]">{{
                h.entryNumber ?? 'rascunho'
              }}</a>
            </li>
          }
        </ul>
      } @else {
        <p class="text-sm text-muted">Sem actualizações nesta entidade.</p>
      }
    </section>
  `,
})
export class FxRevaluationPage {
  private readonly deps = accountingDeps();
  private readonly toasts = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  protected readonly gainLoss = GAIN_LOSS;
  protected readonly canRun = computed(() => this.deps.workspace.can('accounting.adjustments'));
  protected readonly entities = signal<Option[]>([]);
  protected readonly journals = signal<Option[]>([]);
  protected readonly accounts = signal<Option[]>([]);
  protected readonly chosen = signal<ReadonlySet<string>>(new Set());
  protected readonly result = signal<FxPreview | null>(null);
  protected readonly action = new Action();
  protected legalEntityId: string | null = null;
  protected date = new Date().toISOString().slice(0, 10);
  protected journalId: string | null = null;
  protected targets: Record<GainLossKey, string | null> = {
    unrealizedGainAccountId: null,
    unrealizedLossAccountId: null,
    realizedGainAccountId: null,
    realizedLossAccountId: null,
  };
  private refRequest = 0;
  protected readonly history = new Loadable(() =>
    this.legalEntityId
      ? this.deps.api.get<FxRevaluation[]>('accounting/fx-revaluations', {
          legalEntityId: this.legalEntityId,
        })
      : Promise.resolve([]),
  );

  constructor() {
    void (async () => {
      this.entities.set(
        await legalEntityOptions(this.deps.api, this.deps.workspace).catch(() => []),
      );
      this.legalEntityId = this.deps.workspace.legalEntityId() ?? this.entities()[0]?.id ?? null;
      await this.entityChanged();
    })();
  }

  protected money(v: string) {
    return moneyText(v);
  }
  protected day(v: string) {
    return formatDate(v);
  }

  protected toggle(id: string, on: boolean) {
    const next = new Set(this.chosen());
    if (on) next.add(id);
    else next.delete(id);
    this.chosen.set(next);
    this.result.set(null);
  }

  protected async entityChanged() {
    this.result.set(null);
    this.chosen.set(new Set());
    this.journals.set([]);
    this.accounts.set([]);
    const le = this.legalEntityId;
    const request = ++this.refRequest;
    if (!le) return;
    const refs = await entityReferences(this.deps.api, this.deps.workspace, le);
    if (request !== this.refRequest) return;
    this.journals.set(refs.journals);
    this.accounts.set(refs.accounts);
    this.journalId = refs.journals.length === 1 ? refs.journals[0].id : null;
    await this.history.load();
  }

  private query() {
    return { legalEntityId: this.legalEntityId, date: this.date, accountIds: [...this.chosen()] };
  }

  protected async preview() {
    const q = this.query();
    const r = await this.action.run(() =>
      this.deps.api.get<FxPreview>('accounting/fx-revaluations/preview', {
        ...q,
        accountIds: q.accountIds.join(','),
      }),
    );
    this.result.set(r ?? null);
  }

  protected async run() {
    const ok = await this.confirm.ask({
      title: 'Gerar rascunho',
      message: `Gerar o rascunho das diferenças cambiais em ${this.date}? Fica em rascunho para submeter e aprovar.`,
      confirmLabel: 'Gerar',
    });
    if (!ok) return;
    const r = await this.action.run(() =>
      this.deps.api.post<FxPreview>('accounting/fx-revaluations', {
        ...this.query(),
        journalId: this.journalId,
        ...this.targets,
      }),
    );
    if (!r) return;
    this.result.set(r);
    this.toasts.show('Rascunho das diferenças cambiais criado.');
    await this.history.load();
  }
}
