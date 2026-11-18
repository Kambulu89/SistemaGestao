import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { Breadcrumbs } from '../core/breadcrumbs';
import { type HasUnsavedChanges, snapshot, warnOnUnload } from '../core/unsaved';
import { FieldControl, FormField, FormSection } from '../ui/form-field';
import { Icon } from '../ui/icon';
import { Action } from '../ui/load';
import { EntityFormPage } from '../ui/templates';
import { ToastService } from '../ui/toasts';
import { qty } from '../inventory/stock-model';
import type { DemandGroup } from './requisition-model';
import { isoToLocal, localToIso, plain, type Rfq, type RfqOptions } from './rfq-model';

interface LineForm {
  requisitionLineId: string;
  requisitionLabel: string;
  productId: string;
  description: string;
  uomId: string;
  quantity: string;
  specifications: string;
  neededBy: string;
}
const emptyLine = (): LineForm => ({
  requisitionLineId: '',
  requisitionLabel: '',
  productId: '',
  description: '',
  uomId: '',
  quantity: '1',
  specifications: '',
  neededBy: '',
});
const inDays = (n: number) => {
  const d = new Date(Date.now() + n * 86_400_000);
  d.setHours(17, 0, 0, 0);
  return isoToLocal(d.toISOString());
};

/**
 * Pedido de cotação em rascunho: entidade, título, especificações, prazo de resposta (data e hora), condições de
 * entrega e pagamento, moeda, envelope fechado, linhas (das requisições aprovadas com quantidade em aberto, do catálogo
 * ou livres) e, ao criar, os fornecedores homologados a convidar.
 */
