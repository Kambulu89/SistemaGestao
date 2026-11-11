import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { Workspace } from '../core/workspace';
import { downloadText, toCsv } from '../ui/csv';
import { formatDate } from '../ui/dates';
import { Kpi } from '../ui/kpi';
import { Action } from '../ui/load';
import { Tabs, type TabItem } from '../ui/tabs';
import { ReportPage } from '../ui/templates/report-page';
import {
  type Alerts,
  classLabel,
  type ConsumptionReport,
  coverageText,
  defaultRange,
  type ExpiryRow,
  expiryText,
  type LossesReport,
  type MovementsReport,
  movementsCsv,
  REPLENISHMENT_STATUS,
  replenishmentCsv,
  type ReplenishmentRow,
  type ReplenishmentStatus,
  replenishmentTone,
  type TurnoverReport,
  turnoverText,
  type ValuedReport,
} from './report-model';
import { qty } from './stock-model';
import { money } from './valuation-model';

/**
 * Alertas e relatórios do inventário (8.11): contadores de ruptura, reposição e validade e os relatórios de reposição,
 * validade, rotação e cobertura, movimentos, perdas, consumo por centro de custo e inventário valorizado. Tudo é
 * calculado no servidor a partir do stock actual; os valores só aparecem a quem pode ver a valorização.
 */
