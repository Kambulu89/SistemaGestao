import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { formatDate } from '../ui/dates';
import { FieldList } from '../ui/detail-drawer';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField } from '../ui/form-field';
import { Kpi } from '../ui/kpi';
import { Action } from '../ui/load';
import { Modal } from '../ui/modal';
import { formatMoney } from '../ui/money-input';
import { PageHeader } from '../ui/page-header';
import { EmptyState, ErrorState, Skeleton } from '../ui/states';
import { ToastService } from '../ui/toasts';
import { CONTRACT_STATUS, CONTRACT_TYPE, type ContractStatus } from './contracts-model';
import { LeaveRequestDialog } from './leave-request-dialog';
import {
  daysLabel,
  LEAVE_STATUS,
  type LeaveRequest,
  type LeaveStatus,
  type LeaveSummary,
  leaveTone,
} from './leave-model';
import { LOAN_KIND, LOAN_STATUS, type LoanKind, type LoanStatus } from './loans-model';
import { monthName, type MyPayslip } from './payroll-model';
import { type MySpace, SELF_FIELD_LABEL } from './portal-model';
import { saveFile } from './save-file';

/**
 * O meu espaço (self-service): a própria ficha, contratos, férias e pedidos, recibos, formação e empréstimos. Só os
 * contactos se editam aqui; o resto é dos RH. A API só devolve dados da ficha ligada à conta.
 */
