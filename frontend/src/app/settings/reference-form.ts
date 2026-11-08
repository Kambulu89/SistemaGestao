import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { Breadcrumbs } from '../core/breadcrumbs';
import { type HasUnsavedChanges, snapshot, warnOnUnload } from '../core/unsaved';
import { Workspace } from '../core/workspace';
import { type OrgField, type OrgRecord, payloadFor, recordLabel } from '../admin/org-kinds';
import { Attachments } from '../ui/attachments';
import { AuditHistory } from '../ui/audit-history';
import { ConfirmService } from '../ui/confirm';
import { formatDate } from '../ui/dates';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField, FormSection } from '../ui/form-field';
import { Action } from '../ui/load';
import { PageDetail } from '../ui/page-detail';
import { ErrorState, Skeleton } from '../ui/states';
import { ToastService } from '../ui/toasts';
import { groupIban, HOLIDAY_KINDS, REF_KINDS, WEEKDAYS } from './reference-kinds';

import { CalendarPage, type CalendarEvent, shiftMonth } from '../ui/templates';

interface Holiday {
  id: string;
  date: string;
  name: string;
  kind: string;
}

/**
 * Criar (`:id = novo`) ou ver/alterar um registo de referência. Painéis próprios: feriados e dias úteis (calendários),
 * próximo número (séries), IBAN, aprovação e inactivação (contas bancárias).
 */
