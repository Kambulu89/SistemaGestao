import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { ApiError } from '../core/api';
import { Breadcrumbs } from '../core/breadcrumbs';
import { type HasUnsavedChanges, snapshot, warnOnUnload } from '../core/unsaved';
import { type OrgRecord, recordLabel } from '../admin/org-kinds';
import { AuditHistory } from '../ui/audit-history';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField, FormSection } from '../ui/form-field';
import { Action } from '../ui/load';
import { PageDetail } from '../ui/page-detail';
import { ErrorState, Skeleton } from '../ui/states';
import { ToastService } from '../ui/toasts';
import {
  type Account,
  amountKeys,
  type Chart,
  type Journal,
  normalizeAmount,
  type PostingEventView,
  type PostingRule,
  type PostingRuleLine,
} from './model';
import { accountingDeps, legalEntityOptions } from './shared';

const blank = (side: 'DEBIT' | 'CREDIT'): PostingRuleLine => ({
  side,
  accountId: null,
  amountKey: side === 'DEBIT' ? 'total' : 'net',
  description: null,
  costCenterId: null,
  useEventCostCenter: false,
  useEventThirdParty: false,
});
const today = () => new Date().toISOString().slice(0, 10);

interface Simulation {
  ruleId: string | null;
  lines: (PostingRuleLine & { debit: string | null; credit: string | null })[];
  issues: { path: string; code: string; message: string }[];
}

/**
 * Criar ou alterar uma regra de contabilização e testá-la: simular um evento (sem gravar) ou enviá-lo ao motor
 * (fica registado e, conforme a regra, contabilizado ou em rascunho). Uma regra já usada não muda: fecha-se a
 * vigência e cria-se outra.
 */
