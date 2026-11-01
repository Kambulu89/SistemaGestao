import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

let next = 0;

/**
 * Data e hora «de parede», tal como se escrevem, sem as converter para o fuso do browser: o servidor guarda instantes,
 * mas a hora de um evento só faz sentido no fuso do próprio evento, que é este componente que o formulário respeita.
 */
@Component({
  selector: 'app-wall-clock',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <label class="mb-1.5 block text-sm font-medium" [for]="id">{{ label() }}</label>
    <input
      [id]="id"
      [type]="kind()"
      [value]="value()"
      class="block h-10 w-full rounded-lg border border-line bg-surface px-3 text-sm text-fg"
      (input)="changed.emit($any($event.target).value)"
    />
  `,
})
export class WallClockInput {
  protected readonly id = `wall-clock-${next++}`;
  readonly label = input.required<string>();
  readonly value = input('');
  readonly kind = input<'datetime-local' | 'date'>('datetime-local');
  readonly changed = output<string>();
}