@Component({
  selector: 'app-reference-form',
  imports: [
    FormsModule,
    RouterLink,
    PageDetail,
    ErrorAlert,
    ErrorState,
    Skeleton,
    FormSection,
    FormField,
    FieldControl,
    Attachments,
    AuditHistory,
    CalendarPage,
  ],
  template: `
    @if (meta(); as k) {
      @if (loadError()) {
        <app-error-state [error]="loadError()" (retry)="reload()" />
      } @else if (!loaded()) {
        <div class="card"><app-skeleton /></div>
      } @else {
        <app-page-detail
          [title]="isNew() ? (k.feminine ? 'Nova ' : 'Novo ') + k.singular : k.title_(record()!)"
          [status]="isNew() ? null : $any(record()?.['status'])"
        >
          <ng-container actions>
            <a class="btn-secondary" [routerLink]="['/empresa', k.segment]">Voltar à lista</a>
          </ng-container>

          @if (k.segment === 'bank-accounts' && record(); as r) {
            <section class="card space-y-2 text-sm" aria-labelledby="bank-title">
              <h2 id="bank-title" class="font-semibold">Dados bancários</h2>
              <p>
                IBAN:
                <span class="font-mono" data-testid="iban">{{ iban(r) ?? '—' }}</span>
              </p>
              @if (r['status'] === 'PENDING_APPROVAL') {
                <p class="rounded-md bg-warning-soft p-2 text-warning-text">
                  A conta só fica utilizável depois de aprovada.
                  @if (r['approvalRequestId']) {
                    <a
                      class="btn-link"
                      [routerLink]="['/aprovacoes/pedidos', r['approvalRequestId']]"
                      >Ver pedido de aprovação</a
                    >
                  }
                </p>
              }
              <p class="text-xs text-muted">
                Os dados bancários não se alteram (protecção contra fraude): para mudar, crie outra
                conta e inactive esta.
              </p>
              @if (canManage() && r['status'] === 'ACTIVE') {
                <button
                  type="button"
                  class="btn-danger"
                  [disabled]="action.busy()"
                  (click)="deactivate()"
                >
                  Inactivar conta
                </button>
              }
            </section>
          }

          <form class="space-y-4" (ngSubmit)="save()" novalidate>
            <app-error-alert [error]="action.error()" [showDetails]="false" />
            <app-form-section [title]="k.title" description="Campos marcados são obrigatórios.">
              @for (f of k.fields; track f.key) {
                <app-field
                  [label]="f.label"
                  [required]="!!f.required"
                  [hint]="
                    isNew()
                      ? (f.hint ?? null)
                      : f.immutable
                        ? 'Não se altera depois de criado.'
                        : (f.hint ?? null)
                  "
                  [error]="action.field(f.key)"
                  [class.md:col-span-2]="f.type === 'weekdays'"
                >
                  @switch (f.type) {
                    @case ('select') {
                      <select
                        appControl
                        class="input"
                        [name]="f.key"
                        [disabled]="readonly(f)"
                        [(ngModel)]="form[f.key]"
                      >
                        @if (!f.required && f.key !== 'status') {
                          <option [ngValue]="null">—</option>
                        }
                        @for (o of f.options; track o.value) {
                          <option [ngValue]="o.value">{{ o.label }}</option>
                        }
                      </select>
                    }
                    @case ('boolean') {
                      <select
                        appControl
                        class="input"
                        [name]="f.key"
                        [disabled]="readonly(f)"
                        [(ngModel)]="form[f.key]"
                      >
                        <option [ngValue]="false">Não</option>
                        <option [ngValue]="true">Sim</option>
                      </select>
                    }
                    @case ('ref') {
                      <select
                        appControl
                        class="input"
                        [name]="f.key"
                        [disabled]="readonly(f)"
                        [(ngModel)]="form[f.key]"
                      >
                        <option [ngValue]="null">—</option>
                        @for (o of options(f); track o.id) {
                          <option [ngValue]="o.id">{{ o.label }}</option>
                        }
                      </select>
                    }
                    @case ('weekdays') {
                      <fieldset class="flex flex-wrap gap-3" [disabled]="readonly(f)">
                        <legend class="sr-only">{{ f.label }}</legend>
                        @for (d of weekdays; track d.value) {
                          <label class="flex items-center gap-1 text-sm">
                            <input
                              type="checkbox"
                              [checked]="hasDay(d.value)"
                              (change)="toggleDay(d.value)"
                            />
                            {{ d.label }}
                          </label>
                        }
                      </fieldset>
                    }
                    @case ('date') {
                      <input
                        appControl
                        type="date"
                        class="input"
                        [name]="f.key"
                        [disabled]="readonly(f)"
                        [(ngModel)]="form[f.key]"
                      />
                    }
                    @case ('number') {
                      <input
                        appControl
                        type="number"
                        class="input"
                        [name]="f.key"
                        [disabled]="readonly(f)"
                        [(ngModel)]="form[f.key]"
                      />
                    }
                    @default {
                      <input
                        appControl
                        class="input"
                        [name]="f.key"
                        [disabled]="readonly(f)"
                        [(ngModel)]="form[f.key]"
                      />
                    }
                  }
                </app-field>
              }
            </app-form-section>
            @if (canManage() && editable()) {
              <div class="flex items-center gap-3">
                <button type="submit" class="btn-primary" [disabled]="action.busy()">
                  {{ action.busy() ? 'A guardar…' : isNew() ? 'Criar' : 'Guardar alterações' }}
                </button>
                @if (hasUnsavedChanges()) {
                  <span class="text-sm text-muted" role="status">Alterações por guardar</span>
                }
              </div>
            }
          </form>

          @if (k.segment === 'calendars' && record(); as r) {
            <app-calendar-month
              label="Vista mensal do calendário"
              [year]="calYear()"
              [month]="calMonth()"
              [weekendDays]="$any(r['weekendDays']) ?? []"
              [events]="holidayEvents()"
              (monthChange)="setMonth($event.year, $event.month)"
              (goToday)="setMonth(todayYear, todayMonth)"
            >
              <p class="mb-2 text-sm text-muted" data-testid="cal-working-days">
                @if (monthWorkingDays() !== null) {
                  {{ monthWorkingDays() }} dia(s) útil(eis) neste mês (cálculo do servidor, com
                  feriados e dias de descanso).
                } @else {
                  A calcular dias úteis…
                }
              </p>
            </app-calendar-month>
            <section class="card" aria-labelledby="hol-title">
              <h2 id="hol-title" class="font-semibold">Feriados</h2>
              @if (holidays().length === 0) {
                <p class="mt-2 text-sm text-muted">Sem feriados registados.</p>
              } @else {
                <ul class="mt-2 divide-y divide-border text-sm" data-testid="holidays">
                  @for (h of holidays(); track h.id) {
                    <li class="flex flex-wrap items-center justify-between gap-2 py-2">
                      <span
                        >{{ date(h.date) }} · {{ h.name }}
                        <span class="text-muted">({{ holidayKind(h.kind) }})</span></span
                      >
                      @if (canManage()) {
                        <button
                          type="button"
                          class="btn-secondary"
                          [disabled]="holidayAction.busy()"
                          (click)="removeHoliday(h)"
                        >
                          Remover
                        </button>
                      }
                    </li>
                  }
                </ul>
              }
              @if (canManage()) {
                <form
                  class="mt-3 grid gap-3 border-t border-border pt-3 md:grid-cols-4"
                  (ngSubmit)="addHoliday()"
                  aria-label="Adicionar feriado"
                >
                  <app-error-alert
                    class="md:col-span-4"
                    [error]="holidayAction.error()"
                    [showDetails]="true"
                  />
                  <div>
                    <label class="label" for="h-date">Data</label>
                    <input
                      id="h-date"
                      name="hDate"
                      type="date"
                      class="input"
                      [(ngModel)]="newHoliday.date"
                    />
                  </div>
                  <div>
                    <label class="label" for="h-name">Nome</label>
                    <input id="h-name" name="hName" class="input" [(ngModel)]="newHoliday.name" />
                  </div>
                  <div>
                    <label class="label" for="h-kind">Tipo</label>
                    <select id="h-kind" name="hKind" class="input" [(ngModel)]="newHoliday.kind">
                      @for (o of holidayKinds; track o.value) {
                        <option [value]="o.value">{{ o.label }}</option>
                      }
                    </select>
                  </div>
                  <div class="flex items-end">
                    <button
                      type="submit"
                      class="btn-primary"
                      [disabled]="holidayAction.busy() || !newHoliday.date || !newHoliday.name"
                    >
                      Adicionar
                    </button>
                  </div>
                </form>
              }
            </section>
            <section class="card" aria-labelledby="wd-title">
              <h2 id="wd-title" class="font-semibold">Dias úteis</h2>
              <p class="mt-1 text-xs text-muted">
                Conta os dias entre duas datas (inclusive), sem descanso semanal nem feriados.
              </p>
              <form class="mt-2 flex flex-wrap items-end gap-2" (ngSubmit)="countWorkingDays()">
                <div>
                  <label class="label" for="wd-from">De</label>
                  <input
                    id="wd-from"
                    name="wdFrom"
                    type="date"
                    class="input"
                    [(ngModel)]="range.from"
                  />
                </div>
                <div>
                  <label class="label" for="wd-to">Até</label>
                  <input id="wd-to" name="wdTo" type="date" class="input" [(ngModel)]="range.to" />
                </div>
                <button type="submit" class="btn-secondary" [disabled]="!range.from || !range.to">
                  Calcular
                </button>
                @if (workingDays() !== null) {
                  <p class="text-sm" role="status" data-testid="working-days">
                    <strong>{{ workingDays() }}</strong> dia(s) útil(eis)
                  </p>
                }
              </form>
              <app-error-alert [error]="rangeAction.error()" />
            </section>
          }

          <div aside>
            @if (k.segment === 'document-series' && record(); as r) {
              <section class="card text-sm" aria-labelledby="next-title">
                <h2 id="next-title" class="font-semibold">Próximo documento</h2>
                <p class="mt-2 font-mono text-lg" data-testid="next-number">
                  {{ r['nextFormatted'] }}
                </p>
                <p class="mt-1 text-xs text-muted">
                  A numeração é atribuída pelo servidor no momento da emissão, sem lacunas.
                </p>
              </section>
            }
            @if (!isNew() && record(); as r) {
              @if (attachmentsAllowed()) {
                <app-attachments
                  [subjectType]="k.entityType"
                  [subjectId]="r.id"
                  [canWrite]="canManage()"
                />
              }
              <app-audit-history
                [entityType]="k.entityType"
                [entityId]="r.id"
                [refreshKey]="r.version"
              />
            }
          </div>
        </app-page-detail>
      }
    }
  `,
})
export class ReferenceForm implements HasUnsavedChanges {
  readonly kind = input.required<string>();
  readonly id = input.required<string>();
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  protected readonly workspace = inject(Workspace);
  protected readonly weekdays = WEEKDAYS;
  protected readonly holidayKinds = HOLIDAY_KINDS;
  protected readonly date = formatDate;
  protected readonly iban = (r: OrgRecord) => groupIban(r['iban'] as string | null);
  protected readonly meta = computed(() => REF_KINDS[this.kind()] ?? null);
  protected readonly isNew = computed(() => this.id() === 'novo');
  protected readonly canManage = computed(() => {
    const m = this.meta();
    return !!m && this.workspace.can(m.managePermission);
  });
  /** Anexos só existem para contas bancárias (os outros tipos não são assunto de anexos). */
  protected readonly attachmentsAllowed = computed(() => this.kind() === 'bank-accounts');
  /** Uma conta rejeitada ou inactiva já não se altera; uma série fechada também não. */
  protected readonly editable = computed(() => {
    const r = this.record();
    if (!r) return true;
    if (this.kind() === 'bank-accounts') return r['status'] === 'ACTIVE';
    if (this.kind() === 'document-series') return r['status'] !== 'CLOSED';
    return true;
  });
  protected readonly record = signal<OrgRecord | null>(null);
  protected readonly loaded = signal(false);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly refs = signal<Record<string, OrgRecord[]>>({});
  protected readonly holidays = signal<Holiday[]>([]);
  protected readonly todayYear = new Date().getFullYear();
  protected readonly todayMonth = new Date().getMonth() + 1;
  protected readonly calYear = signal(this.todayYear);
  protected readonly calMonth = signal(this.todayMonth);
  protected readonly monthWorkingDays = signal<number | null>(null);
  protected readonly holidayEvents = computed<CalendarEvent[]>(() =>
    this.holidays().map((h) => ({ date: h.date, label: h.name, tone: 'warning' })),
  );
  private workingSeq = 0;

