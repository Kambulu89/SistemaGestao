import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api, ApiError } from '../core/api';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField } from '../ui/form-field';
import { Icon } from '../ui/icon';
import { Action } from '../ui/load';
import { Modal } from '../ui/modal';
import { ErrorState, Skeleton } from '../ui/states';
import { EntityListPage } from '../ui/templates';
import { ToastService } from '../ui/toasts';
import { type Competency, type Course, COURSE_MODE, levelDots } from './training-model';

/** Catálogo de formação: competências e cursos (com as competências que dão e a validade do certificado). */
@Component({
  selector: 'app-training-catalog',
  imports: [
    FormsModule,
    EntityListPage,
    Modal,
    FormField,
    FieldControl,
    ErrorAlert,
    ErrorState,
    Skeleton,
    Icon,
  ],
  template: `
    <app-entity-list-page
      title="Catálogo de formação"
      subtitle="Competências e cursos da empresa."
      permission="hr.training.settings"
      feature="hr"
    >
      <button
        actions
        type="button"
        class="btn-secondary"
        data-testid="new-competency"
        (click)="openCompetency(null)"
      >
        <app-icon name="plus" [size]="16" />Competência
      </button>
      <button
        actions
        type="button"
        class="btn-primary"
        data-testid="new-course"
        (click)="openCourse(null)"
      >
        <app-icon name="plus" [size]="16" />Curso
      </button>
      @if (error()) {
        <app-error-state [error]="error()" (retry)="load()" />
      } @else if (!courses()) {
        <div class="card"><app-skeleton /></div>
      } @else {
        <div class="grid gap-4 lg:grid-cols-[2fr_1fr]">
          <section class="card" aria-labelledby="cat-courses">
            <h2 id="cat-courses" class="mb-3 font-semibold">Cursos</h2>
            @if (!courses()!.length) {
              <p class="text-sm text-muted">Sem cursos.</p>
            }
            <ul class="divide-y divide-border text-sm">
              @for (c of courses(); track c.id) {
                <li class="py-2" [attr.data-testid]="'course-' + c.code">
                  <div class="flex flex-wrap items-center justify-between gap-2">
                    <span class="font-medium"
                      >{{ c.code }} — {{ c.name }}
                      @if (c.status === 'INACTIVE') {
                        <span class="badge bg-surface-2 text-muted">Inactivo</span>
                      }
                    </span>
                    <button type="button" class="btn-ghost px-2 py-1" (click)="openCourse(c)">
                      Editar
                    </button>
                  </div>
                  <p class="text-muted">
                    {{ mode(c) }} · {{ c.durationHours }} h{{
                      c.provider ? ' · ' + c.provider : ''
                    }}
                    · {{ c.assessed ? 'com avaliação' : 'presença'
                    }}{{
                      c.issuesCertificate
                        ? ' · certificado' +
                          (c.certificateValidityMonths
                            ? ' (' + c.certificateValidityMonths + ' meses)'
                            : '')
                        : ''
                    }}
                  </p>
                  @if (c.competencies.length) {
                    <p class="text-muted">
                      @for (k of c.competencies; track k.competencyId; let last = $last) {
                        {{ k.name }} <span aria-hidden="true">{{ dots(k.level) }}</span
                        ><span class="sr-only">nível {{ k.level }}</span
                        >{{ last ? '' : ' · ' }}
                      }
                    </p>
                  }
                </li>
              }
            </ul>
          </section>
          <section class="card" aria-labelledby="cat-comp">
            <h2 id="cat-comp" class="mb-3 font-semibold">Competências</h2>
            @if (!competencies().length) {
              <p class="text-sm text-muted">Sem competências.</p>
            }
            <ul class="divide-y divide-border text-sm">
              @for (k of competencies(); track k.id) {
                <li
                  class="flex items-center justify-between gap-2 py-2"
                  [attr.data-testid]="'competency-' + k.code"
                >
                  <span
                    >{{ k.code }} — {{ k.name }}
                    @if (k.status === 'INACTIVE') {
                      <span class="badge bg-surface-2 text-muted">Inactiva</span>
                    }
                  </span>
                  <button type="button" class="btn-ghost px-2 py-1" (click)="openCompetency(k)">
                    Editar
                  </button>
                </li>
              }
            </ul>
          </section>
        </div>
      }
    </app-entity-list-page>

    <app-modal
      [title]="editingComp() ? 'Editar competência' : 'Nova competência'"
      [open]="compOpen()"
      (closed)="compOpen.set(false)"
    >
      <app-error-alert [error]="action.error()" [showDetails]="false" />
      <div class="space-y-3">
        <app-field label="Código" [required]="true" [error]="action.field('code')">
          <input
            appControl
            class="input"
            data-testid="cp-code"
            [(ngModel)]="comp.code"
            [ngModelOptions]="{ standalone: true }"
          />
        </app-field>
        <app-field label="Nome" [required]="true" [error]="action.field('name')">
          <input
            appControl
            class="input"
            data-testid="cp-name"
            [(ngModel)]="comp.name"
            [ngModelOptions]="{ standalone: true }"
          />
        </app-field>
        <app-field label="Estado">
          <select
            appControl
            class="input"
            [(ngModel)]="comp.status"
            [ngModelOptions]="{ standalone: true }"
          >
            <option value="ACTIVE">Activa</option>
            <option value="INACTIVE">Inactiva</option>
          </select>
        </app-field>
      </div>
      <ng-container actions>
        <button type="button" class="btn-secondary" (click)="compOpen.set(false)">Cancelar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="cp-confirm"
          [disabled]="action.busy()"
          (click)="saveCompetency()"
        >
          Guardar
        </button>
      </ng-container>
    </app-modal>

    <app-modal
      [title]="editingCourse() ? 'Editar curso' : 'Novo curso'"
      [open]="courseOpen()"
      (closed)="courseOpen.set(false)"
    >
      <app-error-alert [error]="action.error()" [showDetails]="false" />
      <div class="space-y-3">
        <div class="grid gap-3 sm:grid-cols-2">
          <app-field label="Código" [required]="true" [error]="action.field('code')">
            <input
              appControl
              class="input"
              data-testid="co-code"
              [(ngModel)]="course.code"
              [ngModelOptions]="{ standalone: true }"
            />
          </app-field>
          <app-field label="Nome" [required]="true" [error]="action.field('name')">
            <input
              appControl
              class="input"
              data-testid="co-name"
              [(ngModel)]="course.name"
              [ngModelOptions]="{ standalone: true }"
            />
          </app-field>
          <app-field label="Modalidade" [required]="true" [error]="action.field('mode')">
            <select
              appControl
              class="input"
              [(ngModel)]="course.mode"
              [ngModelOptions]="{ standalone: true }"
            >
              <option value="INTERNAL">Interna</option>
              <option value="EXTERNAL">Externa</option>
              <option value="ONLINE">Online</option>
            </select>
          </app-field>
          <app-field
            label="Duração (horas)"
            [required]="true"
            [error]="action.field('durationHours')"
          >
            <input
              appControl
              class="input"
              inputmode="decimal"
              data-testid="co-hours"
              [(ngModel)]="course.durationHours"
              [ngModelOptions]="{ standalone: true }"
            />
          </app-field>
          <app-field label="Entidade formadora" [error]="action.field('provider')">
            <input
              appControl
              class="input"
              [(ngModel)]="course.provider"
              [ngModelOptions]="{ standalone: true }"
            />
          </app-field>
          <app-field
            label="Validade do certificado (meses)"
            [error]="action.field('certificateValidityMonths')"
          >
            <input
              appControl
              class="input"
              type="number"
              min="1"
              [(ngModel)]="course.certificateValidityMonths"
              [ngModelOptions]="{ standalone: true }"
            />
          </app-field>
        </div>
        <label class="flex items-center gap-2 text-sm"
          ><input
            type="checkbox"
            data-testid="co-assessed"
            [(ngModel)]="course.assessed"
            [ngModelOptions]="{ standalone: true }"
          />Com avaliação (aprovado/reprovado)</label
        >
        <label class="flex items-center gap-2 text-sm"
          ><input
            type="checkbox"
            data-testid="co-cert"
            [(ngModel)]="course.issuesCertificate"
            [ngModelOptions]="{ standalone: true }"
          />Emite certificado</label
        >
        <fieldset>
          <legend class="mb-1 text-sm font-medium">Competências que o curso dá</legend>
          @if (action.field('competencies')) {
            <p class="field-error">{{ action.field('competencies') }}</p>
          }
          <ul class="space-y-1 text-sm">
            @for (k of activeCompetencies(); track k.id) {
              <li class="flex items-center gap-2">
                <label class="flex flex-1 items-center gap-2">
                  <input
                    type="checkbox"
                    [attr.data-testid]="'co-comp-' + k.code"
                    [checked]="!!links[k.id]"
                    (change)="toggleLink(k.id)"
                  />
                  {{ k.name }}
                </label>
                @if (links[k.id]) {
                  <select
                    class="input w-28"
                    [attr.aria-label]="'Nível de ' + k.name"
                    [attr.data-testid]="'co-level-' + k.code"
                    [(ngModel)]="links[k.id]"
                    [ngModelOptions]="{ standalone: true }"
                  >
                    @for (n of [1, 2, 3, 4, 5]; track n) {
                      <option [ngValue]="n">Nível {{ n }}</option>
                    }
                  </select>
                }
              </li>
            }
          </ul>
        </fieldset>
      </div>
      <ng-container actions>
        <button type="button" class="btn-secondary" (click)="courseOpen.set(false)">
          Cancelar
        </button>
        <button
          type="button"
          class="btn-primary"
          data-testid="co-confirm"
          [disabled]="action.busy()"
          (click)="saveCourse()"
        >
          Guardar
        </button>
      </ng-container>
    </app-modal>
  `,
})
export class TrainingCatalog {
  private readonly api = inject(Api);
  private readonly toasts = inject(ToastService);
  protected readonly courses = signal<Course[] | null>(null);
  protected readonly competencies = signal<Competency[]>([]);
  protected readonly error = signal<ApiError | null>(null);
  protected readonly compOpen = signal(false);
  protected readonly courseOpen = signal(false);
  protected readonly editingComp = signal<Competency | null>(null);
  protected readonly editingCourse = signal<Course | null>(null);
  protected readonly action = new Action();
  protected comp = { code: '', name: '', status: 'ACTIVE' };
  protected course = {
    code: '',
    name: '',
    mode: 'INTERNAL',
    durationHours: '',
    provider: '',
    assessed: false,
    issuesCertificate: false,
    certificateValidityMonths: null as number | null,
  };
  protected links: Record<string, number> = {};
  protected readonly mode = (c: Course) => COURSE_MODE[c.mode];
  protected readonly dots = levelDots;
  protected readonly activeCompetencies = () =>
    this.competencies().filter((k) => k.status === 'ACTIVE');

