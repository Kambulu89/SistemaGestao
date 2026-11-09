import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { Workspace } from '../core/workspace';
import { formatDate } from '../ui/dates';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField } from '../ui/form-field';
import { Action } from '../ui/load';
import { Modal } from '../ui/modal';
import { ToastService } from '../ui/toasts';
import { CASE_CATEGORY, CASE_STATUS, caseTone, type DisciplinaryCase } from './training-model';

/** Processos disciplinares na ficha: só para quem tem acesso restrito (a API decide e audita). */
@Component({
  selector: 'app-discipline-card',
  imports: [FormsModule, RouterLink, Modal, FormField, FieldControl, ErrorAlert],
  template: `
    @if (visible() && items(); as list) {
      <section class="card" aria-labelledby="dcc-title" data-testid="discipline">
        <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 id="dcc-title" class="font-semibold">Processos disciplinares</h2>
          @if (canManage()) {
            <button type="button" class="btn-secondary" data-testid="dcc-open" (click)="open()">
              Abrir processo
            </button>
          }
        </div>
        @if (!list.length) {
          <p class="text-sm text-muted">Sem processos.</p>
        }
        <ul class="text-sm">
          @for (c of list; track c.id) {
            <li class="flex flex-wrap justify-between gap-2 py-1">
              <a class="link" [routerLink]="['/rh/disciplina', c.id]"
                >{{ c.code }} · {{ date(c.occurredOn) }} · {{ c.summary }}</a
              >
              <span class="badge" [class]="tone(c.status)">{{ status(c.status) }}</span>
            </li>
          }
        </ul>
      </section>
    }

    <app-modal title="Abrir processo disciplinar" [open]="opened()" (closed)="opened.set(false)">
      <app-error-alert [error]="action.error()" [showDetails]="false" />
      <div class="space-y-3">
        <div class="grid gap-3 sm:grid-cols-2">
          <app-field label="Data dos factos" [required]="true" [error]="action.field('occurredOn')">
            <input
              appControl
              class="input"
              type="date"
              data-testid="dcc-date"
              [(ngModel)]="form.occurredOn"
              [ngModelOptions]="{ standalone: true }"
            />
          </app-field>
          <app-field label="Categoria" [required]="true" [error]="action.field('category')">
            <select
              appControl
              class="input"
              data-testid="dcc-category"
              [(ngModel)]="form.category"
              [ngModelOptions]="{ standalone: true }"
            >
              @for (k of categories; track k[0]) {
                <option [value]="k[0]">{{ k[1] }}</option>
              }
            </select>
          </app-field>
        </div>
        <app-field label="Resumo" [required]="true" [error]="action.field('summary')">
          <input
            appControl
            class="input"
            data-testid="dcc-summary"
            [(ngModel)]="form.summary"
            [ngModelOptions]="{ standalone: true }"
          />
        </app-field>
        <app-field
          label="Descrição dos factos"
          [required]="true"
          [error]="action.field('description')"
        >
          <textarea
            appControl
            class="input min-h-28"
            data-testid="dcc-description"
            [(ngModel)]="form.description"
            [ngModelOptions]="{ standalone: true }"
          ></textarea>
        </app-field>
      </div>
      <ng-container actions>
        <button type="button" class="btn-secondary" (click)="opened.set(false)">Cancelar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="dcc-confirm"
          [disabled]="action.busy()"
          (click)="save()"
        >
          Abrir
        </button>
      </ng-container>
    </app-modal>
  `,
})
export class DisciplineCard {
  readonly employeeId = input.required<string>();
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly workspace = inject(Workspace);
  protected readonly items = signal<DisciplinaryCase[] | null>(null);
  protected readonly opened = signal(false);
  protected readonly action = new Action();
  protected readonly visible = computed(
    () =>
      this.workspace.canAny('hr.discipline.read') || this.workspace.canAny('hr.discipline.manage'),
  );
  protected readonly canManage = computed(() => this.workspace.canAny('hr.discipline.manage'));
  protected form = { occurredOn: '', category: 'CONDUCT', summary: '', description: '' };
  protected readonly categories = Object.entries(CASE_CATEGORY);
  protected readonly date = formatDate;
  protected readonly tone = caseTone;
  protected readonly status = (s: DisciplinaryCase['status']) => CASE_STATUS[s];

  constructor() {
    effect(() => {
      const id = this.employeeId();
      const show = this.visible();
      untracked(() => {
        if (show) void this.load(id);
      });
    });
  }

  private async load(id: string) {
    try {
      const page = await this.api.page<DisciplinaryCase>('hr/discipline/cases', {
        employeeId: id,
        limit: 50,
      });
      this.items.set(page.items);
    } catch {
      this.items.set(null);
    }
  }

  protected open() {
    this.action.error.set(null);
    this.form = { occurredOn: '', category: 'CONDUCT', summary: '', description: '' };
    this.opened.set(true);
  }

  protected async save() {
    const result = await this.action.run(() =>
      this.api.post<DisciplinaryCase>(`hr/employees/${this.employeeId()}/discipline/cases`, {
        ...this.form,
        occurredOn: this.form.occurredOn || null,
      }),
    );
    if (!result) return;
    this.opened.set(false);
    this.toasts.show('Processo aberto.');
    await this.router.navigate(['/rh/disciplina', result.id]);
  }
}