@Component({
  selector: 'app-inventory-reports',
  imports: [FormsModule, RouterLink, ReportPage, Tabs, Kpi],
  template: `
    <div class="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold">Alertas e relatórios</h1>
        <p class="mt-1 text-sm text-muted">
          Calculados na hora a partir do stock, dos movimentos e do custo dos armazéns que pode
          consultar.
        </p>
      </div>
      <div>
        <label class="label" for="rp-wh">Armazém</label>
        <select
          id="rp-wh"
          name="warehouse"
          class="input w-56"
          data-testid="rp-wh"
          [ngModel]="warehouseId()"
          (ngModelChange)="setWarehouse($event)"
        >
          <option value="">Todos os que consulto</option>
          @for (w of warehouses(); track w.id) {
            <option [value]="w.id">{{ w.code }} · {{ w.name }}</option>
          }
        </select>
      </div>
    </div>

    <section
      class="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5"
      aria-label="Alertas"
      data-testid="rp-alerts"
    >
      <button type="button" class="text-left" (click)="openReplenishment('STOCKOUT')">
        <app-kpi
          label="Em ruptura"
          [value]="alerts()?.stockout ?? '—'"
          [tone]="tone(alerts()?.stockout, 'danger')"
          testId="al-stockout"
        />
      </button>
      <button type="button" class="text-left" (click)="openReplenishment('REORDER')">
        <app-kpi
          label="A repor"
          [value]="alerts()?.reorder ?? '—'"
          [tone]="tone(alerts()?.reorder, 'warning')"
          testId="al-reorder"
        />
      </button>
      <button type="button" class="text-left" (click)="openReplenishment('INCOMING')">
        <app-kpi
          label="Abaixo do mínimo, a caminho"
          [value]="alerts()?.incoming ?? '—'"
          testId="al-incoming"
        />
      </button>
      <button type="button" class="text-left" (click)="openExpiry()">
        <app-kpi
          label="Lotes expirados"
          [value]="alerts()?.expired ?? '—'"
          [tone]="tone(alerts()?.expired, 'danger')"
          testId="al-expired"
        />
      </button>
      <button type="button" class="text-left" (click)="openExpiry()">
        <app-kpi
          [label]="'A expirar em ' + days + ' dias'"
          [value]="alerts()?.expiring ?? '—'"
          [tone]="tone(alerts()?.expiring, 'warning')"
          testId="al-expiring"
        />
      </button>
    </section>

    <app-tabs label="Relatórios do inventário" [tabs]="tabs()" [(active)]="tab" />

    @if (tab() === 'replenishment') {
      <div
        role="tabpanel"
        id="panel-replenishment"
        aria-labelledby="tab-replenishment"
        class="mt-4"
      >
        <app-report-page
          title="Reposição e ruptura"
          subtitle="Disponível (livre − reservado) contra o mínimo do produto; a sugestão repõe até ao máximo, contando com o que vem a caminho."
          [busy]="action.busy()"
          [error]="action.error()"
          [hasResult]="!!rep()"
          [summary]="rep() ? rep()!.length + ' produto(s)' : null"
          (run)="runReplenishment()"
          (exported)="exportReplenishment()"
        >
          <div params>
            <label class="label" for="rp-status">Estado</label>
            <select
              id="rp-status"
              name="status"
              class="input w-48"
              data-testid="rp-status"
              [(ngModel)]="repStatus"
            >
              <option value="">Tudo o que precisa de atenção</option>
              @for (s of statuses; track s) {
                <option [value]="s">{{ statusLabel(s) }}</option>
              }
            </select>
          </div>
          @if (rep(); as rows) {
            <div class="card overflow-x-auto">
              <table class="w-full text-sm" data-testid="rp-replenishment">
                <thead>
                  <tr class="text-left text-muted">
                    <th class="px-2 py-1">Produto</th>
                    <th class="px-2 py-1">Estado</th>
                    <th class="whitespace-nowrap px-2 py-1 text-right">Mínimo</th>
                    <th class="whitespace-nowrap px-2 py-1 text-right">Máximo</th>
                    <th class="whitespace-nowrap px-2 py-1 text-right">Disponível</th>
                    <th class="whitespace-nowrap px-2 py-1 text-right">A caminho</th>
                    <th class="whitespace-nowrap px-2 py-1 text-right">Sugestão</th>
                  </tr>
                </thead>
                <tbody>
                  @for (r of rows; track r.product.id) {
                    <tr class="border-t border-border">
                      <td class="px-2 py-1">
                        <a class="link" [routerLink]="['/inventario/produtos', r.product.id]">{{
                          r.product.sku
                        }}</a>
                        <span class="block text-xs text-muted">{{ r.product.name }}</span>
                      </td>
                      <td class="px-2 py-1">
                        <span class="badge" [class]="repTone(r.status)">{{
                          statusLabel(r.status)
                        }}</span>
                      </td>
                      <td class="whitespace-nowrap px-2 py-1 text-right tabular-nums">
                        {{ q(r.min) }}
                      </td>
                      <td class="whitespace-nowrap px-2 py-1 text-right tabular-nums">
                        {{ q(r.max) }}
                      </td>
                      <td class="whitespace-nowrap px-2 py-1 text-right tabular-nums">
                        {{ q(r.available) }} {{ r.uom }}
                      </td>
                      <td class="whitespace-nowrap px-2 py-1 text-right tabular-nums">
                        {{ q(r.incoming) }}
                      </td>
                      <td class="whitespace-nowrap px-2 py-1 text-right font-medium tabular-nums">
                        {{ q(r.suggested) }}
                      </td>
                    </tr>
                  } @empty {
                    <tr>
                      <td colspan="7" class="px-2 py-3 text-muted">Nada a repor.</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </app-report-page>
      </div>
    }

    @if (tab() === 'expiry') {
      <div role="tabpanel" id="panel-expiry" aria-labelledby="tab-expiry" class="mt-4">
        <app-report-page
          title="Validade"
          subtitle="Lotes com stock físico que já expiraram ou expiram dentro do prazo indicado."
          [busy]="action.busy()"
          [error]="action.error()"
          [hasResult]="!!exp()"
          [summary]="exp() ? exp()!.length + ' lote(s) até ' + days + ' dias' : null"
          (run)="runExpiry()"
          (exported)="exportExpiry()"
        >
          <div params>
            <label class="label" for="rp-days">Dias</label>
            <input
              id="rp-days"
              name="days"
              type="number"
              min="0"
              max="730"
              class="input w-28"
              data-testid="rp-days"
              [(ngModel)]="days"
            />
          </div>
          @if (exp(); as rows) {
            <div class="card overflow-x-auto">
              <table class="w-full text-sm" data-testid="rp-expiry">
                <thead>
                  <tr class="text-left text-muted">
                    <th class="px-2 py-1">Lote</th>
                    <th class="px-2 py-1">Produto</th>
                    <th class="px-2 py-1">Armazém</th>
                    <th class="px-2 py-1">Validade</th>
                    <th class="whitespace-nowrap px-2 py-1 text-right">Quantidade</th>
                  </tr>
                </thead>
                <tbody>
                  @for (r of rows; track r.lot.id + r.warehouse.id) {
                    <tr class="border-t border-border">
                      <td class="px-2 py-1">
                        <a class="link" [routerLink]="['/inventario/lotes', r.lot.id]">{{
                          r.lot.code
                        }}</a>
                      </td>
                      <td class="px-2 py-1">
                        {{ r.variant?.sku ?? r.product.sku }}
                        <span class="text-muted">{{ r.product.name }}</span>
                      </td>
                      <td class="px-2 py-1">{{ r.warehouse.code }}</td>
                      <td class="px-2 py-1">
                        {{ date(r.expiryDate) }}
                        <span
                          class="badge ml-1"
                          [class]="
                            r.status === 'EXPIRED'
                              ? 'bg-danger-soft text-danger-text'
                              : 'bg-warning-soft text-warning-text'
                          "
                          >{{ expiry(r.daysLeft) }}</span
                        >
                      </td>
                      <td class="whitespace-nowrap px-2 py-1 text-right tabular-nums">
                        {{ q(r.quantity) }} {{ r.uom }}
                      </td>
                    </tr>
                  } @empty {
                    <tr>
                      <td colspan="5" class="px-2 py-3 text-muted">
                        Nenhum lote a expirar neste prazo.
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </app-report-page>
      </div>
    }

    @if (tab() === 'turnover') {
      <div role="tabpanel" id="panel-turnover" aria-labelledby="tab-turnover" class="mt-4">
        <app-report-page
          title="Rotação e cobertura"
          subtitle="Consumo (vendas, consumo interno, amostras e outras saídas) sobre o stock médio do período; a cobertura é o disponível ao ritmo desse consumo."
          [busy]="action.busy()"
          [error]="action.error()"
          [hasResult]="!!turn()"
          [summary]="turn() ? period(turn()!) : null"
          (run)="runTurnover()"
          (exported)="exportTurnover()"
        >
          <div params>
            <label class="label" for="tv-from">De</label>
            <input id="tv-from" name="from" type="date" class="input w-44" [(ngModel)]="from" />
          </div>
          <div params>
            <label class="label" for="tv-to">Até</label>
            <input id="tv-to" name="to" type="date" class="input w-44" [(ngModel)]="to" />
          </div>
          @if (turn(); as t) {
            <div class="card overflow-x-auto">
              <table class="w-full text-sm" data-testid="rp-turnover">
                <thead>
                  <tr class="text-left text-muted">
                    <th class="px-2 py-1">Produto</th>
                    <th class="whitespace-nowrap px-2 py-1 text-right">Abertura</th>
                    <th class="whitespace-nowrap px-2 py-1 text-right">Fecho</th>
                    <th class="whitespace-nowrap px-2 py-1 text-right">Consumo</th>
                    <th class="whitespace-nowrap px-2 py-1 text-right">Stock médio</th>
                    <th class="whitespace-nowrap px-2 py-1 text-right">Rotação</th>
                    <th class="whitespace-nowrap px-2 py-1 text-right">Disponível</th>
                    <th class="whitespace-nowrap px-2 py-1 text-right">Cobertura</th>
                  </tr>
                </thead>
                <tbody>
                  @for (r of t.rows; track r.product.id) {
                    <tr class="border-t border-border">
                      <td class="px-2 py-1">
                        {{ r.product.sku }} <span class="text-muted">{{ r.product.name }}</span>
                      </td>
                      <td class="whitespace-nowrap px-2 py-1 text-right tabular-nums">
                        {{ q(r.opening) }}
                      </td>
                      <td class="whitespace-nowrap px-2 py-1 text-right tabular-nums">
                        {{ q(r.closing) }}
                      </td>
                      <td class="whitespace-nowrap px-2 py-1 text-right tabular-nums">
                        {{ q(r.consumption) }}
                      </td>
                      <td class="whitespace-nowrap px-2 py-1 text-right tabular-nums">
                        {{ q(r.average) }}
                      </td>
                      <td class="whitespace-nowrap px-2 py-1 text-right font-medium tabular-nums">
                        {{ turnoverLabel(r.turnover) }}
                      </td>
                      <td class="whitespace-nowrap px-2 py-1 text-right tabular-nums">
                        {{ q(r.available) }} {{ r.uom }}
                      </td>
                      <td class="whitespace-nowrap px-2 py-1 text-right">
                        {{ coverage(r.coverageDays) }}
                      </td>
                    </tr>
                  } @empty {
                    <tr>
                      <td colspan="8" class="px-2 py-3 text-muted">
                        Sem stock nem movimentos no período.
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </app-report-page>
      </div>
    }

    @if (tab() === 'movements') {
      <div role="tabpanel" id="panel-movements" aria-labelledby="tab-movements" class="mt-4">
        <app-report-page
          title="Movimentos"
          subtitle="Entradas e saídas do período por produto e classe; os estornos anulam o movimento original."
          [busy]="action.busy()"
          [error]="action.error()"
          [hasResult]="!!mov()"
          [summary]="mov() ? period(mov()!) : null"
          (run)="runMovements()"
          (exported)="exportMovements()"
        >
          <div params>
            <label class="label" for="mv-from">De</label>
            <input id="mv-from" name="from" type="date" class="input w-44" [(ngModel)]="from" />
          </div>
          <div params>
            <label class="label" for="mv-to">Até</label>
            <input id="mv-to" name="to" type="date" class="input w-44" [(ngModel)]="to" />
          </div>
          @if (mov(); as m) {
            @if (!m.values) {
              <p class="mb-2 text-xs text-muted" data-testid="rp-novalues">
                Os valores não são mostrados: não tem acesso à valorização de todas as entidades
                destes armazéns.
              </p>
            } @else {
              <div class="mb-3 flex flex-wrap gap-2" data-testid="rp-mov-totals">
                @for (t of m.totals; track t.class) {
                  <span class="badge bg-surface-2 text-text"
                    >{{ cls(t.class) }}: {{ money(t.value) }}</span
                  >
                }
              </div>
            }
            <div class="card overflow-x-auto">
              <table class="w-full text-sm" data-testid="rp-movements">
                <thead>
                  <tr class="text-left text-muted">
                    <th class="px-2 py-1">Produto</th>
                    <th class="px-2 py-1">Classe</th>
                    <th class="whitespace-nowrap px-2 py-1 text-right">Entradas</th>
                    <th class="whitespace-nowrap px-2 py-1 text-right">Saídas</th>
                    <th class="whitespace-nowrap px-2 py-1 text-right">Valor</th>
                  </tr>
                </thead>
                <tbody>
                  @for (r of m.rows; track r.product.id + r.class) {
                    <tr class="border-t border-border">
                      <td class="px-2 py-1">
                        {{ r.product.sku }} <span class="text-muted">{{ r.product.name }}</span>
                      </td>
                      <td class="px-2 py-1">{{ cls(r.class) }}</td>
                      <td class="whitespace-nowrap px-2 py-1 text-right tabular-nums">
                        {{ zero(r.quantityIn) }}
                      </td>
                      <td class="whitespace-nowrap px-2 py-1 text-right tabular-nums">
                        {{ zero(r.quantityOut) }}
                      </td>
                      <td class="whitespace-nowrap px-2 py-1 text-right tabular-nums">
                        {{ money(r.value) }}
                      </td>
                    </tr>
                  } @empty {
                    <tr>
                      <td colspan="5" class="px-2 py-3 text-muted">Sem movimentos no período.</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </app-report-page>
      </div>
    }

    @if (tab() === 'losses') {
      <div role="tabpanel" id="panel-losses" aria-labelledby="tab-losses" class="mt-4">
        <app-report-page
          title="Perdas"
          subtitle="Quebras, perdas em trânsito e faltas de contagem; as sobras de contagem aparecem ao lado para o líquido."
          [busy]="action.busy()"
          [error]="action.error()"
          [hasResult]="!!loss()"
          [summary]="loss() ? period(loss()!) : null"
          (run)="runLosses()"
          (exported)="exportLosses()"
        >
          <div params>
            <label class="label" for="ls-from">De</label>
            <input id="ls-from" name="from" type="date" class="input w-44" [(ngModel)]="from" />
          </div>
          <div params>
            <label class="label" for="ls-to">Até</label>
            <input id="ls-to" name="to" type="date" class="input w-44" [(ngModel)]="to" />
          </div>
          @if (loss(); as l) {
            @if (l.totals; as t) {
              <div class="mb-4 grid gap-3 sm:grid-cols-3">
                <app-kpi
                  label="Perdas"
                  [value]="money(t.losses)"
                  tone="danger"
                  testId="ls-losses"
                />
                <app-kpi label="Sobras" [value]="money(t.gains)" testId="ls-gains" />
                <app-kpi label="Líquido" [value]="money(t.net)" testId="ls-net" />
              </div>
            }
            <div class="card overflow-x-auto">
              <table class="w-full text-sm" data-testid="rp-losses">
                <thead>
                  <tr class="text-left text-muted">
                    <th class="px-2 py-1">Produto</th>
                    <th class="px-2 py-1">Classe</th>
                    <th class="whitespace-nowrap px-2 py-1 text-right">Quantidade</th>
                    <th class="whitespace-nowrap px-2 py-1 text-right">Valor</th>
                  </tr>
                </thead>
                <tbody>
                  @for (r of l.rows; track r.product.id + r.class) {
                    <tr class="border-t border-border">
                      <td class="px-2 py-1">
                        {{ r.product.sku }} <span class="text-muted">{{ r.product.name }}</span>
                      </td>
                      <td class="px-2 py-1">{{ cls(r.class) }}</td>
                      <td class="whitespace-nowrap px-2 py-1 text-right tabular-nums">
                        {{ q(r.quantity) }} {{ r.uom }}
                      </td>
                      <td class="whitespace-nowrap px-2 py-1 text-right tabular-nums">
                        {{ money(r.value) }}
                      </td>
                    </tr>
                  } @empty {
                    <tr>
                      <td colspan="4" class="px-2 py-3 text-muted">Sem perdas no período.</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </app-report-page>
      </div>
    }

    @if (tab() === 'consumption') {
      <div role="tabpanel" id="panel-consumption" aria-labelledby="tab-consumption" class="mt-4">
        <app-report-page
          title="Consumo por centro de custo"
          subtitle="O que as requisições internas entregaram a cada centro de custo, ao custo de saída."
          [busy]="action.busy()"
          [error]="action.error()"
          [hasResult]="!!cons()"
          [summary]="cons() ? period(cons()!) : null"
          (run)="runConsumption()"
          (exported)="exportConsumption()"
        >
          <div params>
            <label class="label" for="cs-from">De</label>
            <input id="cs-from" name="from" type="date" class="input w-44" [(ngModel)]="from" />
          </div>
          <div params>
            <label class="label" for="cs-to">Até</label>
            <input id="cs-to" name="to" type="date" class="input w-44" [(ngModel)]="to" />
          </div>
          @if (cons(); as c) {
            @if (c.values) {
              <div class="mb-3 flex flex-wrap gap-2" data-testid="rp-cons-totals">
                @for (t of c.totals; track t.costCenter.id) {
                  <span class="badge bg-surface-2 text-text"
                    >{{ t.costCenter.code }} · {{ t.costCenter.name }}: {{ money(t.value) }}</span
                  >
                }
              </div>
            }
            <div class="card overflow-x-auto">
              <table class="w-full text-sm" data-testid="rp-consumption">
                <thead>
                  <tr class="text-left text-muted">
                    <th class="px-2 py-1">Centro de custo</th>
                    <th class="px-2 py-1">Produto</th>
                    <th class="whitespace-nowrap px-2 py-1 text-right">Quantidade</th>
                    <th class="whitespace-nowrap px-2 py-1 text-right">Valor</th>
                  </tr>
                </thead>
                <tbody>
                  @for (r of c.rows; track r.costCenter.id + r.product.id) {
                    <tr class="border-t border-border">
                      <td class="px-2 py-1">
                        {{ r.costCenter.code }}
                        <span class="text-muted">{{ r.costCenter.name }}</span>
                      </td>
                      <td class="px-2 py-1">
                        {{ r.product.sku }} <span class="text-muted">{{ r.product.name }}</span>
                      </td>
                      <td class="whitespace-nowrap px-2 py-1 text-right tabular-nums">
                        {{ q(r.quantity) }} {{ r.uom }}
                      </td>
                      <td class="whitespace-nowrap px-2 py-1 text-right tabular-nums">
                        {{ money(r.value) }}
                      </td>
                    </tr>
                  } @empty {
                    <tr>
                      <td colspan="4" class="px-2 py-3 text-muted">
                        Sem consumo por centro de custo no período.
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </app-report-page>
      </div>
    }

    @if (tab() === 'valued') {
      <div role="tabpanel" id="panel-valued" aria-labelledby="tab-valued" class="mt-4">
        <app-report-page
          title="Inventário valorizado"
          subtitle="Quantidade, custo unitário e valor por produto à data, pelo livro de custo da entidade legal."
          [busy]="action.busy()"
          [error]="action.error()"
          [canRun]="!!valLe"
          [hasResult]="!!val()"
          [summary]="val() ? val()!.legalEntity.code + ' em ' + date(val()!.date) : null"
          (run)="runValued()"
          (exported)="exportValued()"
        >
          <div params>
            <label class="label" for="vl-le">Entidade legal</label>
            <select id="vl-le" name="le" class="input w-56" data-testid="vl-le" [(ngModel)]="valLe">
              <option value="">Escolher…</option>
              @for (e of entities(); track e.id) {
                <option [value]="e.id">{{ e.code }}</option>
              }
            </select>
          </div>
          <div params>
            <label class="label" for="vl-date">Data</label>
            <input id="vl-date" name="date" type="date" class="input w-44" [(ngModel)]="valDate" />
          </div>
          @if (val(); as v) {
            <div class="mb-4 grid gap-3 sm:grid-cols-3">
              <app-kpi
                label="Valor do inventário"
                [value]="money(v.totals.value, v.currency)"
                testId="vl-total"
              />
              @for (c of v.totals.classes; track c.class) {
                <app-kpi [label]="c.class" [value]="money(c.value, v.currency)" />
              }
            </div>
            <div class="card overflow-x-auto">
              <table class="w-full text-sm" data-testid="rp-valued">
                <thead>
                  <tr class="text-left text-muted">
                    <th class="px-2 py-1">Produto</th>
                    <th class="px-2 py-1">Classe</th>
                    <th class="whitespace-nowrap px-2 py-1 text-right">Quantidade</th>
                    <th class="whitespace-nowrap px-2 py-1 text-right">Custo unitário</th>
                    <th class="whitespace-nowrap px-2 py-1 text-right">Valor</th>
                  </tr>
                </thead>
                <tbody>
                  @for (r of v.rows; track r.product.id + (r.variant?.id ?? '')) {
                    <tr class="border-t border-border">
                      <td class="px-2 py-1">
                        {{ r.variant?.sku ?? r.product.sku }}
                        <span class="text-muted">{{ r.product.name }}</span>
                      </td>
                      <td class="px-2 py-1">{{ r.class }}</td>
                      <td class="whitespace-nowrap px-2 py-1 text-right tabular-nums">
                        {{ q(r.quantity) }} {{ r.uom }}
                      </td>
                      <td class="whitespace-nowrap px-2 py-1 text-right tabular-nums">
                        {{ q(r.unitCost) }}
                      </td>
                      <td class="whitespace-nowrap px-2 py-1 text-right tabular-nums">
                        {{ money(r.value) }}
                      </td>
                    </tr>
                  } @empty {
                    <tr>
                      <td colspan="5" class="px-2 py-3 text-muted">
                        Sem stock valorizado nesta data.
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </app-report-page>
      </div>
    }
  `,
})
export class InventoryReports {
  private readonly api = inject(Api);
  private readonly workspace = inject(Workspace);
  protected readonly action = new Action();
  private readonly canValue = computed(() => this.workspace.canAny('inventory.valuation.read'));
  protected readonly tabs = computed<TabItem[]>(() => [
    { id: 'replenishment', label: 'Reposição e ruptura' },
    { id: 'expiry', label: 'Validade' },
    { id: 'turnover', label: 'Rotação e cobertura' },
    { id: 'movements', label: 'Movimentos' },
    { id: 'losses', label: 'Perdas' },
    { id: 'consumption', label: 'Consumo por centro de custo' },
    ...(this.canValue() ? [{ id: 'valued', label: 'Inventário valorizado' }] : []),
  ]);
  protected readonly tab = signal('replenishment');
  protected readonly warehouses = signal<{ id: string; code: string; name: string }[]>([]);
  protected readonly entities = signal<{ id: string; code: string }[]>([]);
  protected readonly warehouseId = signal('');
  protected readonly alerts = signal<Alerts | null>(null);
  protected readonly rep = signal<ReplenishmentRow[] | null>(null);
  protected readonly exp = signal<ExpiryRow[] | null>(null);
  protected readonly turn = signal<TurnoverReport | null>(null);
  protected readonly mov = signal<MovementsReport | null>(null);
  protected readonly loss = signal<LossesReport | null>(null);
  protected readonly cons = signal<ConsumptionReport | null>(null);
  protected readonly val = signal<ValuedReport | null>(null);
  protected readonly statuses: ReplenishmentStatus[] = ['STOCKOUT', 'REORDER', 'INCOMING', 'OK'];
  protected repStatus: ReplenishmentStatus | '' = '';
  protected days = 30;
  protected from = defaultRange().from;
  protected to = defaultRange().to;
  protected valLe = '';
  protected valDate = defaultRange().to;
  protected readonly q = qty;
  protected readonly money = money;
  protected readonly date = formatDate;
  protected readonly cls = classLabel;
  protected readonly expiry = expiryText;
  protected readonly coverage = coverageText;
  protected readonly turnoverLabel = turnoverText;
  protected readonly repTone = replenishmentTone;
  protected readonly statusLabel = (s: ReplenishmentStatus) => REPLENISHMENT_STATUS[s];
  protected readonly zero = (v: string) => (/^0+(\.0+)?$/.test(v) ? '—' : qty(v));
  protected readonly period = (r: { from: string; to: string }) =>
    `${formatDate(r.from)} a ${formatDate(r.to)}`;
  protected readonly tone = (n: number | undefined, t: 'danger' | 'warning') =>
    n ? t : ('neutral' as const);