@Component({
  selector: 'app-posting-rule-form',
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
    AuditHistory,
  ],
  template: `
    @if (loadError()) {
      <app-error-state [error]="loadError()" (retry)="reload()" />
    } @else if (!loaded()) {
      <div class="card"><app-skeleton /></div>
    } @else {
      <app-page-detail
        [title]="rule() ? rule()!.code + ' — ' + rule()!.name : 'Nova regra de contabilização'"
        [subtitle]="rule() ? rule()!.source + ' · ' + rule()!.event : null"
        [status]="rule()?.status ?? null"
      >
        <ng-container actions
          ><a class="btn-secondary" routerLink="/contabilidade/regras">Voltar</a></ng-container
        >
        @if (rule()?.inUse) {
          <p class="rounded-md bg-info-soft p-3 text-sm text-info-text" role="status">
            Esta regra já contabilizou eventos: origem, evento, diário, início e linhas não mudam.
            Para mudar, defina a data fim e crie uma nova regra a partir do dia seguinte.
          </p>
        }
        <app-error-alert [error]="action.error()" [showDetails]="true" />
        <form class="space-y-4" (ngSubmit)="save()" novalidate>
          <app-form-section
            title="Evento e diário"
            description="Origem e evento como os módulos os enviam (maiúsculas)."
          >
            <app-field
              label="Entidade legal"
              [required]="true"
              [error]="action.field('legalEntityId')"
            >
              <select
                appControl
                class="input"
                name="le"
                [disabled]="!!rule() || !canManage()"
                [(ngModel)]="form.legalEntityId"
                (ngModelChange)="loadReferences()"
              >
                <option [ngValue]="null">—</option>
                @for (o of entities(); track o.id) {
                  <option [ngValue]="o.id">{{ o.label }}</option>
                }
              </select>
            </app-field>
            <app-field label="Código" [required]="true" [error]="action.field('code')">
              <input
                appControl
                class="input"
                name="code"
                [disabled]="!!rule() || !canManage()"
                [(ngModel)]="form.code"
              />
            </app-field>
            <app-field label="Nome" [required]="true" [error]="action.field('name')">
              <input
                appControl
                class="input"
                name="name"
                [disabled]="!canManage()"
                [(ngModel)]="form.name"
              />
            </app-field>
            <app-field label="Diário" [required]="true" [error]="action.field('journalId')">
              <select
                appControl
                class="input"
                name="journal"
                [disabled]="locked()"
                [(ngModel)]="form.journalId"
              >
                <option [ngValue]="null">—</option>
                @for (j of journals(); track j.id) {
                  <option [ngValue]="j.id">{{ j.code }} — {{ j.name }}</option>
                }
              </select>
            </app-field>
            <app-field
              label="Origem"
              [required]="true"
              hint="Ex.: SALES_INVOICE"
              [error]="action.field('source')"
            >
              <input
                appControl
                class="input font-mono"
                name="source"
                [disabled]="locked()"
                [(ngModel)]="form.source"
              />
            </app-field>
            <app-field
              label="Evento"
              [required]="true"
              hint="Ex.: ISSUED"
              [error]="action.field('event')"
            >
              <input
                appControl
                class="input font-mono"
                name="event"
                [disabled]="locked()"
                [(ngModel)]="form.event"
              />
            </app-field>
            <app-field label="Válida desde" [required]="true" [error]="action.field('validFrom')">
              <input
                appControl
                type="date"
                class="input"
                name="from"
                [disabled]="locked()"
                [(ngModel)]="form.validFrom"
              />
            </app-field>
            <app-field label="Válida até" hint="Vazio = sem fim." [error]="action.field('validTo')">
              <input
                appControl
                type="date"
                class="input"
                name="to"
                [disabled]="!canManage()"
                [(ngModel)]="form.validTo"
              />
            </app-field>
            <app-field
              label="Descrição do lançamento"
              hint="Pode usar {source}, {event} e {sourceRef}."
              [error]="action.field('descriptionTemplate')"
              class="md:col-span-2"
            >
              <input
                appControl
                class="input"
                name="tpl"
                [disabled]="!canManage()"
                [(ngModel)]="form.descriptionTemplate"
              />
            </app-field>
            <app-field label="Depois de gerado" [error]="action.field('autoPost')">
              <select
                appControl
                class="input"
                name="autoPost"
                [disabled]="!canManage()"
                [(ngModel)]="form.autoPost"
              >
                <option [ngValue]="false">Fica em rascunho (aprovação normal)</option>
                <option [ngValue]="true">Contabiliza automaticamente</option>
              </select>
            </app-field>
            <app-field label="Estado" [error]="action.field('status')">
              <select
                appControl
                class="input"
                name="status"
                [disabled]="!canManage()"
                [(ngModel)]="form.status"
              >
                <option value="ACTIVE">Activa</option>
                <option value="INACTIVE">Inactiva</option>
              </select>
            </app-field>
          </app-form-section>

          <section class="card overflow-x-auto p-0" aria-labelledby="rule-lines">
            <h2 id="rule-lines" class="p-4 font-semibold">Linhas</h2>
            <p class="px-4 text-xs text-muted">
              Cada linha vai buscar ao evento o montante com a chave indicada. Montante zero omite a
              linha.
            </p>
            <table class="mt-2 w-full min-w-[48rem] text-sm">
              <caption class="sr-only">
                Linhas da regra
              </caption>
              <thead>
                <tr class="border-b border-border text-left">
                  <th scope="col" class="p-2">Lado</th>
                  <th scope="col" class="p-2">Conta</th>
                  <th scope="col" class="p-2">Montante (chave)</th>
                  <th scope="col" class="p-2">Centro de custo</th>
                  <th scope="col" class="p-2">Terceiro do evento</th>
                  <th scope="col" class="p-2"><span class="sr-only">Acções</span></th>
                </tr>
              </thead>
              <tbody>
                @for (l of lines; track $index; let i = $index) {
                  <tr class="border-b border-border align-top">
                    <td class="p-2">
                      <select
                        class="input"
                        [name]="'side' + i"
                        [attr.aria-label]="'Lado da linha ' + (i + 1)"
                        [disabled]="locked()"
                        [(ngModel)]="l.side"
                      >
                        <option value="DEBIT">Débito</option>
                        <option value="CREDIT">Crédito</option>
                      </select>
                    </td>
                    <td class="p-2">
                      <select
                        class="input"
                        [name]="'acc' + i"
                        [attr.aria-label]="'Conta da linha ' + (i + 1)"
                        [disabled]="locked()"
                        [(ngModel)]="l.accountId"
                      >
                        <option [ngValue]="null">—</option>
                        @for (a of accounts(); track a.id) {
                          <option [ngValue]="a.id">{{ a.code }} — {{ a.name }}</option>
                        }
                      </select>
                      @if (action.field('lines.' + i + '.accountId'); as e) {
                        <p class="mt-1 text-xs text-danger-text">{{ e }}</p>
                      }
                    </td>
                    <td class="p-2">
                      <input
                        class="input font-mono"
                        [name]="'key' + i"
                        [attr.aria-label]="'Chave do montante da linha ' + (i + 1)"
                        [disabled]="locked()"
                        [(ngModel)]="l.amountKey"
                      />
                    </td>
                    <td class="p-2">
                      <select
                        class="input"
                        [name]="'cc' + i"
                        [attr.aria-label]="'Centro de custo da linha ' + (i + 1)"
                        [disabled]="locked()"
                        [(ngModel)]="l.costCenterId"
                      >
                        <option [ngValue]="null">
                          {{ l.useEventCostCenter ? 'O do evento' : '—' }}
                        </option>
                        @for (c of costCenters(); track c.id) {
                          <option [ngValue]="c.id">{{ c.label }}</option>
                        }
                      </select>
                      <label class="mt-1 flex items-center gap-1 text-xs">
                        <input
                          type="checkbox"
                          [name]="'ecc' + i"
                          [disabled]="locked()"
                          [(ngModel)]="l.useEventCostCenter"
                        />
                        do evento
                      </label>
                    </td>
                    <td class="p-2">
                      <label class="flex items-center gap-1 text-xs">
                        <input
                          type="checkbox"
                          [name]="'etp' + i"
                          [disabled]="locked()"
                          [(ngModel)]="l.useEventThirdParty"
                        />
                        usar
                      </label>
                    </td>
                    <td class="p-2">
                      @if (!locked() && lines.length > 2) {
                        <button
                          type="button"
                          class="btn-secondary"
                          [attr.aria-label]="'Remover linha ' + (i + 1)"
                          (click)="removeLine(i)"
                        >
                          ×
                        </button>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
            @if (!locked()) {
              <div class="p-3">
                <button type="button" class="btn-secondary" (click)="addLine()">
                  Acrescentar linha
                </button>
              </div>
            }
          </section>
          @if (canManage()) {
            <div class="flex items-center gap-3">
              <button type="submit" class="btn-primary" [disabled]="action.busy()">
                {{ rule() ? 'Guardar regra' : 'Criar regra' }}
              </button>
              @if (hasUnsavedChanges()) {
                <span class="text-sm text-muted" role="status">Alterações por guardar</span>
              }
            </div>
          }
        </form>

        @if (rule(); as r) {
          <section class="card space-y-3" aria-labelledby="sim-title">
            <h2 id="sim-title" class="font-semibold">Testar com um evento</h2>
            <p class="text-xs text-muted">
              Simular não grava nada. Enviar regista o evento e gera o lançamento (uma vez por
              referência).
            </p>
            <form
              class="grid gap-3 md:grid-cols-3"
              (ngSubmit)="simulate()"
              aria-label="Evento de teste"
            >
              <div>
                <label class="label" for="ev-ref">Referência</label>
                <input id="ev-ref" name="evRef" class="input" [(ngModel)]="eventForm.sourceRef" />
              </div>
              <div>
                <label class="label" for="ev-date">Data</label>
                <input
                  id="ev-date"
                  name="evDate"
                  type="date"
                  class="input"
                  [(ngModel)]="eventForm.occurredOn"
                />
              </div>
              <div>
                <label class="label" for="ev-tp">Terceiro</label>
                <input id="ev-tp" name="evTp" class="input" [(ngModel)]="eventForm.thirdPartyRef" />
              </div>
              @for (k of keys(); track k) {
                <div>
                  <label class="label" [for]="'amt-' + k">Montante «{{ k }}»</label>
                  <input
                    class="input text-right"
                    inputmode="decimal"
                    [id]="'amt-' + k"
                    [name]="'amt' + k"
                    [(ngModel)]="eventForm.amounts[k]"
                  />
                </div>
              }
              <div class="flex items-end gap-2 md:col-span-3">
                <button type="submit" class="btn-secondary" [disabled]="simAction.busy()">
                  Simular
                </button>
                @if (canPost()) {
                  <button
                    type="button"
                    class="btn-primary"
                    [disabled]="simAction.busy()"
                    (click)="send()"
                  >
                    Enviar evento
                  </button>
                }
              </div>
            </form>
            <app-error-alert [error]="simAction.error()" [showDetails]="true" />
            @if (simulation(); as sim) {
              <div role="status" data-testid="simulation">
                @if (sim.issues.length === 0) {
                  <p class="text-sm text-success-text">A regra gera um lançamento equilibrado:</p>
                } @else {
                  <ul class="list-disc pl-5 text-sm text-danger-text">
                    @for (i of sim.issues; track $index) {
                      <li>{{ i.message }}</li>
                    }
                  </ul>
                }
                @if (sim.lines.length > 0) {
                  <table class="mt-2 w-full text-sm">
                    <caption class="sr-only">
                      Linhas simuladas
                    </caption>
                    <thead>
                      <tr class="border-b border-border text-left">
                        <th scope="col" class="p-1">Conta</th>
                        <th scope="col" class="p-1 text-right">Débito</th>
                        <th scope="col" class="p-1 text-right">Crédito</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (l of sim.lines; track $index) {
                        <tr class="border-b border-border">
                          <td class="p-1">{{ l.accountCode }} — {{ l.accountName }}</td>
                          <td class="p-1 text-right">{{ l.debit ?? '' }}</td>
                          <td class="p-1 text-right">{{ l.credit ?? '' }}</td>
                        </tr>
                      }
                    </tbody>
                  </table>
                }
              </div>
            }
            @if (sent(); as e) {
              <p class="text-sm" role="status" data-testid="sent">
                Evento {{ e.sourceRef }}:
                {{ e.status === 'POSTED' ? 'contabilizado' : 'rascunho criado' }}
                @if (e.entryId) {
                  —
                  <a class="btn-link" [routerLink]="['/contabilidade/lancamentos', e.entryId]">{{
                    e.entryNumber ?? 'abrir lançamento'
                  }}</a>
                }
              </p>
            }
          </section>
        }

        <div aside>
          @if (rule(); as r) {
            <app-audit-history
              entityType="posting_rule"
              [entityId]="r.id"
              [refreshKey]="r.version"
            />
          }
        </div>
      </app-page-detail>
    }
  `,
})
export class PostingRuleForm implements HasUnsavedChanges {
  readonly id = input.required<string>();
  private readonly deps = accountingDeps();
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  protected readonly canManage = computed(() => this.deps.workspace.can('accounting.settings'));
  protected readonly canPost = computed(() => this.deps.workspace.can('accounting.post'));
  protected readonly rule = signal<PostingRule | null>(null);
  protected readonly loaded = signal(false);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly entities = signal<{ id: string; label: string }[]>([]);
  protected readonly journals = signal<Journal[]>([]);
  protected readonly accounts = signal<Account[]>([]);
  protected readonly costCenters = signal<{ id: string; label: string }[]>([]);
  protected readonly simulation = signal<Simulation | null>(null);
  protected readonly sent = signal<PostingEventView | null>(null);
  protected readonly action = new Action();
  protected readonly simAction = new Action();
  protected readonly locked = computed(() => !this.canManage() || !!this.rule()?.inUse);
  protected readonly keys = computed(() => amountKeys(this.rule()?.lines ?? []));
  protected form = {
    legalEntityId: null as string | null,
    code: '',
    name: '',
    journalId: null as string | null,
    source: '',
    event: '',
    validFrom: today(),
    validTo: '',
    descriptionTemplate: '{source} {sourceRef}',
    autoPost: false,
    status: 'ACTIVE',
  };
  protected lines: PostingRuleLine[] = [blank('DEBIT'), blank('CREDIT')];
  protected eventForm = {
    sourceRef: '',
    occurredOn: today(),
    thirdPartyRef: '',
    amounts: {} as Record<string, string>,
  };
  private initial = '';
  private refRequest = 0;

