import { Component, effect, inject, input, signal, untracked } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { Breadcrumbs } from '../core/breadcrumbs';
import { formatDateTime } from '../ui/dates';
import { EntityFormPage } from '../ui/templates';
import { type SerialRow, sourceLink } from './lot-model';
import { BUCKET, POSTING_TYPE, sourceLabel } from './stock-model';

/** Série (8.8): o percurso completo da unidade — cada entrada e saída, com a origem e o lote. */
@Component({
  selector: 'app-serial-detail',
  imports: [RouterLink, EntityFormPage],
  template: `
    <app-entity-form-page
      [title]="s() ? 'Série ' + s()!.serial : 'Série'"
      [subtitle]="s() ? s()!.product.sku + ' — ' + s()!.product.name : ''"
      formId="serial-detail"
      [loading]="!s()"
      [loadError]="loadError()"
      [readOnly]="true"
      (cancelled)="back()"
      (retry)="load()"
    >
      @if (s(); as x) {
        <div class="card flex flex-wrap items-center gap-3" data-testid="serial-state">
          <span
            class="badge"
            [class]="
              x.status === 'IN_STOCK'
                ? 'bg-success-soft text-success-text'
                : 'bg-surface-2 text-muted'
            "
            >{{ x.status === 'IN_STOCK' ? 'Em stock' : 'Fora do stock' }}</span
          >
          @if (x.status === 'IN_STOCK') {
            <span class="text-sm text-muted"
              >{{ x.warehouse ?? 'Noutro armazém' }}{{ x.location ? ' · ' + x.location : '' }}</span
            >
          }
          @if (x.lot) {
            <a class="link text-sm" [routerLink]="['/inventario/lotes', x.lot.id]"
              >Lote {{ x.lot.code }}</a
            >
          }
        </div>
        <section class="card" aria-labelledby="sr-h">
          <h2 id="sr-h" class="mb-3 font-semibold">Percurso</h2>
          <div class="overflow-x-auto">
            <table class="w-full text-sm" data-testid="serial-history">
              <thead>
                <tr class="border-b border-border text-left text-muted">
                  <th class="py-2 pr-3">Data</th>
                  <th class="py-2 pr-3">Movimento</th>
                  <th class="py-2 pr-3">Origem</th>
                  <th class="py-2 pr-3">Onde</th>
                  <th class="py-2">Estado</th>
                </tr>
              </thead>
              <tbody>
                @for (h of x.history ?? []; track $index) {
                  <tr class="border-b border-border">
                    <td class="py-2 pr-3">{{ when(h.at) }}</td>
                    <td class="py-2 pr-3">
                      {{ h.direction === 'IN' ? 'Entra' : 'Sai' }} · {{ type(h.type) }}
                    </td>
                    <td class="py-2 pr-3">
                      @if (link(h.source); as l) {
                        <a class="link" [routerLink]="l">{{ source(h.source) }}</a>
                      } @else {
                        {{ source(h.source) }}
                      }
                    </td>
                    <td class="py-2 pr-3">
                      {{ h.warehouse }}{{ h.location ? ' · ' + h.location : '' }}
                    </td>
                    <td class="py-2">{{ bucket(h.bucket) }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>
      }
    </app-entity-form-page>
  `,
})
export class SerialDetailPage {
  readonly id = input<string | null>(null);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly breadcrumbs = inject(Breadcrumbs);
  protected readonly s = signal<SerialRow | null>(null);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly when = formatDateTime;
  protected readonly link = sourceLink;

  constructor() {
    effect(() => {
      this.id();
      untracked(() => void this.load());
    });
  }

  protected async load() {
    this.loadError.set(null);
    try {
      const x = await this.api.get<SerialRow>(`inventory/serials/${this.id()}`);
      this.s.set(x);
      this.breadcrumbs.setCurrent(x.serial);
    } catch (error) {
      this.loadError.set(ApiError.from(error));
    }
  }
  protected back() {
    void this.router.navigate(['/inventario/series']);
  }
  protected source(s: { type: string; ref: string | null }) {
    return sourceLabel(s);
  }
  protected type(t: string) {
    return POSTING_TYPE[t] ?? t;
  }
  protected bucket(b: string) {
    return BUCKET[b as keyof typeof BUCKET] ?? b;
  }
}
