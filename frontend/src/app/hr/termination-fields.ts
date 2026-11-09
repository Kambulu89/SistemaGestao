import { Component, input } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { FieldControl, FormField } from '../ui/form-field';
import type { Action } from '../ui/load';
import { TERMINATION_REASON, type TerminationReason } from './termination-model';

/** Campos da cessação (criar e editar). Sem valores legais pré-preenchidos: a empresa indica-os com a fonte. */
export interface TerminationForm {
  reason: TerminationReason;
  details: string;
  disciplinaryCaseId: string;
  noticeGivenOn: string;
  lastWorkingDay: string;
  noticeRequiredDays: string;
  noticeBasis: string;
  indemnityApplicable: boolean;
  indemnityBasis: string;
}

export function emptyTerminationForm(): TerminationForm {
  return {
    reason: 'RESIGNATION',
    details: '',
    disciplinaryCaseId: '',
    noticeGivenOn: '',
    lastWorkingDay: '',
    noticeRequiredDays: '',
    noticeBasis: '',
    indemnityApplicable: false,
    indemnityBasis: '',
  };
}

/** Corpo para a API: vazios → `null`, dias como inteiro. */
export function terminationPayload(f: TerminationForm): Record<string, unknown> {
  const days = f.noticeRequiredDays.trim();
  return {
    reason: f.reason,
    details: f.details,
    disciplinaryCaseId: f.reason === 'DISMISSAL_DISCIPLINARY' ? f.disciplinaryCaseId || null : null,
    noticeGivenOn: f.noticeGivenOn || null,
    lastWorkingDay: f.lastWorkingDay || null,
    noticeRequiredDays: days === '' ? null : /^\d+$/.test(days) ? Number(days) : days,
    noticeBasis: days === '' ? null : f.noticeBasis || null,
    indemnityApplicable: f.indemnityApplicable,
    indemnityBasis: f.indemnityApplicable ? f.indemnityBasis || null : null,
  };
}

@Component({
  selector: 'app-termination-fields',
  imports: [FormsModule, FormField, FieldControl],
  template: `
    @let f = form();
    <div class="space-y-3">
      <app-field label="Motivo" [required]="true" [error]="action().field('reason')">
        <select
          appControl
          class="input"
          data-testid="tf-reason"
          [(ngModel)]="f.reason"
          [ngModelOptions]="{ standalone: true }"
        >
          @for (r of reasons; track r[0]) {
            <option [value]="r[0]">{{ r[1] }}</option>
          }
        </select>
      </app-field>
      @if (f.reason === 'DISMISSAL_DISCIPLINARY') {
        <app-field
          label="Processo disciplinar"
          [required]="true"
          hint="Tem de estar encerrado com decisão de despedimento antes da submissão."
          [error]="action().field('disciplinaryCaseId')"
        >
          <select
            appControl
            class="input"
            data-testid="tf-case"
            [(ngModel)]="f.disciplinaryCaseId"
            [ngModelOptions]="{ standalone: true }"
          >
            <option value="">—</option>
            @for (c of cases(); track c.id) {
              <option [value]="c.id">{{ c.label }}</option>
            }
          </select>
        </app-field>
      }
      <app-field label="Descrição" [required]="true" [error]="action().field('details')">
        <textarea
          appControl
          class="input min-h-20"
          data-testid="tf-details"
          [(ngModel)]="f.details"
          [ngModelOptions]="{ standalone: true }"
        ></textarea>
      </app-field>
      <div class="grid gap-3 sm:grid-cols-2">
        <app-field
          label="Data do aviso prévio"
          hint="Quando foi comunicada a cessação."
          [error]="action().field('noticeGivenOn')"
        >
          <input
            appControl
            class="input"
            type="date"
            data-testid="tf-notice-on"
            [(ngModel)]="f.noticeGivenOn"
            [ngModelOptions]="{ standalone: true }"
          />
        </app-field>
        <app-field
          label="Último dia de trabalho"
          [required]="true"
          [error]="action().field('lastWorkingDay')"
        >
          <input
            appControl
            class="input"
            type="date"
            data-testid="tf-last-day"
            [(ngModel)]="f.lastWorkingDay"
            [ngModelOptions]="{ standalone: true }"
          />
        </app-field>
      </div>
      <div class="grid gap-3 sm:grid-cols-2">
        <app-field
          label="Dias de aviso exigidos"
          hint="Indique só se aplicável, com a fonte."
          [error]="action().field('noticeRequiredDays')"
        >
          <input
            appControl
            class="input"
            inputmode="numeric"
            data-testid="tf-notice-days"
            [(ngModel)]="f.noticeRequiredDays"
            [ngModelOptions]="{ standalone: true }"
          />
        </app-field>
        @if (f.noticeRequiredDays.trim()) {
          <app-field
            label="Fonte dos dias de aviso"
            [required]="true"
            hint="Contrato, lei ou convenção aplicável."
            [error]="action().field('noticeBasis')"
          >
            <input
              appControl
              class="input"
              data-testid="tf-notice-basis"
              [(ngModel)]="f.noticeBasis"
              [ngModelOptions]="{ standalone: true }"
            />
          </app-field>
        }
      </div>
      <label class="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          data-testid="tf-indemnity"
          [(ngModel)]="f.indemnityApplicable"
          [ngModelOptions]="{ standalone: true }"
        />
        Há indemnização aplicável
      </label>
      @if (f.indemnityApplicable) {
        <app-field
          label="Base legal e critério da indemnização"
          [required]="true"
          hint="A empresa confirma a norma em vigor; o sistema não calcula indemnizações."
          [error]="action().field('indemnityBasis')"
        >
          <textarea
            appControl
            class="input min-h-16"
            data-testid="tf-indemnity-basis"
            [(ngModel)]="f.indemnityBasis"
            [ngModelOptions]="{ standalone: true }"
          ></textarea>
        </app-field>
      }
    </div>
  `,
})
export class TerminationFields {
  readonly form = input.required<TerminationForm>();
  readonly action = input.required<Action>();
  readonly cases = input<{ id: string; label: string }[]>([]);
  protected readonly reasons = Object.entries(TERMINATION_REASON);
}