  constructor() {
    warnOnUnload(this);
    effect(() => {
      const id = this.id();
      untracked(() => void this.load(id));
    });
  }

  hasUnsavedChanges() {
    return this.loaded() && this.canManage() && this.snap() !== this.initial;
  }

  private snap() {
    return snapshot({ ...this.form, lines: this.lines });
  }

  protected reload() {
    void this.load(this.id());
  }

  private async load(id: string) {
    this.loaded.set(false);
    this.loadError.set(null);
    this.simulation.set(null);
    this.sent.set(null);
    try {
      this.entities.set(
        await legalEntityOptions(this.deps.api, this.deps.workspace).catch(() => []),
      );
      if (id === 'novo') {
        this.rule.set(null);
        this.form.legalEntityId =
          this.deps.workspace.legalEntityId() ?? this.entities()[0]?.id ?? null;
      } else {
        this.apply(await this.deps.api.get<PostingRule>(`accounting/posting-rules/${id}`));
      }
      await this.loadReferences(false);
      this.initial = this.snap();
      this.loaded.set(true);
    } catch (error) {
      this.loadError.set(ApiError.from(error));
    }
  }

  private apply(r: PostingRule) {
    this.rule.set(r);
    this.breadcrumbs.setCurrent(r.code);
    this.form = {
      legalEntityId: r.legalEntityId,
      code: r.code,
      name: r.name,
      journalId: r.journalId,
      source: r.source,
      event: r.event,
      validFrom: r.validFrom,
      validTo: r.validTo ?? '',
      descriptionTemplate: r.descriptionTemplate ?? '',
      autoPost: r.autoPost,
      status: r.status,
    };
    this.lines = (r.lines ?? []).map((l) => ({ ...l }));
    if (!this.entities().some((e) => e.id === r.legalEntityId))
      this.entities.update((list) => [
        ...list,
        { id: r.legalEntityId, label: 'Entidade da regra' },
      ]);
    this.eventForm.amounts = Object.fromEntries(amountKeys(this.lines).map((k) => [k, '']));
  }