  /** Muda o mês da vista e pede ao servidor os dias úteis desse mês. */
  protected async setMonth(year: number, month: number) {
    this.calYear.set(year);
    this.calMonth.set(month);
    const id = this.record()?.id;
    if (!id || this.meta()?.segment !== 'calendars') return;
    const seq = ++this.workingSeq;
    this.monthWorkingDays.set(null);
    const next = shiftMonth(year, month, 1);
    const last = new Date(Date.UTC(next.year, next.month - 1, 0)).getUTCDate();
    const pad = (n: number) => String(n).padStart(2, '0');
    try {
      const r = await this.api.get<{ workingDays: number }>(`calendars/${id}/working-days`, {
        from: `${year}-${pad(month)}-01`,
        to: `${year}-${pad(month)}-${pad(last)}`,
      });
      if (seq === this.workingSeq) this.monthWorkingDays.set(r.workingDays);
    } catch {
      if (seq === this.workingSeq) this.monthWorkingDays.set(null);
    }
  }
  protected readonly workingDays = signal<number | null>(null);
  protected readonly action = new Action();
  protected readonly holidayAction = new Action();
  protected readonly rangeAction = new Action();
  protected form: Record<string, unknown> = {};
  protected newHoliday = { date: '', name: '', kind: 'NATIONAL' };
  protected range = { from: '', to: '' };
  private initial = '';

