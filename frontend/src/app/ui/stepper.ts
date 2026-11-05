import { Component, input } from '@angular/core';
import { Icon } from './icon';

export interface StepItem {
  label: string;
  detail?: string | null;
  state: 'done' | 'current' | 'pending' | 'failed';
}

/** Progresso por etapas (ex.: etapas de aprovação). A etapa actual leva `aria-current="step"`. */
@Component({
  selector: 'app-stepper',
  imports: [Icon],
  template: `
    <ol class="space-y-3" [attr.aria-label]="label()">
      @for (s of steps(); track $index; let i = $index) {
        <li class="flex gap-3" [attr.aria-current]="s.state === 'current' ? 'step' : null">
          <span
            class="flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold"
            [class]="tone(s.state)"
          >
            @if (s.state === 'done') {
              <app-icon name="check" [size]="14" />
            } @else if (s.state === 'failed') {
              <app-icon name="close" [size]="14" />
            } @else {
              {{ i + 1 }}
            }
          </span>
          <div class="min-w-0 text-sm">
            <p class="font-medium">
              {{ s.label }}
              <span class="sr-only">— {{ stateLabel(s.state) }}</span>
            </p>
            @if (s.detail) {
              <p class="text-xs text-muted">{{ s.detail }}</p>
            }
            <ng-content />
          </div>
        </li>
      }
    </ol>
  `,
})
export class Stepper {
  readonly steps = input.required<StepItem[]>();
  readonly label = input('Etapas');

  protected tone(state: StepItem['state']) {
    const base =
      'flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold ';
    if (state === 'done') return base + 'border-transparent bg-success-soft text-success-text';
    if (state === 'current') return base + 'border-primary bg-primary-soft text-on-primary-soft';
    if (state === 'failed') return base + 'border-transparent bg-danger-soft text-danger-text';
    return base + 'border-border text-muted';
  }

  protected stateLabel(state: StepItem['state']) {
    return { done: 'concluída', current: 'em curso', pending: 'por iniciar', failed: 'rejeitada' }[
      state
    ];
  }
}
