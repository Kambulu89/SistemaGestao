import { Component, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api, ApiError } from '../core/api';
import { Breadcrumbs } from '../core/breadcrumbs';
import { AuditHistory } from '../ui/audit-history';
import { ConfirmService } from '../ui/confirm';
import { formatDate } from '../ui/dates';
import { FieldList } from '../ui/detail-drawer';
import { ErrorAlert } from '../ui/error-alert';
import { Action } from '../ui/load';
import { Modal } from '../ui/modal';
import { formatMoney } from '../ui/money-input';
import { PageDetail } from '../ui/page-detail';
import { ErrorState, Skeleton } from '../ui/states';
import { ToastService } from '../ui/toasts';
import {
  ENROLLMENT_STATUS,
  type EnrollmentStatus,
  enrollmentTone,
  resultOptions,
  type Session,
  SESSION_STATUS,
  sessionTone,
} from './training-model';

type Enrollment = NonNullable<Session['enrollments']>[number];

/** Sessão de formação: inscrever, registar resultados, concluir (competências e certificados) ou cancelar. */
@Component({
  selector: 'app-training-session',
  imports: [
    FormsModule,
    PageDetail,
    FieldList,
    AuditHistory,
    Modal,
    ErrorAlert,
    ErrorState,
    Skeleton,
  ],
  template: `
    @if (loadError()) {
      <app-error-state [error]="loadError()" (retry)="reload()" />
    } @else if (!s()) {
      <div class="card"><app-skeleton /></div>
    } @else {
      @let x = s()!;
      <app-page-detail
        [title]="x.course.name + ' — ' + x.code"
        [subtitle]="
          date(x.startsOn) + ' – ' + date(x.endsOn) + (x.location ? ' · ' + x.location : '')
        "
      >
        <ng-container actions>
          @if (x.access?.manage) {
            <button
              type="button"
              class="btn-secondary"
              data-testid="tr-enroll"
              (click)="openEnroll()"
            >
              Inscrever
            </button>
            <button
              type="button"
              class="btn-primary"
              data-testid="tr-complete"
              (click)="complete()"
            >
              Concluir
            </button>
            <button type="button" class="btn-secondary" data-testid="tr-cancel" (click)="cancel()">
              Cancelar sessão
            </button>
          }
        </ng-container>
        <section class="card" aria-labelledby="tr-people">
          <h2 id="tr-people" class="mb-3 flex items-center gap-2 font-semibold">
            Participantes
            <span class="badge" [class]="tone(x.status)" data-testid="tr-status">{{
              status(x.status)
            }}</span>
          </h2>
          @if (!x.enrollments?.length) {
            <p class="text-sm text-muted">Sem inscrições no seu âmbito.</p>
          } @else {
            <div class="overflow-x-auto">
              <table class="w-full text-sm" data-testid="tr-enrollments">
                <caption class="sr-only">
                  Participantes e resultados
                </caption>
                <thead>
                  <tr class="text-left text-muted">
                    <th scope="col" class="py-1 pr-3 font-medium">Colaborador</th>
                    <th scope="col" class="py-1 pr-3 font-medium">Resultado</th>
                    <th scope="col" class="py-1 pr-3 font-medium">Horas</th>
                    @if (x.course.assessed) {
                      <th scope="col" class="py-1 pr-3 font-medium">Nota</th>
                    }
                    <th scope="col" class="py-1 font-medium">
                      <span class="sr-only">Acções</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  @for (e of x.enrollments; track e.id) {
                    <tr
                      class="border-t border-border"
                      [attr.data-testid]="'tr-row-' + e.employee.code"
                    >
                      <td class="py-1 pr-3">{{ e.employee.code }} — {{ e.employee.fullName }}</td>
                      @if (x.access?.manage && e.canManage) {
                        <td class="py-1 pr-3">
                          <select
                            class="input"
                            [attr.aria-label]="'Resultado de ' + e.employee.fullName"
                            [attr.data-testid]="'tr-result-' + e.employee.code"
                            [(ngModel)]="draft[e.id].status"
                            [ngModelOptions]="{ standalone: true }"
                          >
                            <option value="ENROLLED" disabled>Inscrito</option>
                            @for (o of options(x); track o) {
                              <option [value]="o">{{ label(o) }}</option>
                            }
                          </select>
                        </td>
                        <td class="py-1 pr-3">
                          <input
                            class="input w-20 text-right"
                            inputmode="decimal"
                            [attr.aria-label]="'Horas de ' + e.employee.fullName"
                            [(ngModel)]="draft[e.id].hours"
                            [ngModelOptions]="{ standalone: true }"
                          />
                        </td>
                        @if (x.course.assessed) {
                          <td class="py-1 pr-3">
                            <input
                              class="input w-20 text-right"
                              inputmode="decimal"
                              [attr.aria-label]="'Nota de ' + e.employee.fullName"
                              [attr.data-testid]="'tr-score-' + e.employee.code"
                              [(ngModel)]="draft[e.id].score"
                              [ngModelOptions]="{ standalone: true }"
                            />
                          </td>
                        }
                        <td class="py-1 text-right">
                          <button
                            type="button"
                            class="btn-ghost px-2 py-1"
                            [attr.data-testid]="'tr-save-' + e.employee.code"
                            (click)="saveResult(e)"
                          >
                            Guardar
                          </button>
                        </td>
                      } @else {
                        <td class="py-1 pr-3">
                          <span class="badge" [class]="etone(e.status)">{{ label(e.status) }}</span>
                        </td>
                        <td class="py-1 pr-3 tabular-nums">{{ e.hoursAttended ?? '—' }}</td>
                        @if (x.course.assessed) {
                          <td class="py-1 pr-3 tabular-nums">{{ e.score ?? '—' }}</td>
                        }
                        <td class="py-1 text-right text-muted">
                          {{ e.certificateId ? 'Certificado emitido' : '' }}
                        </td>
                      }
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </section>
        <div aside>
          <section class="card" aria-labelledby="tr-summary">
            <h2 id="tr-summary" class="mb-3 font-semibold">Resumo</h2>
            <app-field-list
              [fields]="[
                { label: 'Curso', value: x.course.code + ' — ' + x.course.name },
                { label: 'Duração', value: x.course.durationHours.replace('.00', '') + ' h' },
                { label: 'Avaliação', value: x.course.assessed ? 'Com avaliação' : 'Presença' },
                {
                  label: 'Certificado',
                  value: x.course.issuesCertificate ? 'Emitido a quem conclui' : 'Não',
                },
                { label: 'Formador', value: x.trainer },
                {
                  label: 'Participantes',
                  value: x.participants + (x.capacity ? ' de ' + x.capacity : ''),
                },
                {
                  label: 'Custo total',
                  value: x.costTotal ? money(x.costTotal) + ' ' + x.currency : null,
                },
                {
                  label: 'Custo por participante',
                  value: x.costPerHead ? money(x.costPerHead) + ' ' + x.currency : null,
                },
                { label: 'Competências', value: competencies(x) },
              ]"
            />
          </section>
          <app-audit-history
            entityType="training_session"
            [entityId]="x.id"
            [refreshKey]="x.version"
          />
        </div>
      </app-page-detail>
    }

    <app-modal title="Inscrever colaboradores" [open]="enrolling()" (closed)="enrolling.set(false)">
      <app-error-alert [error]="action.error()" />
      @if (!people().length) {
        <p class="text-sm text-muted">Sem colaboradores no seu âmbito.</p>
      }
      <ul class="max-h-80 space-y-1 overflow-y-auto text-sm">
        @for (p of people(); track p.id) {
          <li>
            <label class="flex items-center gap-2">
              <input
                type="checkbox"
                [attr.data-testid]="'tr-pick-' + p.code"
                [checked]="picked.has(p.id)"
                (change)="toggle(p.id)"
              />
              {{ p.code }} — {{ p.fullName }}
            </label>
          </li>
        }
      </ul>
      <ng-container actions>
        <button type="button" class="btn-secondary" (click)="enrolling.set(false)">Cancelar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="tr-enroll-confirm"
          [disabled]="action.busy()"
          (click)="enroll()"
        >
          Inscrever
        </button>
      </ng-container>
    </app-modal>
  `,
})
export class TrainingSession {
  readonly id = input.required<string>();
  private readonly api = inject(Api);
  private readonly toasts = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  protected readonly s = signal<Session | null>(null);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly enrolling = signal(false);
  protected readonly people = signal<{ id: string; code: string; fullName: string }[]>([]);
  protected readonly action = new Action();
  protected picked = new Set<string>();
  protected draft: Record<string, { status: EnrollmentStatus; hours: string; score: string }> = {};
  protected readonly date = formatDate;
  protected readonly money = (v: string) => formatMoney(v);
  protected readonly tone = sessionTone;
  protected readonly etone = enrollmentTone;
  protected readonly status = (v: Session['status']) => SESSION_STATUS[v];
  protected readonly label = (v: EnrollmentStatus) => ENROLLMENT_STATUS[v];
  protected readonly options = (x: Session) => resultOptions(x.course.assessed);
  protected readonly competencies = (x: Session) =>
    x.competencies?.length
      ? x.competencies.map((c) => `${c.name} (nível ${c.level})`).join(', ')
      : null;