@Component({
  selector: 'app-my-space',
  imports: [
    FormsModule,
    RouterLink,
    PageHeader,
    FieldList,
    DataTable,
    CellDef,
    Kpi,
    Modal,
    FormField,
    FieldControl,
    ErrorAlert,
    ErrorState,
    EmptyState,
    Skeleton,
    LeaveRequestDialog,
  ],
  template: `
    <app-page-header
      title="O meu espaço"
      subtitle="Os seus dados, contratos, férias, recibos e formação."
    />
    @if (notLinked()) {
      <app-empty-state
        icon="user"
        title="Sem ficha de colaborador"
        description="A sua conta não está ligada a uma ficha de colaborador. Fale com os recursos humanos."
      />
    } @else if (loadError()) {
      <app-error-state [error]="loadError()" (retry)="load()" />
    } @else if (!me()) {
      <div class="card"><app-skeleton /></div>
    } @else {
      @let m = me()!;
      <div class="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <app-kpi
          label="Férias disponíveis"
          [value]="leave() ? days(leave()!.balance.available) : '—'"
          [detail]="leave() ? 'Ano ' + leave()!.balance.year : null"
          testId="ms-available"
        />
        <app-kpi
          label="Pedidos pendentes"
          [value]="pendingCount()"
          [tone]="pendingCount() ? 'warning' : 'neutral'"
        />
        <app-kpi label="Recibos" [value]="payslips().length" link="/rh/recibos" />
        <app-kpi label="Certificados" [value]="m.certificates.length" />
      </div>

      <div class="grid gap-4 lg:grid-cols-3">
        <section class="card lg:col-span-2" aria-labelledby="ms-profile" data-testid="ms-profile">
          <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 id="ms-profile" class="font-semibold">Os meus dados</h2>
            <button type="button" class="btn-secondary" data-testid="ms-edit" (click)="openEdit()">
              Actualizar contactos
            </button>
          </div>
          <app-field-list
            [fields]="[
              { label: 'Colaborador', value: m.profile.code + ' — ' + m.profile.fullName },
              { label: 'Entidade', value: m.profile.legalEntity.name },
              { label: 'Departamento', value: m.profile.departmentName },
              { label: 'Cargo', value: m.profile.positionName },
              { label: 'Chefia', value: m.profile.manager?.fullName },
              { label: 'Admissão', value: date(str(m.profile['hireDate'])) },
              { label: 'NIF', value: str(m.profile['taxId']) },
              { label: 'Segurança social', value: str(m.profile['socialSecurityNumber']) },
              { label: 'Conta (IBAN)', value: str(m.profile['bankIban']) },
              { label: 'Email pessoal', value: str(m.profile['personalEmail']) },
              { label: 'Telefone pessoal', value: str(m.profile['personalPhone']) },
              { label: 'Morada', value: address() },
              { label: 'Contacto de emergência', value: emergency() },
            ]"
          />
          <p class="mt-3 text-xs text-muted">
            Para corrigir identificação, IBAN ou outros dados, fale com os recursos humanos.
          </p>
        </section>

        <section class="card" aria-labelledby="ms-contract" data-testid="ms-contract">
          <h2 id="ms-contract" class="mb-3 font-semibold">Contrato em vigor</h2>
          @if (m.currentTerms; as c) {
            <app-field-list
              [fields]="[
                { label: 'Contrato', value: contractCode(c.contractId) },
                {
                  label: 'Remuneração base',
                  value: c.baseSalary ? money(c.baseSalary) + ' ' + c.currency : null,
                },
                { label: 'Horas semanais', value: c.weeklyHours },
                { label: 'Horário', value: c.workSchedule },
                { label: 'Termo', value: c.endDate ? date(c.endDate) : 'Sem termo' },
              ]"
            />
          } @else {
            <p class="text-sm text-muted">Sem contrato em vigor.</p>
          }
        </section>
      </div>

      <section class="card mt-4" aria-labelledby="ms-leave" data-testid="ms-leave">
        <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 id="ms-leave" class="font-semibold">As minhas ausências</h2>
          @if (leave()?.access?.request) {
            <button
              type="button"
              class="btn-primary"
              data-testid="ms-request"
              (click)="requesting.set(true)"
            >
              Pedir ausência
            </button>
          }
        </div>
        @if (leave(); as l) {
          <p class="mb-3 text-sm text-muted">
            Direito {{ days(l.balance.entitled) }} · gozadas {{ days(l.balance.taken) }} · pendentes
            {{ days(l.balance.pending) }} · saldo {{ days(l.balance.balance) }}
          </p>
        }
        <app-data-table
          label="As minhas ausências"
          [columns]="requestColumns"
          [rows]="requests()"
          [total]="requests().length"
          [limit]="200"
          emptyText="Sem pedidos."
        >
          <ng-template appCell="status" let-row>
            <span class="badge" [class]="leaveTone(row.status)">{{ leaveStatus(row.status) }}</span>
          </ng-template>
        </app-data-table>
      </section>

      <div class="mt-4 grid gap-4 lg:grid-cols-2">
        <section class="card" aria-labelledby="ms-payslips" data-testid="ms-payslips">
          <div class="mb-3 flex items-center justify-between">
            <h2 id="ms-payslips" class="font-semibold">Últimos recibos</h2>
            <a class="link text-sm" routerLink="/rh/recibos">Todos</a>
          </div>
          @if (!payslips().length) {
            <p class="text-sm text-muted">Sem recibos.</p>
          }
          <ul class="divide-y divide-border text-sm">
            @for (p of payslips().slice(0, 6); track p.id) {
              <li class="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>{{ month(p.period) }} · líquido {{ money(p.net) }} {{ p.currency }}</span>
                <button
                  type="button"
                  class="link"
                  [attr.aria-label]="'Descarregar recibo de ' + month(p.period)"
                  (click)="download(p)"
                >
                  PDF
                </button>
              </li>
            }
          </ul>
        </section>

        <section class="card" aria-labelledby="ms-contracts">
          <h2 id="ms-contracts" class="mb-3 font-semibold">Histórico de contratos</h2>
          <ul class="divide-y divide-border text-sm" data-testid="ms-contracts">
            @for (c of m.contracts; track c.id) {
              <li class="py-2">
                <p>
                  <span class="font-medium">{{ c.code }}</span> ·
                  {{ contractType(c.contractType) }} · {{ contractStatus(c.status) }}
                </p>
                <p class="text-xs text-muted">
                  {{ date(c.startDate) }} –
                  {{
                    c.terminationDate
                      ? date(c.terminationDate)
                      : c.endDate
                        ? date(c.endDate)
                        : 'sem termo'
                  }}
                </p>
              </li>
            } @empty {
              <li class="py-2 text-muted">Sem contratos.</li>
            }
          </ul>
        </section>

        <section class="card" aria-labelledby="ms-training">
          <h2 id="ms-training" class="mb-3 font-semibold">Certificados</h2>
          <ul class="divide-y divide-border text-sm">
            @for (c of m.certificates; track c.id) {
              <li class="py-2">
                <p class="font-medium">{{ c.name }}</p>
                <p class="text-xs text-muted">
                  {{ c.issuer }} · {{ date(c.issuedOn)
                  }}{{ c.expiresOn ? ' – ' + date(c.expiresOn) : '' }}
                </p>
              </li>
            } @empty {
              <li class="py-2 text-muted">Sem certificados.</li>
            }
          </ul>
        </section>

        <section class="card" aria-labelledby="ms-loans">
          <h2 id="ms-loans" class="mb-3 font-semibold">Adiantamentos e empréstimos</h2>
          <ul class="divide-y divide-border text-sm">
            @for (l of m.loans; track l.id) {
              <li class="py-2">
                <p>
                  <span class="font-medium">{{ l.code }}</span> · {{ loanKind(l.kind) }} ·
                  {{ loanStatus(l.status) }}
                </p>
                <p class="text-xs text-muted">
                  {{ money(l.principal) }} {{ l.currency }} · por liquidar
                  {{ money(l.outstanding) }}
                </p>
              </li>
            } @empty {
              <li class="py-2 text-muted">Sem adiantamentos nem empréstimos.</li>
            }
          </ul>
        </section>
      </div>
    }

    <app-leave-request-dialog
      [open]="requesting()"
      [employeeId]="me()?.profile?.id ?? null"
      (closed)="requesting.set(false)"
      (created)="afterRequest()"
    />

    <app-modal title="Actualizar contactos" [open]="editing()" (closed)="editing.set(false)">
      <app-error-alert [error]="action.error()" [showDetails]="false" />
      <div class="grid gap-3 sm:grid-cols-2">
        @for (k of fields(); track k) {
          <app-field [label]="label(k)" [error]="action.field(k)">
            <input
              appControl
              class="input"
              [attr.data-testid]="'ms-' + k"
              [(ngModel)]="form[k]"
              [ngModelOptions]="{ standalone: true }"
            />
          </app-field>
        }
      </div>
      <ng-container actions>
        <button type="button" class="btn-secondary" (click)="editing.set(false)">Cancelar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="ms-save"
          [disabled]="action.busy()"
          (click)="save()"
        >
          Guardar
        </button>
      </ng-container>
    </app-modal>
  `,
})
export class MySpacePage {
  private readonly api = inject(Api);
  private readonly toasts = inject(ToastService);
  protected readonly me = signal<MySpace | null>(null);
  protected readonly leave = signal<LeaveSummary | null>(null);
  protected readonly requests = signal<LeaveRequest[]>([]);
  protected readonly payslips = signal<MyPayslip[]>([]);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly notLinked = signal(false);
  protected readonly editing = signal(false);
  protected readonly requesting = signal(false);
  protected readonly action = new Action();
  protected form: Record<string, string> = {};
  protected readonly fields = computed(() => this.me()?.selfEditable ?? []);
  protected readonly pendingCount = computed(
    () => this.requests().filter((r) => r.status === 'PENDING').length,
  );
  protected readonly date = (d: string | null | undefined) => (d ? formatDate(d) : null);
  protected readonly money = (v: string) => formatMoney(v);
  protected readonly days = daysLabel;
  protected readonly month = monthName;
  protected readonly leaveTone = leaveTone;
  protected readonly leaveStatus = (s: LeaveStatus) => LEAVE_STATUS[s];
  protected readonly contractType = (t: string) =>
    CONTRACT_TYPE[t as keyof typeof CONTRACT_TYPE] ?? t;
  protected readonly contractStatus = (s: string) => CONTRACT_STATUS[s as ContractStatus] ?? s;
  protected readonly loanKind = (k: string) => LOAN_KIND[k as LoanKind] ?? k;
  protected readonly loanStatus = (s: string) => LOAN_STATUS[s as LoanStatus] ?? s;
  protected readonly label = (k: string) => SELF_FIELD_LABEL[k] ?? k;
  protected readonly str = (v: unknown) => (typeof v === 'string' && v ? v : null);
  protected readonly requestColumns: Column<LeaveRequest>[] = [
    { key: 'type', label: 'Tipo', value: (r) => r.leaveType.name },
    {
      key: 'period',
      label: 'Período',
      value: (r) => `${formatDate(r.startDate)} – ${formatDate(r.endDate)}`,
    },
    { key: 'days', label: 'Dias', value: (r) => daysLabel(r.days), hideOnMobile: true },
    { key: 'status', label: 'Estado', value: (r) => LEAVE_STATUS[r.status as LeaveStatus] },
  ];
  protected readonly address = computed(() => {
    const p = this.me()?.profile;
    if (!p) return null;
    return (
      [p['addressLine'], p['city'], p['province'], p['countryCode']]
        .filter((x) => typeof x === 'string' && x)
        .join(', ') || null
    );
  });
  protected readonly emergency = computed(() => {
    const p = this.me()?.profile;
    if (!p || !p['emergencyName']) return null;
    return [p['emergencyName'], p['emergencyRelation'], p['emergencyPhone']]
      .filter((x) => typeof x === 'string' && x)
      .join(' · ');
  });

