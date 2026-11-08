import { Component, input } from '@angular/core';
import { formatDateTime } from './dates';
import { Icon } from './icon';

export interface TimelineEvent {
  at: string;
  title: string;
  detail?: string | null;
  tone: 'neutral' | 'success' | 'danger' | 'warning';
}

/**
 * ApprovalTimeline: acontecimentos por ordem cronológica (pedido, decisões, conclusão), com hora, autor e comentário.
 * O tom é sempre acompanhado de texto ("Aprovado", "Rejeitado"…), nunca só cor.
 */
@Component({
  selector: 'app-approval-timeline',
  imports: [Icon],
  template: `
    <ol class="relative space-y-4 border-l border-border pl-5" [attr.aria-label]="label()">
      @for (e of events(); track $index) {
        <li class="relative">
          <span
            class="absolute top-0.5 -left-[1.95rem] flex size-6 items-center justify-center rounded-full border-2 border-surface"
            [class]="dot(e.tone)"
            aria-hidden="true"
          >
            <app-icon [name]="icon(e.tone)" [size]="12" />
          </span>
          <p class="text-sm font-medium">{{ e.title }}</p>
          <p class="text-xs text-muted">
            <time [attr.datetime]="e.at">{{ when(e.at) }}</time>
          </p>
          @if (e.detail) {
            <p class="mt-1 text-sm whitespace-pre-line">{{ e.detail }}</p>
          }
        </li>
      } @empty {
        <li class="text-sm text-muted">Sem acontecimentos.</li>
      }
    </ol>
  `,
})
export class ApprovalTimeline {
  readonly events = input.required<TimelineEvent[]>();
  readonly label = input('Histórico do pedido');
  protected readonly when = formatDateTime;

  protected dot(tone: TimelineEvent['tone']) {
    return {
      neutral: 'bg-primary-soft text-on-primary-soft',
      success: 'bg-success-soft text-success-text',
      danger: 'bg-danger-soft text-danger-text',
      warning: 'bg-warning-soft text-warning-text',
    }[tone];
  }

  protected icon(tone: TimelineEvent['tone']) {
    return { neutral: 'plus', success: 'check', danger: 'close', warning: 'clock' }[tone];
  }
}