  constructor() {
    effect(() => {
      const id = this.id();
      untracked(() => void this.load(id));
    });
  }

  protected reload() {
    void this.load(this.id());
  }

  private set(x: Session) {
    this.s.set(x);
    this.draft = Object.fromEntries(
      (x.enrollments ?? []).map((e) => [
        e.id,
        { status: e.status, hours: e.hoursAttended ?? '', score: e.score ?? '' },
      ]),
    );
  }

  private async load(id: string) {
    this.loadError.set(null);
    try {
      const x = await this.api.get<Session>(`hr/training/sessions/${id}`);
      this.set(x);
      this.breadcrumbs.setCurrent(`${x.code} — ${x.course.name}`);
    } catch (error) {
      this.loadError.set(ApiError.from(error));
    }
  }

  private fail() {
    const e = this.action.error();
    this.toasts.show(e?.details?.[0]?.message ?? e?.message ?? 'Erro.', 'error');
  }

  protected async saveResult(e: Enrollment) {
    const d = this.draft[e.id];
    const done = await this.action.run(() =>
      this.api.post<Session>(`hr/training/enrollments/${e.id}/result`, {
        status: d.status,
        hoursAttended: d.hours.trim() || null,
        score: this.s()!.course.assessed ? d.score.trim() || null : undefined,
        expectedVersion: e.version,
      }),
    );
    if (!done) return this.fail();
    this.set(done);
    this.toasts.show('Resultado guardado.');
  }

