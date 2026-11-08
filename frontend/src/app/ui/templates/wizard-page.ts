import { Component, computed, input, model, output } from '@angular/core';
import { Icon } from '../icon';

export interface WizardStep {
  id: string;
  label: string;
}

/**
 * WizardPage: operação em passos (indicador de progresso, Anterior/Seguinte e Concluir no último). O conteúdo de cada
 * passo é do ecrã (`@switch` sobre o passo actual); `canAdvance` diz se o passo actual está completo. Concluir emite
 * `finish` uma só vez enquanto `busy`. Nada é gravado antes de Concluir.
 */
@Component({
  selector: 'app-wizard',
  imports: [Icon],
  template: `
    <section class="card" [attr.aria-label]="label()">
      <ol class="mb-4 flex flex-wrap gap-2" aria-label="Passos">
        @for (s of steps(); track s.id; let i = $index) {
          <li
            class="flex items-center gap-2 rounded-control px-2 py-1 text-sm"
            [class.bg-primary-soft]="i === step()"
            [class.text-on-primary-soft]="i === step()"
            [class.text-muted]="i > step()"
            [attr.aria-current]="i === step() ? 'step' : null"
          >
            <span
              class="flex size-6 items-center justify-center rounded-full border text-xs font-semibold"
              [class.border-primary]="i === step()"
              [class.border-border]="i !== step()"
            >
              @if (i < step()) {
                <app-icon name="check" [size]="12" />
              } @else {
                {{ i + 1 }}
              }
            </span>
            {{ s.label }}
            <span class="sr-only">{{
              i < step() ? '(concluído)' : i === step() ? '(actual)' : ''
            }}</span>
          </li>
        }
      </ol>
      <div data-testid="wizard-step" [attr.data-step]="steps()[step()]?.id">
        <ng-content />
      </div>
      <div class="mt-4 flex flex-wrap justify-between gap-2 border-t border-border pt-3">
        <button
          type="button"
          class="btn-secondary"
          [disabled]="step() === 0 || busy()"
          (click)="step.set(step() - 1)"
        >
          Anterior
        </button>
        @if (!last()) {
          <button
            type="button"
            class="btn-primary"
            [disabled]="!canAdvance() || busy()"
            (click)="step.set(step() + 1)"
          >
            Seguinte
          </button>
        } @else {
          <button
            type="button"
            [class]="danger() ? 'btn-danger' : 'btn-primary'"
            [disabled]="!canAdvance() || busy()"
            (click)="finish.emit()"
          >
            {{ busy() ? 'A processar…' : finishLabel() }}
          </button>
        }
      </div>
    </section>
  `,
})
export class Wizard {
  readonly steps = input.required<WizardStep[]>();
  readonly step = model(0);
  readonly canAdvance = input(true);
  readonly busy = input(false);
  readonly finishLabel = input('Concluir');
  readonly danger = input(false);
  readonly label = input('Assistente');
  readonly finish = output();
  protected readonly last = computed(() => this.step() === this.steps().length - 1);
}