  /** Diários, contas movimentáveis e centros de custo da entidade; ignora respostas de escolhas anteriores. */
  protected async loadReferences(reset = true) {
    const le = this.form.legalEntityId;
    const request = ++this.refRequest;
    if (reset) {
      this.journals.set([]);
      this.accounts.set([]);
      this.form.journalId = null;
      this.lines.forEach((l) => (l.accountId = null));
    }
    if (!le) return;
    const [journals, charts] = await Promise.all([
      this.deps.api.page<Journal>('accounting/journals', {
        legalEntityId: le,
        status: 'ACTIVE',
        limit: 200,
      }),
      this.deps.api.page<Chart>('accounting/charts', {
        legalEntityId: le,
        status: 'ACTIVE',
        limit: 1,
      }),
    ]);
    const chart = charts.items[0];
    const accounts = chart
      ? (
          await this.deps.api.page<Account>('accounting/accounts', {
            chartId: chart.id,
            postable: 'true',
            status: 'ACTIVE',
            limit: 500,
          })
        ).items
      : [];
    const centers = this.deps.workspace.can('organization.read')
      ? (
          await this.deps.api.page<OrgRecord>('organization/cost-centers', {
            legalEntityId: le,
            status: 'ACTIVE',
            limit: 200,
          })
        ).items
      : [];
    if (request !== this.refRequest) return;
    this.journals.set(journals.items);
    this.accounts.set(accounts);
    this.costCenters.set(centers.map((r) => ({ id: r.id, label: recordLabel(r) })));
  }