@Component({
  selector: 'app-rfq-form',
  imports: [FormsModule, EntityFormPage, FormSection, FormField, FieldControl, Icon],
  template: `
    <app-entity-form-page
      [title]="isNew() ? 'Novo pedido de cotação' : 'Editar pedido de cotação'"
      subtitle="Fica em rascunho até ser emitido; depois só se revê com motivo."
      formId="rfq-form"
      [loading]="!loaded()"
      [loadError]="loadError()"
      [saveError]="action.error()"
      [busy]="action.busy()"
      [dirty]="hasUnsavedChanges()"
      [saveLabel]="isNew() ? 'Criar rascunho' : 'Guardar'"
      (save)="save()"
      (cancelled)="cancel()"
      (retry)="load()"
    >
      <app-form-section title="Pedido" description="O que se pede, a quem responde e até quando.">
        <app-field label="Entidade legal" [required]="true" [error]="action.field('legalEntityId')">
          <select
            appControl
            class="input"
            name="le"
            data-testid="qf-le"
            [disabled]="!isNew()"
            [(ngModel)]="f.legalEntityId"
            (ngModelChange)="leChanged()"
          >
            <option value="">Escolher…</option>
            @for (l of opts()?.legalEntities ?? []; track l.id) {
              <option [value]="l.id">{{ l.code }}</option>
            }
          </select>
        </app-field>
        <app-field label="Título" [required]="true" [error]="action.field('title')">
          <input
            appControl
            class="input"
            name="title"
            data-testid="qf-title"
            [(ngModel)]="f.title"
          />
        </app-field>
        <app-field
          label="Prazo de resposta"
          [required]="true"
          hint="Depois desta hora não se aceitam propostas."
          [error]="action.field('closesAt')"
        >
          <input
            appControl
            class="input w-60"
            type="datetime-local"
            name="closes"
            data-testid="qf-closes"
            [(ngModel)]="f.closesAt"
          />
        </app-field>
        <app-field
          label="Moeda"
          hint="Por omissão, a da entidade."
          [error]="action.field('currency')"
        >
          <input
            appControl
            class="input w-24"
            name="currency"
            maxlength="3"
            [disabled]="!isNew()"
            [(ngModel)]="f.currency"
          />
        </app-field>
        <app-field label="Condições de entrega" [error]="action.field('deliveryTerms')">
          <input appControl class="input" name="delivery" [(ngModel)]="f.deliveryTerms" />
        </app-field>
        <app-field label="Condições de pagamento" [error]="action.field('paymentTerms')">
          <input appControl class="input" name="payment" [(ngModel)]="f.paymentTerms" />
        </app-field>
        <app-field
          label="Especificações"
          class="sm:col-span-2"
          [error]="action.field('specifications')"
        >
          <textarea
            appControl
            class="input min-h-20"
            name="specs"
            data-testid="qf-specs"
            [(ngModel)]="f.specifications"
          ></textarea>
        </app-field>
        <label class="flex items-start gap-2 text-sm sm:col-span-2">
          <input type="checkbox" name="sealed" data-testid="qf-sealed" [(ngModel)]="f.sealed" />
          <span
            ><strong>Envelope fechado</strong> — os valores das propostas ficam ocultos para todos
            até à abertura, depois do prazo (ou quando todos os convidados responderem).</span
          >
        </label>
      </app-form-section>

      <app-form-section
        title="Linhas"
        description="Das requisições aprovadas (quantidade em aberto), do catálogo ou descrição livre."
      >
        <div class="space-y-3 sm:col-span-2">
          @if (demandLines().length) {
            <div class="flex flex-wrap items-end gap-2">
              <app-field label="Acrescentar da requisição">
                <select
                  appControl
                  class="input"
                  name="fromReq"
                  data-testid="qf-from-req"
                  [(ngModel)]="pick"
                >
                  <option value="">Escolher linha em aberto…</option>
                  @for (d of demandLines(); track d.lineId) {
                    <option [value]="d.lineId">{{ d.label }}</option>
                  }
                </select>
              </app-field>
              <button
                type="button"
                class="btn-secondary"
                data-testid="qf-add-req"
                [disabled]="!pick"
                (click)="addFromRequisition()"
              >
                Acrescentar
              </button>
            </div>
          }
          @for (l of f.lines; track $index; let i = $index) {
            <fieldset class="rounded border border-border p-3" [attr.data-testid]="'ql-' + i">
              <legend class="px-1 text-sm font-medium">
                Linha {{ i + 1 }}
                @if (l.requisitionLabel) {
                  <span class="text-muted">· {{ l.requisitionLabel }}</span>
                }
              </legend>
              <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                @if (!l.requisitionLineId) {
                  <app-field label="Produto" [error]="action.field('lines.' + i + '.productId')">
                    <select
                      appControl
                      class="input"
                      [name]="'prod' + i"
                      data-testid="ql-product"
                      [(ngModel)]="l.productId"
                      (ngModelChange)="productChanged(l)"
                    >
                      <option value="">Descrição livre</option>
                      @for (p of opts()?.products ?? []; track p.id) {
                        <option [value]="p.id">{{ p.sku }} — {{ p.name }}</option>
                      }
                    </select>
                  </app-field>
                }
                <app-field label="Descrição" [error]="action.field('lines.' + i + '.description')">
                  <input
                    appControl
                    class="input"
                    [name]="'desc' + i"
                    data-testid="ql-desc"
                    [(ngModel)]="l.description"
                  />
                </app-field>
                <app-field
                  label="Quantidade"
                  [required]="true"
                  [error]="action.field('lines.' + i + '.quantity')"
                >
                  <input
                    appControl
                    class="input"
                    inputmode="decimal"
                    [name]="'qty' + i"
                    data-testid="ql-qty"
                    [(ngModel)]="l.quantity"
                  />
                </app-field>
                @if (!l.requisitionLineId) {
                  <app-field label="Unidade" [error]="action.field('lines.' + i + '.uomId')">
                    <select appControl class="input" [name]="'uom' + i" [(ngModel)]="l.uomId">
                      <option value="">—</option>
                      @for (u of opts()?.uoms ?? []; track u.id) {
                        <option [value]="u.id">{{ u.code }}</option>
                      }
                    </select>
                  </app-field>
                }
                <app-field label="Entrega" [error]="action.field('lines.' + i + '.neededBy')">
                  <input
                    appControl
                    class="input"
                    type="date"
                    [name]="'need' + i"
                    [(ngModel)]="l.neededBy"
                  />
                </app-field>
                <app-field
                  label="Especificações da linha"
                  [error]="action.field('lines.' + i + '.specifications')"
                >
                  <input
                    appControl
                    class="input"
                    [name]="'lspec' + i"
                    [(ngModel)]="l.specifications"
                  />
                </app-field>
              </div>
              @if (action.field('lines.' + i + '.requisitionLineId'); as err) {
                <p class="mt-2 text-sm text-danger-text">{{ err }}</p>
              }
              @if (f.lines.length > 1) {
                <div class="mt-2 text-right text-sm">
                  <button type="button" class="link" (click)="f.lines.splice(i, 1)">
                    Remover linha
                  </button>
                </div>
              }
            </fieldset>
          }
          <button
            type="button"
            class="btn-secondary"
            data-testid="qf-add-line"
            (click)="f.lines.push(blank())"
          >
            <app-icon name="plus" [size]="16" />Acrescentar linha
          </button>
        </div>
      </app-form-section>

      @if (isNew()) {
        <app-form-section
          title="Fornecedores convidados"
          description="Só homologados com os documentos obrigatórios em dia. Pode convidar mais depois."
        >
          <div class="space-y-1 sm:col-span-2" data-testid="qf-suppliers">
            @for (s of opts()?.suppliers ?? []; track s.id) {
              <label class="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  [name]="'sup-' + s.id"
                  [ngModel]="invited.has(s.id)"
                  (ngModelChange)="toggle(s.id, $event)"
                />
                {{ s.code }} — {{ s.name }}
              </label>
            } @empty {
              <p class="text-sm text-muted">Não há fornecedores homologados.</p>
            }
            @if (action.field('supplierIds'); as err) {
              <p class="text-sm text-danger-text">{{ err }}</p>
            }
          </div>
        </app-form-section>
      }
    </app-entity-form-page>
  `,
})
export class RfqForm implements HasUnsavedChanges {
  readonly id = input<string | null>(null);
  /** Vindo das necessidades consolidadas: entidade e linhas de requisição (ids separados por vírgula). */
  readonly legalEntityId = input<string | null>(null);
  readonly requisitionLines = input<string | null>(null);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  protected readonly opts = signal<RfqOptions | null>(null);
  protected readonly demand = signal<DemandGroup[]>([]);
  protected readonly rfq = signal<Rfq | null>(null);
  protected readonly loaded = signal(false);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly action = new Action();
  protected readonly isNew = computed(() => !this.id() || this.id() === 'nova');
  protected readonly blank = emptyLine;
  protected f = this.empty();
  protected invited = new Set<string>();
  protected pick = '';
  private initial = snapshot(this.f);
  /** Linhas de requisição em aberto da entidade escolhida que ainda não estão no pedido. */
  protected readonly demandLines = computed(() => {
    this.tick();
    const used = new Set(this.f.lines.map((l) => l.requisitionLineId));
    return this.demand()
      .filter((g) => g.legalEntity.id === this.f.legalEntityId)
      .flatMap((g) =>
        g.lines
          .filter((l) => !used.has(l.lineId))
          .map((l) => ({
            lineId: l.lineId,
            open: l.open,
            group: g,
            label: `${l.number} · ${g.product ? g.product.sku + ' — ' : ''}${g.description} (${qty(l.open)} ${g.uom ?? ''})`,
          })),
      );
  });
  private readonly tick = signal(0);

