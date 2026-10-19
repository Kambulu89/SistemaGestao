import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { Spinner } from '../spinner/spinner';

@Component({
  selector: 'app-loading-state',
  imports: [Spinner],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'flex items-center justify-center gap-3 px-6 py-12 text-fg-muted',
    role: 'status',
  },
  template: `<app-spinner /><span class="text-sm">{{ label() }}</span>`,
})
export class LoadingState {
  readonly label = input('A carregar…');
}