  constructor() {
    this.api
      .get<{ id: string; code: string; name: string }[]>('inventory/warehouses', { limit: 200 })
      .then(
        (w) => this.warehouses.set(w),
        () => undefined,
      );
    if (this.canValue())
      this.api
        .get<{ id: string; code: string }[]>('organization/legal-entities', { limit: 200 })
        .then(
          (e) => {
            this.entities.set(e);
            const current = this.workspace.legalEntityId();
            this.valLe = current ?? (e.length === 1 ? e[0].id : '');
          },
          () => undefined,
        );
    this.loadAlerts();
    void this.runReplenishment();
  }

  private scope(extra: Record<string, unknown> = {}) {
    const w = this.warehouseId();
    return { ...extra, ...(w ? { warehouseId: w } : {}) };
  }

  private loadAlerts() {
    this.api.get<Alerts>('inventory/reports/alerts', this.scope({ days: this.days })).then(
      (a) => this.alerts.set(a),
      () => this.alerts.set(null),
    );
  }

  protected setWarehouse(id: string) {
    this.warehouseId.set(id);
    for (const s of [this.exp, this.turn, this.mov, this.loss, this.cons]) s.set(null as never);
    this.loadAlerts();
    void this.runReplenishment();
  }

  protected openReplenishment(status: ReplenishmentStatus) {
    this.repStatus = status;
    this.tab.set('replenishment');
    void this.runReplenishment();
  }

