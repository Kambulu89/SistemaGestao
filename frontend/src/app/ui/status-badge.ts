import { Component, computed, input } from '@angular/core';
import { statusLabel, statusTone } from './labels';

@Component({
  selector: 'app-status-badge',
  template: `<span class="badge" [class]="tone()">{{ label() }}</span>`,
})
export class StatusBadge {
  readonly status = input<string | null>(null);
  protected readonly label = computed(() => statusLabel(this.status()));
  protected readonly tone = computed(() => 'badge ' + statusTone(this.status()));
}