  constructor() {
    warnOnUnload(this);
    effect(() => {
      const kind = this.kind();
      const id = this.id();
      untracked(() => void this.load(kind, id));
    });
  }

  hasUnsavedChanges() {
    return this.loaded() && this.canManage() && snapshot(this.form) !== this.initial;
  }

  protected reload() {
    void this.load(this.kind(), this.id());
  }

  private async load(kind: string, id: string) {
    const meta = REF_KINDS[kind];
    if (!meta) return;
    this.loaded.set(false);
    this.loadError.set(null);
    this.workingDays.set(null);
    try {
      const refKinds = [...new Set(meta.fields.filter((f) => f.ref).map((f) => f.ref!))];
      const pages = this.workspace.can('organization.read')
        ? await Promise.all(
            refKinds.map((r) => this.api.page<OrgRecord>(`organization/${r}`, { limit: 200 })),
          )
        : refKinds.map(() => ({ items: [] as OrgRecord[], total: 0 }));
      this.refs.set(Object.fromEntries(refKinds.map((r, i) => [r, pages[i].items])));
      if (id === 'novo') {
        this.record.set(null);
        this.holidays.set([]);
        const legalEntityId = this.workspace.legalEntityId();
        this.form = {
          ...(kind === 'document-series' ? { status: 'ACTIVE', padding: 6, nextNumber: 1 } : {}),
          ...(kind === 'calendars'
            ? { status: 'ACTIVE', countryCode: 'AO', weekendDays: [6, 7] }
            : {}),
          ...(kind === 'bank-accounts' ? { isDefault: false } : {}),
          ...(legalEntityId && meta.fields.some((f) => f.key === 'legalEntityId' && f.required)
            ? { legalEntityId }
            : {}),
        };
      } else {
        const record = await this.api.get<OrgRecord & { holidays?: Holiday[] }>(`${kind}/${id}`);
        this.setRecord(record);
      }
      this.initial = snapshot(this.form);
      this.loaded.set(true);
    } catch (error) {
      this.loadError.set(ApiError.from(error));
    }
  }

  private setRecord(record: OrgRecord & { holidays?: Holiday[] }) {
    const { holidays, ...rest } = record;
    if (holidays) this.holidays.set(holidays);
    this.record.set(rest as OrgRecord);
    this.form = { ...rest };
    this.breadcrumbs.setCurrent(this.meta()!.title_(rest));
    if (this.meta()?.segment === 'calendars') void this.setMonth(this.calYear(), this.calMonth());
  }

  protected readonly = (f: OrgField) =>
    !this.canManage() || !this.editable() || (!this.isNew() && f.immutable === true);