  protected openExpiry() {
    this.tab.set('expiry');
    void this.runExpiry();
  }

  protected async runReplenishment() {
    const r = await this.action.run(() =>
      this.api.get<ReplenishmentRow[]>(
        'inventory/reports/replenishment',
        this.scope(this.repStatus ? { status: this.repStatus } : {}),
      ),
    );
    if (r) this.rep.set(r);
  }

  protected async runExpiry() {
    const r = await this.action.run(() =>
      this.api.get<ExpiryRow[]>('inventory/reports/expiry', this.scope({ days: this.days })),
    );
    if (r) {
      this.exp.set(r);
      this.loadAlerts();
    }
  }

  private range() {
    return this.scope({ from: this.from, to: this.to });
  }

  protected async runTurnover() {
    const r = await this.action.run(() =>
      this.api.get<TurnoverReport>('inventory/reports/turnover', this.range()),
    );
    if (r) this.turn.set(r);
  }

  protected async runMovements() {
    const r = await this.action.run(() =>
      this.api.get<MovementsReport>('inventory/reports/movements', this.range()),
    );
    if (r) this.mov.set(r);
  }

  protected async runLosses() {
    const r = await this.action.run(() =>
      this.api.get<LossesReport>('inventory/reports/losses', this.range()),
    );
    if (r) this.loss.set(r);
  }