  constructor() {
    warnOnUnload(this);
    void this.boot();
    effect(() => {
      this.id();
      untracked(() => void this.load());
    });
  }

  private async boot() {
    try {
      this.opts.set(await this.api.get<RfqOptions>('procurement/rfqs/options'));
    } catch (e) {
      this.loadError.set(ApiError.from(e));
      return;
    }
    // As necessidades só para quem trata requisições; sem permissão, o pedido faz-se à mão.
    try {
      this.demand.set(await this.api.get<DemandGroup[]>('procurement/requisitions/demand'));
    } catch {
      this.demand.set([]);
    }
    if (this.isNew()) this.prefill();
  }

  private empty() {
    return {
      legalEntityId: '',
      title: '',
      specifications: '',
      closesAt: inDays(7),
      deliveryTerms: '',
      paymentTerms: '',
      currency: '',
      sealed: true,
      lines: [emptyLine()] as LineForm[],
    };
  }

  /** Pré-preenche a partir das necessidades consolidadas (entidade e linhas escolhidas). */
  private prefill() {
    const le = this.legalEntityId();
    const ids = (this.requisitionLines() ?? '').split(',').filter(Boolean);
    if (!le && !ids.length) return;
    if (le) {
      this.f.legalEntityId = le;
      this.leChanged();
    }
    const lines = ids
      .map((id) => this.demandLines().find((d) => d.lineId === id))
      .filter((d) => !!d)
      .map((d) => this.fromDemand(d!));
    if (lines.length) {
      this.f.lines = lines;
      this.f.title ||= lines.length === 1 ? lines[0].description : `${lines.length} artigos`;
    }
    this.initial = snapshot(this.f);
    this.tick.update((n) => n + 1);
  }

