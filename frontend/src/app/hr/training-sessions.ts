import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { Workspace } from '../core/workspace';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { formatDate } from '../ui/dates';
import { ErrorAlert } from '../ui/error-alert';
import { FilterBar, type FilterDef } from '../ui/filter-bar';
import { FieldControl, FormField } from '../ui/form-field';
import { Icon } from '../ui/icon';
import { ListState } from '../ui/list-state';
import { Action } from '../ui/load';
import { Modal } from '../ui/modal';
import { formatMoney, MoneyInput } from '../ui/money-input';
import { EntityListPage } from '../ui/templates';
import { ToastService } from '../ui/toasts';
import { type Course, type Session, SESSION_STATUS, sessionTone } from './training-model';

/** Sessões de formação, com o diálogo para planear uma nova. */
@Component({
  selector: 'app-training-sessions',
  imports: [
    FormsModule,
    RouterLink,
    EntityListPage,
    FilterBar,
    DataTable,
    CellDef,
    Modal,
    FormField,
    FieldControl,
    ErrorAlert,
    Icon,
    MoneyInput,
  ],
  template: `
    <app-entity-list-page
      title="Formação"
      subtitle="Sessões de formação, inscrições e resultados. Concluir atribui competências e certificados."
      permission="hr.training.read"
      feature="hr"
      [anyScope]="true"
    >
      @if (canManage()) {
        <button
          actions
          type="button"
          class="btn-primary"
          data-testid="new-session"
          (click)="open()"
        >
          <app-icon name="plus" [size]="16" />Nova sessão
        </button>
      }
      @if (canSettings()) {
        <a actions class="btn-secondary" routerLink="/rh/formacao/catalogo">Catálogo</a>
      }
      <app-filter-bar
        id="tr"
        label="sessões"
        [searchable]="false"
        [state]="list"
        [filters]="filters"
      />
      <app-data-table
        label="Sessões de formação"
        tableId="hr-training"
        [columns]="columns"
        [rows]="list.page.value()?.items ?? []"
        [total]="list.page.value()?.total ?? 0"
        [loading]="list.page.loading()"
        [error]="list.page.error()"
        [offset]="list.offset()"
        [limit]="list.limit"
        [emptyText]="
          list.activeFilters() ? 'Sem sessões com estes filtros.' : 'Ainda não há sessões.'
        "
        (offsetChange)="list.goTo($event)"
        (retry)="list.reload()"
      >
        <ng-template appCell="status" let-row>
          <span class="badge" [class]="tone(row.status)">{{ status(row.status) }}</span>
        </ng-template>
      </app-data-table>
    </app-entity-list-page>

    <app-modal title="Nova sessão de formação" [open]="opened()" (closed)="opened.set(false)">
      <app-error-alert [error]="action.error()" [showDetails]="false" />
      <div class="space-y-3">
        <app-field label="Curso" [required]="true" [error]="action.field('courseId')">
          <select
            appControl
            class="input"
            data-testid="ts-course"
            [(ngModel)]="form.courseId"
            [ngModelOptions]="{ standalone: true }"
          >
            <option [ngValue]="null">—</option>
            @for (c of courses(); track c.id) {
              <option [ngValue]="c.id">{{ c.code }} — {{ c.name }}</option>
            }
          </select>
        </app-field>
        <div class="grid gap-3 sm:grid-cols-2">
          <app-field label="Início" [required]="true" [error]="action.field('startsOn')">
            <input
              appControl
              class="input"
              type="date"
              data-testid="ts-start"
              [(ngModel)]="form.startsOn"
              [ngModelOptions]="{ standalone: true }"
            />
          </app-field>
          <app-field label="Fim" [required]="true" [error]="action.field('endsOn')">
            <input
              appControl
              class="input"
              type="date"
              data-testid="ts-end"
              [(ngModel)]="form.endsOn"
              [ngModelOptions]="{ standalone: true }"
            />
          </app-field>
          <app-field label="Local" [error]="action.field('location')">
            <input
              appControl
              class="input"
              [(ngModel)]="form.location"
              [ngModelOptions]="{ standalone: true }"
            />
          </app-field>
          <app-field label="Formador" [error]="action.field('trainer')">
            <input
              appControl
              class="input"
              [(ngModel)]="form.trainer"
              [ngModelOptions]="{ standalone: true }"
            />
          </app-field>
          <app-field label="Capacidade" [error]="action.field('capacity')">
            <input
              appControl
              class="input"
              type="number"
              min="1"
              data-testid="ts-capacity"
              [(ngModel)]="form.capacity"
              [ngModelOptions]="{ standalone: true }"
            />
          </app-field>
          <app-field
            label="Custo total"
            [error]="action.field('costTotal') ?? action.field('currency')"
          >
            <app-money-input
              data-testid="ts-cost"
              [currency]="form.currency"
              [(ngModel)]="form.costTotal"
              [ngModelOptions]="{ standalone: true }"
            />
          </app-field>
        </div>
      </div>
      <ng-container actions>
        <button type="button" class="btn-secondary" (click)="opened.set(false)">Cancelar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="ts-confirm"
          [disabled]="action.busy()"
          (click)="save()"
        >
          Criar
        </button>
      </ng-container>
    </app-modal>
  `,
})
export class TrainingSessions {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly workspace = inject(Workspace);
  protected readonly courses = signal<Course[]>([]);
  protected readonly opened = signal(false);
  protected readonly action = new Action();
  protected readonly canManage = computed(() => this.workspace.canAny('hr.training.manage'));
  protected readonly canSettings = computed(() => this.workspace.can('hr.training.settings'));
  protected form = {
    courseId: null as string | null,
    startsOn: '',
    endsOn: '',
    location: '',
    trainer: '',
    capacity: null as number | null,
    costTotal: null as string | null,
    currency: 'AOA',
  };
  protected readonly tone = sessionTone;
  protected readonly status = (s: Session['status']) => SESSION_STATUS[s];
  protected readonly filters: FilterDef[] = [
    {
      key: 'status',
      label: 'Estado',
      options: Object.entries(SESSION_STATUS).map(([value, label]) => ({ value, label })),
    },
  ];
  protected readonly columns: Column<Session>[] = [
    { key: 'code', label: 'Código', required: true, link: (s) => ['/rh/formacao', s.id] },
    { key: 'course', label: 'Curso', value: (s) => s.course.name },
    {
      key: 'dates',
      label: 'Datas',
      value: (s) => `${formatDate(s.startsOn)} – ${formatDate(s.endsOn)}`,
    },
    { key: 'participants', label: 'Participantes', align: 'end', value: (s) => s.participants },
    {
      key: 'cost',
      label: 'Custo',
      align: 'end',
      hideOnMobile: true,
      value: (s) => (s.costTotal ? `${formatMoney(s.costTotal)} ${s.currency}` : '—'),
    },
    { key: 'status', label: 'Estado', value: (s) => this.status(s.status) },
  ];
  protected readonly list = new ListState<Session>(this.api, {
    url: 'hr/training/sessions',
    filterKeys: ['status'],
    sortFields: [],
    limit: 25,
  });

  protected async open() {
    this.action.error.set(null);
    try {
      this.courses.set(
        (await this.api.get<Course[]>('hr/training/courses')).filter((c) => c.status === 'ACTIVE'),
      );
    } catch {
      this.courses.set([]);
    }
    this.form = {
      courseId: null,
      startsOn: '',
      endsOn: '',
      location: '',
      trainer: '',
      capacity: null,
      costTotal: null,
      currency: 'AOA',
    };
    this.opened.set(true);
  }

  protected async save() {
    const f = this.form;
    const result = await this.action.run(() =>
      this.api.post<Session>('hr/training/sessions', {
        courseId: f.courseId,
        startsOn: f.startsOn || null,
        endsOn: f.endsOn || null,
        location: f.location.trim() || undefined,
        trainer: f.trainer.trim() || undefined,
        capacity: f.capacity ? Number(f.capacity) : undefined,
        ...(f.costTotal ? { costTotal: f.costTotal, currency: f.currency } : {}),
      }),
    );
    if (!result) return;
    this.opened.set(false);
    this.toasts.show('Sessão criada.');
    await this.router.navigate(['/rh/formacao', result.id]);
  }
}