  constructor() {
    void this.load();
  }

  protected async load() {
    this.error.set(null);
    try {
      const [c, k] = await Promise.all([
        this.api.get<Course[]>('hr/training/courses'),
        this.api.get<Competency[]>('hr/training/competencies'),
      ]);
      this.courses.set(c);
      this.competencies.set(k);
    } catch (e) {
      this.error.set(ApiError.from(e));
    }
  }

  protected openCompetency(k: Competency | null) {
    this.action.error.set(null);
    this.editingComp.set(k);
    this.comp = k
      ? { code: k.code, name: k.name, status: k.status }
      : { code: '', name: '', status: 'ACTIVE' };
    this.compOpen.set(true);
  }

  protected async saveCompetency() {
    const k = this.editingComp();
    const body = { code: this.comp.code, name: this.comp.name, status: this.comp.status };
    const done = await this.action.run(() =>
      k
        ? this.api.patch(`hr/training/competencies/${k.id}`, body)
        : this.api.post('hr/training/competencies', body),
    );
    if (!done) return;
    this.compOpen.set(false);
    await this.load();
    this.toasts.show('Competência guardada.');
  }

  protected openCourse(c: Course | null) {
    this.action.error.set(null);
    this.editingCourse.set(c);
    this.course = c
      ? {
          code: c.code,
          name: c.name,
          mode: c.mode,
          durationHours: c.durationHours.replace(/\.00$/, ''),
          provider: c.provider ?? '',
          assessed: c.assessed,
          issuesCertificate: c.issuesCertificate,
          certificateValidityMonths: c.certificateValidityMonths,
        }
      : {
          code: '',
          name: '',
          mode: 'INTERNAL',
          durationHours: '',
          provider: '',
          assessed: false,
          issuesCertificate: false,
          certificateValidityMonths: null,
        };
    this.links = Object.fromEntries((c?.competencies ?? []).map((l) => [l.competencyId, l.level]));
    this.courseOpen.set(true);
  }

  protected toggleLink(id: string) {
    if (this.links[id]) delete this.links[id];
    else this.links[id] = 1;
  }

  protected async saveCourse() {
    const c = this.editingCourse();
    const f = this.course;
    const body = {
      code: f.code,
      name: f.name,
      mode: f.mode,
      durationHours: f.durationHours.trim().replace(',', '.'),
      provider: f.provider.trim() || null,
      assessed: f.assessed,
      issuesCertificate: f.issuesCertificate,
      certificateValidityMonths: f.certificateValidityMonths
        ? Number(f.certificateValidityMonths)
        : null,
      competencies: Object.entries(this.links).map(([competencyId, level]) => ({
        competencyId,
        level: Number(level),
      })),
    };
    const done = await this.action.run(() =>
      c
        ? this.api.patch(`hr/training/courses/${c.id}`, body)
        : this.api.post('hr/training/courses', body),
    );
    if (!done) return;
    this.courseOpen.set(false);
    await this.load();
    this.toasts.show('Curso guardado.');
  }
}