  protected async openEnroll() {
    this.action.error.set(null);
    this.picked = new Set();
    try {
      const page = await this.api.page<{
        id: string;
        code: string;
        fullName: string;
        status: string;
      }>('hr/employees', {
        status: 'ACTIVE',
        limit: 200,
      });
      const inside = new Set(
        (this.s()!.enrollments ?? [])
          .filter((e) => e.status !== 'CANCELLED')
          .map((e) => e.employee.id),
      );
      this.people.set(page.items.filter((p) => !inside.has(p.id)));
    } catch {
      this.people.set([]);
    }
    this.enrolling.set(true);
  }

  protected toggle(id: string) {
    if (this.picked.has(id)) this.picked.delete(id);
    else this.picked.add(id);
  }

  protected async enroll() {
    const x = this.s()!;
    const done = await this.action.run(() =>
      this.api.post<Session>(`hr/training/sessions/${x.id}/enrollments`, {
        employeeIds: [...this.picked],
        expectedVersion: x.version,
      }),
    );
    if (!done) return;
    this.enrolling.set(false);
    this.set(done);
    this.toasts.show('Inscrições registadas.');
  }

  protected async complete() {
    const x = this.s()!;
    const ok = await this.confirm.ask({
      title: 'Concluir sessão',
      message:
        'Concluída, a sessão não muda: quem concluiu recebe as competências do curso e, se previsto, o certificado.',
      confirmLabel: 'Concluir',
    });
    if (!ok) return;
    const done = await this.action.run(() =>
      this.api.post<Session>(`hr/training/sessions/${x.id}/complete`, {
        expectedVersion: x.version,
      }),
    );
    if (!done) return this.fail();
    this.set(done);
    this.toasts.show('Sessão concluída.');
  }

  protected async cancel() {
    const x = this.s()!;
    const ok = await this.confirm.ask({
      title: 'Cancelar sessão',
      message: 'Cancelar esta sessão?',
      confirmLabel: 'Cancelar sessão',
      danger: true,
    });
    if (!ok) return;
    const done = await this.action.run(() =>
      this.api.post<Session>(`hr/training/sessions/${x.id}/cancel`, { expectedVersion: x.version }),
    );
    if (!done) return this.fail();
    this.set(done);
    this.toasts.show('Sessão cancelada.');
  }
}