  protected options(f: OrgField) {
    const legalEntityId = this.form['legalEntityId'];
    return (this.refs()[f.ref!] ?? [])
      .filter(
        (r) => !legalEntityId || !('legalEntityId' in r) || r['legalEntityId'] === legalEntityId,
      )
      .map((r) => ({ id: r.id, label: recordLabel(r) }));
  }

  protected hasDay(day: number) {
    return ((this.form['weekendDays'] as number[] | undefined) ?? []).includes(day);
  }

  protected toggleDay(day: number) {
    const days = (this.form['weekendDays'] as number[] | undefined) ?? [];
    this.form = {
      ...this.form,
      weekendDays: (days.includes(day) ? days.filter((d) => d !== day) : [...days, day]).sort(),
    };
  }

  protected holidayKind(kind: string) {
    return HOLIDAY_KINDS.find((k) => k.value === kind)?.label ?? kind;
  }

  protected async save() {
    if (this.action.busy()) return;
    const meta = this.meta()!;
    const original = this.record();
    const body = payloadFor(meta, this.form, original);
    if (original && Object.keys(body).length === 0) {
      this.toasts.show('Nada para guardar.', 'info');
      return;
    }
    const result = await this.action.run(() =>
      original
        ? this.api.patch<OrgRecord>(`${meta.segment}/${original.id}`, {
            ...body,
            expectedVersion: original.version,
          })
        : this.api.post<OrgRecord>(meta.segment, body),
    );
    if (!result) {
      if (this.action.error()?.code === 'VERSION_CONFLICT')
        this.toasts.show(
          'Outra pessoa alterou este registo. Recarregue para ver a versão actual.',
          'error',
          0,
        );
      return;
    }
    this.initial = snapshot({ ...result });
    if (!original) {
      this.form = { ...result };
      this.toasts.show(
        result['status'] === 'PENDING_APPROVAL'
          ? 'Conta criada e submetida a aprovação.'
          : 'Registo criado.',
      );
      await this.router.navigate(['/empresa', meta.segment, result.id]);
      return;
    }
    // O detalhe (com feriados) vem do GET; o PATCH devolve o registo.
    this.setRecord({ ...result, holidays: undefined });
    this.initial = snapshot(this.form);
    this.toasts.show('Alterações guardadas.');
  }

  protected async deactivate() {
    const r = this.record()!;
    const ok = await this.confirm.ask({
      title: 'Inactivar conta bancária',
      message: 'A conta deixa de poder ser usada em pagamentos e recebimentos. Não se reactiva.',
      confirmLabel: 'Inactivar',
      danger: true,
    });
    if (!ok) return;
    const result = await this.action.run(() =>
      this.api.patch<OrgRecord>(`bank-accounts/${r.id}`, {
        status: 'INACTIVE',
        expectedVersion: r.version,
      }),
    );
    if (result) {
      this.setRecord(result);
      this.initial = snapshot(this.form);
      this.toasts.show('Conta inactivada.');
    }
  }

  protected async addHoliday() {
    const r = this.record()!;
    const added = await this.holidayAction.run(() =>
      this.api.post<{ id: string; holidays: Holiday[] }>(`calendars/${r.id}/holidays`, {
        ...this.newHoliday,
      }),
    );
    if (!added) return;
    this.holidays.set(added.holidays);
    void this.setMonth(this.calYear(), this.calMonth());
    this.newHoliday = { date: '', name: '', kind: this.newHoliday.kind };
    this.workingDays.set(null);
    this.toasts.show('Feriado adicionado.');
  }

  protected async removeHoliday(h: Holiday) {
    const ok = await this.confirm.ask({
      title: 'Remover feriado',
      message: `Remover "${h.name}" (${formatDate(h.date)})?`,
      confirmLabel: 'Remover',
      danger: true,
    });
    if (!ok) return;
    await this.holidayAction.run(() =>
      this.api.delete(`calendars/${this.record()!.id}/holidays/${h.id}`),
    );
    if (this.holidayAction.error()) return;
    this.holidays.update((list) => list.filter((x) => x.id !== h.id));
    void this.setMonth(this.calYear(), this.calMonth());
    this.workingDays.set(null);
    this.toasts.show('Feriado removido.');
  }

  protected async countWorkingDays() {
    const result = await this.rangeAction.run(() =>
      this.api.get<{ workingDays: number }>(`calendars/${this.record()!.id}/working-days`, {
        from: this.range.from,
        to: this.range.to,
      }),
    );
    this.workingDays.set(result ? result.workingDays : null);
  }
}