  private fromDemand(d: {
    lineId: string;
    open: string;
    group: DemandGroup;
    label: string;
  }): LineForm {
    return {
      requisitionLineId: d.lineId,
      requisitionLabel: d.label.split(' · ')[0],
      productId: d.group.product?.id ?? '',
      description: d.group.description,
      uomId: '',
      quantity: plain(d.open),
      specifications: '',
      neededBy: '',
    };
  }

  hasUnsavedChanges() {
    return this.loaded() && snapshot(this.f) !== this.initial;
  }

  protected leChanged() {
    const l = this.opts()?.legalEntities.find((x) => x.id === this.f.legalEntityId);
    if (l) this.f.currency ||= l.currency;
    this.tick.update((n) => n + 1);
  }

  protected productChanged(l: LineForm) {
    const p = this.opts()?.products.find((x) => x.id === l.productId);
    if (!p) return;
    l.description = p.name;
    l.uomId = p.uomId;
  }

  protected toggle(id: string, on: boolean) {
    if (on) this.invited.add(id);
    else this.invited.delete(id);
  }

  protected addFromRequisition() {
    const d = this.demandLines().find((x) => x.lineId === this.pick);
    if (!d) return;
    const line = this.fromDemand(d);
    const only =
      this.f.lines.length === 1 && !this.f.lines[0].description && !this.f.lines[0].productId;
    if (only) this.f.lines = [line];
    else this.f.lines.push(line);
    this.pick = '';
    this.tick.update((n) => n + 1);
  }

  protected async load() {
    this.loadError.set(null);
    if (this.isNew()) {
      this.f = this.empty();
      this.initial = snapshot(this.f);
      this.loaded.set(true);
      if (this.opts()) this.prefill();
      return;
    }
    this.loaded.set(false);
    try {
      const r = await this.api.get<Rfq>(`procurement/rfqs/${this.id()}`);
      this.rfq.set(r);
      this.f = {
        legalEntityId: r.legalEntity.id,
        title: r.title,
        specifications: r.specifications ?? '',
        closesAt: isoToLocal(r.closesAt),
        deliveryTerms: r.deliveryTerms ?? '',
        paymentTerms: r.paymentTerms ?? '',
        currency: r.currency,
        sealed: r.sealed,
        lines: r.lines.map((l) => ({
          requisitionLineId: l.requisition?.lineId ?? '',
          requisitionLabel: l.requisition?.number ?? '',
          productId: l.product?.id ?? '',
          description: l.description,
          uomId: l.uom?.id ?? '',
          quantity: plain(l.quantity),
          specifications: l.specifications ?? '',
          neededBy: l.neededBy ?? '',
        })),
      };
      this.initial = snapshot(this.f);
      this.tick.update((n) => n + 1);
      this.breadcrumbs.setCurrent(r.number ?? 'Rascunho');
      this.loaded.set(true);
    } catch (error) {
      this.loadError.set(ApiError.from(error));
    }
  }

  protected async save() {
    const r = this.rfq();
    const t = (v: string) => v.trim() || null;
    const body = {
      legalEntityId: this.f.legalEntityId,
      title: this.f.title,
      specifications: t(this.f.specifications),
      closesAt: localToIso(this.f.closesAt),
      deliveryTerms: t(this.f.deliveryTerms),
      paymentTerms: t(this.f.paymentTerms),
      currency: this.f.currency.trim().toUpperCase() || undefined,
      sealed: this.f.sealed,
      lines: this.f.lines.map((l) => ({
        requisitionLineId: t(l.requisitionLineId),
        productId: t(l.productId),
        description: l.description.trim(),
        uomId: t(l.uomId),
        quantity: l.quantity.trim().replace(',', '.'),
        specifications: t(l.specifications),
        neededBy: t(l.neededBy),
      })),
      ...(r ? {} : { supplierIds: [...this.invited] }),
    };
    const saved = await this.action.run(() =>
      r
        ? this.api.put<Rfq>(`procurement/rfqs/${r.id}`, { ...body, expectedVersion: r.version })
        : this.api.post<Rfq>('procurement/rfqs', body),
    );
    if (!saved) return;
    this.initial = snapshot(this.f);
    this.toasts.show(r ? 'Pedido guardado.' : 'Rascunho criado.');
    await this.router.navigate(['/compras/cotacoes', saved.id], { replaceUrl: !r });
  }

  protected cancel() {
    const r = this.rfq();
    void this.router.navigate(r ? ['/compras/cotacoes', r.id] : ['/compras/cotacoes']);
  }
}
