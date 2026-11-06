import { Component, computed, input, model } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { type AllocationTarget, type Dimension, evenPercents, percentTotal } from './model';

/**
 * Editor de repartição (linhas de uma chave ou imputações de uma linha): percentagem, centro de custo e um valor por
 * dimensão activa. Mostra a soma e se chega a 100%; a validação final é do servidor.
 */
@Component({
  selector: 'app-allocation-editor',
  imports: [FormsModule],
  template: `
    <div class="overflow-x-auto">
      <table class="w-full min-w-[36rem] text-sm">
        <caption class="sr-only">
          {{
            label()
          }}
        </caption>
        <thead>
          <tr class="border-b border-border text-left">
            <th scope="col" class="p-2">%</th>
            <th scope="col" class="p-2">Centro de custo</th>
            @for (d of activeDimensions(); track d.id) {
              <th scope="col" class="p-2">{{ d.name }}</th>
            }
            <th scope="col" class="p-2"><span class="sr-only">Acções</span></th>
          </tr>
        </thead>
        <tbody>
          @for (t of targets(); track $index; let i = $index) {
            <tr class="border-b border-border">
              <td class="p-2">
                <input
                  class="input w-24 text-right"
                  inputmode="decimal"
                  [attr.aria-label]="'Percentagem do destino ' + (i + 1)"
                  [disabled]="disabled()"
                  [ngModel]="t.percent"
                  (ngModelChange)="update(i, { percent: $event })"
                />
              </td>
              <td class="p-2">
                <select
                  class="input"
                  [attr.aria-label]="'Centro de custo do destino ' + (i + 1)"
                  [disabled]="disabled()"
                  [ngModel]="t.costCenterId"
                  (ngModelChange)="update(i, { costCenterId: $event })"
                >
                  <option [ngValue]="null">—</option>
                  @for (c of costCenters(); track c.id) {
                    <option [ngValue]="c.id">{{ c.label }}</option>
                  }
                </select>
              </td>
              @for (d of activeDimensions(); track d.id) {
                <td class="p-2">
                  <select
                    class="input"
                    [attr.aria-label]="d.name + ' do destino ' + (i + 1)"
                    [disabled]="disabled()"
                    [ngModel]="valueOf(t, d.id)"
                    (ngModelChange)="setValue(i, d.id, $event)"
                  >
                    <option [ngValue]="null">—</option>
                    @for (v of d.values; track v.id) {
                      @if (v.status === 'ACTIVE' || v.id === valueOf(t, d.id)) {
                        <option [ngValue]="v.id">{{ v.code }} — {{ v.name }}</option>
                      }
                    }
                  </select>
                </td>
              }
              <td class="p-2">
                @if (!disabled()) {
                  <button
                    type="button"
                    class="btn-secondary"
                    [attr.aria-label]="'Remover destino ' + (i + 1)"
                    (click)="remove(i)"
                  >
                    ×
                  </button>
                }
              </td>
            </tr>
          }
        </tbody>
      </table>
    </div>
    <div class="mt-2 flex flex-wrap items-center gap-2 text-sm">
      @if (!disabled()) {
        <button type="button" class="btn-secondary" (click)="add()">Acrescentar destino</button>
        @if (targets().length > 1) {
          <button type="button" class="btn-secondary" (click)="even()">Repartir por igual</button>
        }
      }
      <span
        role="status"
        data-testid="percent-total"
        [class.text-success-text]="sum().complete"
        [class.text-warning-text]="!sum().complete"
      >
        Total: {{ sum().total }}%{{ sum().complete ? '' : ' (tem de ser 100%)' }}
      </span>
    </div>
  `,
})
export class AllocationEditor {
  readonly targets = model.required<AllocationTarget[]>();
  readonly dimensions = input<Dimension[]>([]);
  readonly costCenters = input<{ id: string; label: string }[]>([]);
  readonly disabled = input(false);
  readonly label = input('Repartição');
  protected readonly activeDimensions = computed(() =>
    this.dimensions().filter((d) => d.status === 'ACTIVE'),
  );
  protected readonly sum = computed(() => percentTotal(this.targets()));

  protected valueOf(t: AllocationTarget, dimensionId: string) {
    return t.values.find((v) => v.dimensionId === dimensionId)?.valueId ?? null;
  }

  protected update(i: number, patch: Partial<AllocationTarget>) {
    this.targets.update((list) => list.map((t, k) => (k === i ? { ...t, ...patch } : t)));
  }

  protected setValue(i: number, dimensionId: string, valueId: string | null) {
    this.targets.update((list) =>
      list.map((t, k) =>
        k !== i
          ? t
          : {
              ...t,
              values: [
                ...t.values.filter((v) => v.dimensionId !== dimensionId),
                ...(valueId ? [{ dimensionId, valueId }] : []),
              ],
            },
      ),
    );
  }

  protected add() {
    this.targets.update((list) => [...list, { percent: '', costCenterId: null, values: [] }]);
  }

  protected remove(i: number) {
    this.targets.update((list) => list.filter((_, k) => k !== i));
  }

  protected even() {
    const p = evenPercents(this.targets().length);
    this.targets.update((list) => list.map((t, i) => ({ ...t, percent: p[i] })));
  }
}