  protected addLine() {
    this.lines = [...this.lines, blank('CREDIT')];
  }

  protected removeLine(i: number) {
    this.lines = this.lines.filter((_, k) => k !== i);
  }

  protected async save() {
    const r = this.rule();
    const header = {
      name: this.form.name,
      journalId: this.form.journalId,
      source: this.form.source,
      event: this.form.event,
      validFrom: this.form.validFrom,
      validTo: this.form.validTo || null,
      descriptionTemplate: this.form.descriptionTemplate || null,
      autoPost: this.form.autoPost,
      status: this.form.status,
    };
    const lines = this.lines.map((l) => ({
      side: l.side,
      accountId: l.accountId,
      amountKey: l.amountKey,
      description: l.description,
      costCenterId: l.costCenterId,
      useEventCostCenter: l.useEventCostCenter,
      useEventThirdParty: l.useEventThirdParty,
    }));
    const body = r?.inUse
      ? {
          name: header.name,
          validTo: header.validTo,
          descriptionTemplate: header.descriptionTemplate,
          autoPost: header.autoPost,
          status: header.status,
        }
      : { ...header, lines };
    const result = await this.action.run(() =>
      r
        ? this.deps.api.patch<PostingRule>(`accounting/posting-rules/${r.id}`, {
            ...body,
            expectedVersion: r.version,
          })
        : this.deps.api.post<PostingRule>('accounting/posting-rules', {
            ...body,
            legalEntityId: this.form.legalEntityId,
            code: this.form.code,
          }),
    );
    if (!result) return;
    this.apply(result);
    this.initial = this.snap();
    this.toasts.show(r ? 'Regra guardada.' : 'Regra criada.');
    if (!r) await this.router.navigate(['/contabilidade/regras', result.id]);
  }

