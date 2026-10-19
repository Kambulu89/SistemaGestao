import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  selector: 'app-spinner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'inline-flex size-5 shrink-0 animate-spin', 'aria-hidden': 'true' },
  template: `
    <svg viewBox="0 0 24 24" fill="none" class="size-full">
      <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="3" class="opacity-25" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        stroke-width="3"
        stroke-linecap="round"
      />
    </svg>
  `,
})
export class Spinner {}
