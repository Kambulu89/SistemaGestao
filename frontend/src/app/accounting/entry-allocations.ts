import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ErrorAlert } from '../ui/error-alert';
import { Action } from '../ui/load';
import { ToastService } from '../ui/toasts';
import { AllocationEditor } from './allocation-editor';
import {
  type AllocationKey,
  type AllocationTarget,
  type Dimension,
  type EntryLine,
  normalizeAmount,
  percentTotal,
} from './model';
import { accountingDeps } from './shared';

/**
 * Imputação analítica das linhas de um lançamento (também depois de contabilizado: não mexe no razão). Sem imputação,
 * a linha conta 100% para o seu centro de custo.
 */
@Component({
  selector: 'app-entry-allocations',
  imports: [FormsModule, ErrorAlert, AllocationEditor],
  template: `
    <section class="card space-y-3" aria-labelledby="alloc-title">
      <h2 id="alloc-title" class="font-semibold">Imputação analítica</h2>
      <p class="text-xs text-muted">
        Reparte o valor de cada linha por centros de custo e dimensões (100%). Não altera o
        lançamento.
      </p>
      <ul class="divide-y divide-border text-sm" data-testid="allocations">
        @for (l of lines(); track $index; let i = $index) {
          <li class="flex flex-wrap items-center justify-between gap-2 py-2">
            <span>
              <span class="font-mono">{{ i + 1 }}. {{ l.accountCode }}</span> {{ l.accountName }}
              <span class="text-muted">— {{ summary(i + 1) }}</span>
            </span>
            @if (canEdit()) {
              <button
                type="button"
                class="btn-secondary"
                [attr.aria-label]="'Imputar linha ' + (i + 1)"
                (click)="open(i + 1)"
              >
                Imputar
              </button>
            }
          </li>
        }
      </ul>
      @if (editingLine(); as n) {
        <form
          class="space-y-3 border-t border-border pt-3"
          (ngSubmit)="save()"
          [attr.aria-label]="'Imputação da linha ' + n"
        >
          <div class="flex flex-wrap items-end gap-2">
            <h3 class="font-medium">Linha {{ n }}</h3>
            @if (keys().length) {
              <label class="label ml-auto" for="alloc-key">Chave</label>
              <select id="alloc-key" name="key" class="input w-56" [(ngModel)]="keyId">
                <option [ngValue]="null">—</option>
                @for (k of keys(); track k.id) {
                  <option [ngValue]="k.id">{{ k.code }} — {{ k.name }}</option>
                }
              </select>
              <button
                type="button"
                class="btn-secondary"
                [disabled]="!keyId || action.busy()"
                (click)="applyKey()"
              >
                Aplicar chave
              </button>
            }
          </div>
          <app-allocation-editor
            [label]="'Imputação da linha ' + n"
            [(targets)]="targets"
            [dimensions]="dimensions()"
            [costCenters]="costCenters()"
          />
          <app-error-alert [error]="action.error()" [showDetails]="true" />
          <div class="flex gap-2">
            <button
              type="submit"
              class="btn-primary"
              [disabled]="action.busy() || (targets().length > 0 && !complete())"
            >
              Guardar imputação
            </button>
            <button type="button" class="btn-secondary" (click)="editingLine.set(null)">
              Fechar
            </button>
          </div>
        </form>
      }
    </section>
  `,
})
export class EntryAllocations {
  readonly entryId = input.required<string>();
  readonly legalEntityId = input.required<string>();
  readonly lines = input.required<EntryLine[]>();
  readonly costCenters = input<{ id: string; label: string }[]>([]);
  private readonly deps = accountingDeps();
  private readonly toasts = inject(ToastService);
  protected readonly canEdit = computed(() => this.deps.workspace.can('accounting.analytics'));
  protected readonly allocations = signal<AllocationTarget[]>([]);
  protected readonly dimensions = signal<Dimension[]>([]);
  protected readonly keys = signal<AllocationKey[]>([]);
  protected readonly editingLine = signal<number | null>(null);
  protected readonly targets = signal<AllocationTarget[]>([]);
  protected readonly complete = computed(() => percentTotal(this.targets()).complete);
  protected readonly action = new Action();
  protected keyId: string | null = null;
  private readonly names = computed(() => new Map(this.costCenters().map((c) => [c.id, c.label])));

  constructor() {
    effect(() => {
      const id = this.entryId();
      const le = this.legalEntityId();
      untracked(() => void this.load(id, le));
    });
  }

  private async load(id: string, legalEntityId: string) {
    this.editingLine.set(null);
    this.allocations.set(
      await this.deps.api
        .get<AllocationTarget[]>(`accounting/entries/${id}/allocations`)
        .catch(() => []),
    );
    this.dimensions.set(
      (
        await this.deps.api
          .page<Dimension>('accounting/dimensions', { limit: 200 })
          .catch(() => ({ items: [] }))
      ).items,
    );
    this.keys.set(
      (
        await this.deps.api
          .page<AllocationKey>('accounting/allocation-keys', {
            legalEntityId,
            status: 'ACTIVE',
            limit: 200,
          })
          .catch(() => ({ items: [] }))
      ).items,
    );
  }

  protected summary(lineNo: number) {
    const list = this.allocations().filter((a) => a.lineNo === lineNo);
    if (list.length === 0) {
      const cc = this.lines()[lineNo - 1]?.costCenterId;
      return cc ? `100% ${this.names().get(cc) ?? 'centro da linha'}` : 'sem imputação';
    }
    return list
      .map(
        (a) =>
          `${a.percent}% ${[a.costCenterId ? (this.names().get(a.costCenterId) ?? 'centro') : '', ...a.values.map((v) => v.valueCode)].filter(Boolean).join(' / ')}`,
      )
      .join(' · ');
  }

  protected open(lineNo: number) {
    this.action.error.set(null);
    this.keyId = null;
    this.editingLine.set(lineNo);
    const current = this.allocations().filter((a) => a.lineNo === lineNo);
    this.targets.set(
      current.length
        ? current.map((a) => ({ ...a }))
        : [{ percent: '100', costCenterId: null, values: [] }],
    );
  }

  private async put(body: Record<string, unknown>) {
    const n = this.editingLine()!;
    const result = await this.action.run(() =>
      this.deps.api.put<AllocationTarget[]>(
        `accounting/entries/${this.entryId()}/lines/${n}/allocations`,
        body,
      ),
    );
    if (!result) return;
    this.allocations.set(result);
    this.editingLine.set(null);
    this.toasts.show(`Imputação da linha ${n} guardada.`);
  }

  protected applyKey() {
    return this.put({ keyId: this.keyId });
  }

  protected save() {
    return this.put({
      allocations: this.targets().map((t) => ({
        percent: normalizeAmount(t.percent),
        costCenterId: t.costCenterId,
        values: t.values.map((v) => ({ dimensionId: v.dimensionId, valueId: v.valueId })),
      })),
    });
  }
}