  private eventBody() {
    const r = this.rule()!;
    return {
      legalEntityId: r.legalEntityId,
      source: r.source,
      event: r.event,
      sourceRef: this.eventForm.sourceRef,
      occurredOn: this.eventForm.occurredOn,
      thirdPartyRef: this.eventForm.thirdPartyRef || null,
      amounts: Object.fromEntries(
        Object.entries(this.eventForm.amounts).map(([k, v]) => [k, normalizeAmount(v)]),
      ),
    };
  }

  protected async simulate() {
    this.sent.set(null);
    const result = await this.simAction.run(() =>
      this.deps.api.post<Simulation>('accounting/posting-events/simulate', this.eventBody()),
    );
    this.simulation.set(result ?? null);
  }

  protected async send() {
    this.simulation.set(null);
    const result = await this.simAction.run(() =>
      this.deps.api.post<PostingEventView>('accounting/posting-events', this.eventBody()),
    );
    if (!result) return;
    this.sent.set(result);
    this.toasts.show(
      result.status === 'POSTED'
        ? `Evento contabilizado (${result.entryNumber}).`
        : 'Evento registado; lançamento em rascunho.',
    );
    this.apply(await this.deps.api.get<PostingRule>(`accounting/posting-rules/${result.ruleId}`));
    this.initial = this.snap();
  }
}
