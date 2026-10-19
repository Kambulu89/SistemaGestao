import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { Icon } from '../icon/icon';

export type AlertTone = 'info' | 'success' | 'warning' | 'danger';

const TONES: Record<AlertTone, { box: string; icon: string }> = {
  info: {
    box: 'border-brand-200 bg-brand-50 text-brand-900 dark:border-brand-800 dark:bg-brand-950 dark:text-brand-100',
    icon: 'info',
  },
  success: {
    box: 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-100',
    icon: 'check',
  },
  warning: {
    box: 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100',
    icon: 'warning',
  },
  danger: {
    box: 'border-red-200 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-100',
    icon: 'warning',
  },
};

@Component({
  selector: 'app-alert',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class]': 'classes()',
    '[attr.role]': 'tone() === "danger" ? "alert" : "status"',
  },
  template: `
    <app-icon [name]="icon()" class="mt-0.5" />
    <div class="min-w-0 text-sm">
      @if (title(); as title) {
        <p class="font-semibold">{{ title }}</p>
      }
      <ng-content />
    </div>
  `,
})
export class Alert {
  readonly tone = input<AlertTone>('info');
  readonly title = input<string>();

  protected readonly icon = computed(() => TONES[this.tone()].icon);
  protected readonly classes = computed(
    () => `flex gap-3 rounded-lg border p-3 ${TONES[this.tone()].box}`,
  );
}