  constructor() {
    void this.load();
  }

  protected contractCode(id: string) {
    return this.me()?.contracts.find((c) => c.id === id)?.code ?? null;
  }

  protected async load() {
    this.loadError.set(null);
    try {
      this.me.set(await this.api.get<MySpace>('hr/me'));
    } catch (error) {
      const e = ApiError.from(error);
      if (e.code === 'NOT_LINKED') this.notLinked.set(true);
      else this.loadError.set(e);
      return;
    }
    await Promise.all([this.loadLeave(), this.loadPayslips()]);
  }

  private async loadLeave() {
    try {
      this.leave.set(await this.api.get<LeaveSummary>('hr/leave/me'));
      const page = await this.api.page<LeaveRequest>('hr/leave/requests', {
        mine: true,
        limit: 50,
      });
      this.requests.set(page.items);
    } catch {
      this.leave.set(null);
    }
  }

  private async loadPayslips() {
    try {
      this.payslips.set(await this.api.get<MyPayslip[]>('hr/payslips'));
    } catch {
      this.payslips.set([]);
    }
  }

  protected async afterRequest() {
    this.requesting.set(false);
    this.toasts.show('Pedido enviado.');
    await this.loadLeave();
  }

  protected async download(p: MyPayslip) {
    try {
      const { blob, fileName } = await this.api.download(`hr/payslips/${p.id}`);
      saveFile(blob, fileName ?? `recibo-${p.period.slice(0, 7)}.pdf`);
    } catch (error) {
      this.toasts.show(ApiError.from(error).message, 'error');
    }
  }

  protected openEdit() {
    const p = this.me()!.profile;
    this.action.error.set(null);
    this.form = Object.fromEntries(this.fields().map((k) => [k, (p[k] as string) ?? '']));
    this.editing.set(true);
  }

  protected async save() {
    const p = this.me()!.profile;
    const body: Record<string, unknown> = { expectedVersion: p.version };
    for (const k of this.fields())
      if ((this.form[k] ?? '') !== ((p[k] as string) ?? '')) body[k] = this.form[k];
    const r = await this.action.run(() => this.api.patch<MySpace['profile']>('hr/me', body));
    if (!r) return;
    this.editing.set(false);
    this.toasts.show('Contactos actualizados.');
    await this.load();
  }
}