  protected async runConsumption() {
    const r = await this.action.run(() =>
      this.api.get<ConsumptionReport>('inventory/reports/consumption', this.range()),
    );
    if (r) this.cons.set(r);
  }

  protected async runValued() {
    const r = await this.action.run(() =>
      this.api.get<ValuedReport>('inventory/reports/valued', {
        legalEntityId: this.valLe,
        date: this.valDate,
      }),
    );
    if (r) this.val.set(r);
  }

  protected exportReplenishment() {
    const { headers, rows } = replenishmentCsv(this.rep()!);
    downloadText('reposicao.csv', toCsv(headers, rows));
  }

  protected exportExpiry() {
    downloadText(
      `validade-${this.days}-dias.csv`,
      toCsv(
        ['Lote', 'SKU', 'Produto', 'Armazém', 'Validade', 'Dias', 'Quantidade', 'Unidade'],
        this.exp()!.map((r) => [
          r.lot.code,
          r.variant?.sku ?? r.product.sku,
          r.product.name,
          r.warehouse.code,
          r.expiryDate,
          r.daysLeft,
          r.quantity,
          r.uom,
        ]),
      ),
    );
  }

  protected exportTurnover() {
    const t = this.turn()!;
    downloadText(
      `rotacao-${t.from}-${t.to}.csv`,
      toCsv(
        [
          'SKU',
          'Produto',
          'Unidade',
          'Abertura',
          'Fecho',
          'Consumo',
          'Stock médio',
          'Rotação',
          'Disponível',
          'Cobertura (dias)',
        ],
        t.rows.map((r) => [
          r.product.sku,
          r.product.name,
          r.uom,
          r.opening,
          r.closing,
          r.consumption,
          r.average,
          r.turnover ?? '',
          r.available,
          r.coverageDays ?? '',
        ]),
      ),
    );
  }

