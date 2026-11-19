import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { type HasUnsavedChanges, snapshot, warnOnUnload } from '../core/unsaved';
import { FieldControl, FormField, FormSection } from '../ui/form-field';
import { Action } from '../ui/load';
import { EntityFormPage } from '../ui/templates';
import { ToastService } from '../ui/toasts';
import { plain } from './rfq-model';
import type { Tolerances } from './invoice-model';

/** Tolerâncias da conferência de facturas (procurement.settings). */
@Component({
  selector: 'app-tolerances',
  imports: [FormsModule, EntityFormPage, FormSection, FormField, FieldControl],
  template: `
    <app-entity-form-page
      title="Tolerâncias da conferência"
      subtitle="Diferenças aceites sem excepção ao validar facturas de fornecedor."
      formId="tolerances-form"
      [loading]="!loaded()"
      [loadError]="loadError()"
      [saveError]="action.error()"
      [busy]="action.busy()"
      [dirty]="hasUnsavedChanges()"
      saveLabel="Guardar"
      (save)="save()"
      (cancelled)="back()"
      (retry)="load()"
    >
      <app-form-section
        title="Preço"
        description="Preço unitário líquido acima do da ordem: basta cumprir uma das duas."
      >
        <app-field label="Percentagem (%)" [error]="action.field('pricePct')">
          <input
            appControl
            class="input w-32"
            inputmode="decimal"
            name="pp"
            data-testid="tl-price-pct"
            [(ngModel)]="f.pricePct"
          />
        </app-field>
        <app-field label="Valor por linha" [error]="action.field('priceAmount')">
          <input
            appControl
            class="input w-40"
            inputmode="decimal"
            name="pa"
            [(ngModel)]="f.priceAmount"
          />
        </app-field>
      </app-form-section>
      <app-form-section title="Quantidade e total">
        <app-field label="Quantidade acima do recebido (%)" [error]="action.field('qtyPct')">
          <input
            appControl
            class="input w-32"
            inputmode="decimal"
            name="qp"
            [(ngModel)]="f.qtyPct"
          />
        </app-field>
        <app-field label="Diferença do total declarado" [error]="action.field('totalAmount')">
          <input
            appControl
            class="input w-40"
            inputmode="decimal"
            name="ta"
            data-testid="tl-total"
            [(ngModel)]="f.totalAmount"
          />
        </app-field>
      </app-form-section>
    </app-entity-form-page>
  `,
})
export class ToleranceSettings implements HasUnsavedChanges {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  protected readonly loaded = signal(false);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly action = new Action();
  protected f: Tolerances = { pricePct: '0', priceAmount: '0', qtyPct: '0', totalAmount: '0' };
  private initial = snapshot(this.f);

  constructor() {
    warnOnUnload(this);
    void this.load();
  }

  hasUnsavedChanges() {
    return this.loaded() && snapshot(this.f) !== this.initial;
  }

  protected async load() {
    this.loadError.set(null);
    try {
      const t = await this.api.get<Tolerances>('procurement/tolerances');
      this.f = {
        pricePct: plain(t.pricePct),
        priceAmount: plain(t.priceAmount),
        qtyPct: plain(t.qtyPct),
        totalAmount: plain(t.totalAmount),
      };
      this.initial = snapshot(this.f);
      this.loaded.set(true);
    } catch (e) {
      this.loadError.set(ApiError.from(e));
    }
  }

  protected async save() {
    const n = (v: string) => v.trim().replace(',', '.') || '0';
    const r = await this.action.run(() =>
      this.api.put<Tolerances>('procurement/tolerances', {
        pricePct: n(this.f.pricePct),
        priceAmount: n(this.f.priceAmount),
        qtyPct: n(this.f.qtyPct),
        totalAmount: n(this.f.totalAmount),
      }),
    );
    if (!r) return;
    this.initial = snapshot(this.f);
    this.toasts.show('Tolerâncias guardadas.');
  }

  protected back() {
    void this.router.navigate(['/compras/configuracao']);
  }
}
