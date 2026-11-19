import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api } from '../core/api';
import { formatDate } from '../ui/dates';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField } from '../ui/form-field';
import { Icon } from '../ui/icon';
import { Action } from '../ui/load';
import { Modal } from '../ui/modal';
import { ToastService } from '../ui/toasts';
import {
  ONBOARDING_CATEGORY,
  ONBOARDING_STATUS,
  type OnboardingCategory,
  type OnboardingTask,
  onboardingProgress,
  tone,
} from './recruitment-model';

interface OnboardingList {
  items: OnboardingTask[];
  done: number;
  total: number;
  canManage: boolean;
}

/** Checklist de onboarding na ficha do colaborador (documentos, conta, acessos, equipamentos). */
@Component({
  selector: 'app-onboarding-card',
  imports: [FormsModule, FormField, FieldControl, Modal, ErrorAlert, Icon],
  template: `
    @if (data(); as d) {
      @if (d.total || d.canManage) {
        <section class="card" aria-labelledby="onb-title" data-testid="onboarding">
          <div class="mb-2 flex items-center justify-between gap-2">
            <h2 id="onb-title" class="font-semibold">Onboarding</h2>
            @if (d.canManage) {
              <button
                type="button"
                class="btn-ghost px-2"
                aria-label="Adicionar tarefa de onboarding"
                (click)="openNew()"
              >
                <app-icon name="plus" [size]="16" />
              </button>
            }
          </div>
          @if (d.total) {
            <p class="mb-2 text-sm text-muted" data-testid="onb-progress">
              {{ progress().done }} de {{ progress().total }} concluídas
            </p>
            <div
              class="mb-3 h-2 overflow-hidden rounded-full bg-surface-2"
              role="progressbar"
              aria-label="Progresso do onboarding"
              [attr.aria-valuenow]="progress().percent"
              aria-valuemin="0"
              aria-valuemax="100"
            >
              <div class="h-full bg-primary" [style.width.%]="progress().percent"></div>
            </div>
            <ul class="space-y-2 text-sm">
              @for (t of d.items; track t.id) {
                <li class="flex items-start justify-between gap-2" data-testid="onb-task">
                  <div class="min-w-0">
                    <p class="font-medium" [class.line-through]="t.status !== 'PENDING'">
                      {{ t.title }}
                    </p>
                    <p class="text-xs text-muted">
                      {{ category(t.category) }}{{ t.dueDate ? ' · até ' + date(t.dueDate) : ''
                      }}{{ t.assignee ? ' · ' + t.assignee.name : '' }}
                    </p>
                  </div>
                  @if (d.canManage) {
                    <select
                      class="input w-36 text-xs"
                      [attr.aria-label]="'Estado de ' + t.title"
                      [ngModel]="t.status"
                      [ngModelOptions]="{ standalone: true }"
                      (ngModelChange)="setStatus(t, $event)"
                    >
                      @for (s of statuses; track s[0]) {
                        <option [ngValue]="s[0]">{{ s[1] }}</option>
                      }
                    </select>
                  } @else {
                    <span class="badge" [class]="tone(t.status)">{{ statusLabel(t.status) }}</span>
                  }
                </li>
              }
            </ul>
          } @else {
            <p class="text-sm text-muted">Sem tarefas de onboarding.</p>
          }
        </section>
      }
    }

    <app-modal title="Nova tarefa de onboarding" [open]="adding()" (closed)="adding.set(false)">
      <app-error-alert [error]="action.error()" [showDetails]="false" />
      <div class="space-y-3">
        <app-field label="Categoria" [required]="true">
          <select
            appControl
            class="input"
            [(ngModel)]="draft.category"
            [ngModelOptions]="{ standalone: true }"
          >
            @for (c of categories; track c[0]) {
              <option [ngValue]="c[0]">{{ c[1] }}</option>
            }
          </select>
        </app-field>
        <app-field label="Tarefa" [required]="true" [error]="action.field('title')">
          <input
            appControl
            class="input"
            data-testid="onb-title-input"
            [(ngModel)]="draft.title"
            [ngModelOptions]="{ standalone: true }"
          />
        </app-field>
        <app-field label="Prazo" [error]="action.field('dueDate')">
          <input
            appControl
            class="input"
            type="date"
            [(ngModel)]="draft.dueDate"
            [ngModelOptions]="{ standalone: true }"
          />
        </app-field>
      </div>
      <ng-container actions>
        <button type="button" class="btn-secondary" (click)="adding.set(false)">Cancelar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="onb-add"
          [disabled]="action.busy()"
          (click)="add()"
        >
          Adicionar
        </button>
      </ng-container>
    </app-modal>
  `,
})
export class OnboardingCard {
  readonly employeeId = input.required<string>();
  private readonly api = inject(Api);
  private readonly toasts = inject(ToastService);
  protected readonly data = signal<OnboardingList | null>(null);
  protected readonly action = new Action();
  protected readonly adding = signal(false);
  protected readonly date = formatDate;
  protected readonly tone = tone;
  protected readonly category = (c: OnboardingCategory) => ONBOARDING_CATEGORY[c];
  protected readonly statusLabel = (s: OnboardingTask['status']) => ONBOARDING_STATUS[s];
  protected readonly categories = Object.entries(ONBOARDING_CATEGORY);
  protected readonly statuses = Object.entries(ONBOARDING_STATUS);
  protected readonly progress = computed(() => onboardingProgress(this.data()?.items ?? []));
  protected draft = { category: 'DOCUMENTS' as OnboardingCategory, title: '', dueDate: '' };

  constructor() {
    effect(() => {
      const id = this.employeeId();
      untracked(() => void this.load(id));
    });
  }

  private async load(id: string) {
    try {
      this.data.set(await this.api.get<OnboardingList>(`hr/employees/${id}/onboarding`));
    } catch {
      this.data.set(null);
    }
  }

  protected async setStatus(t: OnboardingTask, status: OnboardingTask['status']) {
    const done = await this.action.run(() =>
      this.api.patch(`hr/onboarding-tasks/${t.id}`, { status, expectedVersion: t.version }),
    );
    if (!done) this.toasts.show(this.action.error()?.message ?? 'Erro.', 'error');
    await this.load(this.employeeId());
  }

  protected openNew() {
    this.action.error.set(null);
    this.draft = { category: 'DOCUMENTS', title: '', dueDate: '' };
    this.adding.set(true);
  }

  protected async add() {
    const done = await this.action.run(() =>
      this.api.post(`hr/employees/${this.employeeId()}/onboarding`, {
        category: this.draft.category,
        title: this.draft.title,
        dueDate: this.draft.dueDate || null,
      }),
    );
    if (!done) return;
    this.adding.set(false);
    this.toasts.show('Tarefa adicionada.');
    await this.load(this.employeeId());
  }
}