  protected exportMovements() {
    const m = this.mov()!;
    const { headers, rows } = movementsCsv(m);
    downloadText(`movimentos-${m.from}-${m.to}.csv`, toCsv(headers, rows));
  }

  protected exportLosses() {
    const l = this.loss()!;
    downloadText(
      `perdas-${l.from}-${l.to}.csv`,
      toCsv(
        ['SKU', 'Produto', 'Unidade', 'Classe', 'Quantidade', 'Valor'],
        l.rows.map((r) => [
          r.product.sku,
          r.product.name,
          r.uom,
          classLabel(r.class),
          r.quantity,
          r.value ?? '',
        ]),
      ),
    );
  }

  protected exportConsumption() {
    const c = this.cons()!;
    downloadText(
      `consumo-centro-custo-${c.from}-${c.to}.csv`,
      toCsv(
        ['Centro de custo', 'Nome', 'SKU', 'Produto', 'Unidade', 'Quantidade', 'Valor'],
        c.rows.map((r) => [
          r.costCenter.code,
          r.costCenter.name,
          r.product.sku,
          r.product.name,
          r.uom,
          r.quantity,
          r.value ?? '',
        ]),
      ),
    );
  }

  protected exportValued() {
    const v = this.val()!;
    downloadText(
      `inventario-valorizado-${v.legalEntity.code}-${v.date}.csv`,
      toCsv(
        ['SKU', 'Produto', 'Classe', 'Unidade', 'Quantidade', 'Custo unitário', 'Valor'],
        [
          ...v.rows.map((r) => [
            r.variant?.sku ?? r.product.sku,
            r.product.name,
            r.class,
            r.uom,
            r.quantity,
            r.unitCost,
            r.value,
          ]),
          ['Total', '', '', '', '', '', v.totals.value],
        ],
      ),
    );
  }
}
