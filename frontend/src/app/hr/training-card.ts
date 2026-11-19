import { Component, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { Attachments } from '../ui/attachments';
import { formatDate } from '../ui/dates';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField } from '../ui/form-field';
import { Action } from '../ui/load';
import { Modal } from '../ui/modal';
import { ToastService } from '../ui/toasts';
import {
  type Competency,
  ENROLLMENT_STATUS,
  type EmployeeTraining,
  enrollmentTone,
  levelDots,
} from './training-model';

/** Formação na ficha do colaborador: competências (nível actual), certificados (com validade) e inscrições. */
@Component({
  selector: 'app-training-card',
  imports: [FormsModule, RouterLink, Modal, FormField, FieldControl, ErrorAlert, Attachments],
  template: `
    @if (data(); as d) {
      <section class="card" aria-labelledby="trc-title" data-testid="training">
        <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 id="trc-title" class="font-semibold">Formação e competências</h2>
          @if (d.access.manage) {
            <span class="flex gap-2">
              <button
                type="button"
                class="btn-secondary"
                data-testid="trc-assess"
                (click)="openAssess()"
              >
                Avaliar competência
              </button>
              <button
                type="button"
                class="btn-secondary"
                data-testid="trc-cert"
                (click)="openCert()"
              >
                Registar certificado
              </button>
            </span>
          }
        </div>
        <h3 class="mb-1 text-sm font-semibold">Competências</h3>
        @if (!d.competencies.length) {
          <p class="text-sm text-muted">Sem competências registadas.</p>
        }
        <ul class="mb-3 text-sm">
          @for (c of d.competencies; track c.competencyId) {
            <li class="flex justify-between gap-2 py-1" [attr.data-testid]="'trc-comp-' + c.code">
              <span>{{ c.name }}</span>
              <span class="text-muted"
                ><span aria-hidden="true">{{ dots(c.level) }}</span> nível {{ c.level }} ·
                {{ date(c.acquiredOn) }}</span
              >
            </li>
          }
        </ul>
        <h3 class="mb-1 text-sm font-semibold">Certificados</h3>
        @if (!d.certificates.length) {
          <p class="text-sm text-muted">Sem certificados.</p>
        }
        <ul class="mb-3 divide-y divide-border text-sm">
          @for (c of d.certificates; track c.id) {
            <li class="py-1" [attr.data-testid]="'trc-certificate-' + c.id">
              <div class="flex flex-wrap justify-between gap-2">
                <span>{{ c.name }} · {{ c.issuer }}{{ c.number ? ' · n.º ' + c.number : '' }}</span>
                <span class="flex items-center gap-2">
                  <span class="text-muted"
                    >{{ date(c.issuedOn) }}{{ c.expiresOn ? ' – ' + date(c.expiresOn) : '' }}</span
                  >
                  @if (c.expired) {
                    <span class="badge bg-danger-soft text-danger-text">Expirado</span>
                  }
                  <button
                    type="button"
                    class="link"
                    (click)="docs.set(docs() === c.id ? null : c.id)"
                  >
                    Documentos
                  </button>
                </span>
              </div>
              @if (docs() === c.id) {
                <app-attachments
                  subjectType="employee_certificate"
                  [subjectId]="c.id"
                  [canWrite]="d.access.manage"
                />
              }
            </li>
          }
        </ul>
        <h3 class="mb-1 text-sm font-semibold">Formações</h3>
        @if (!d.enrollments.length) {
          <p class="text-sm text-muted">Sem inscrições.</p>
        }
        <ul class="text-sm">
          @for (e of d.enrollments; track e.id) {
            <li class="flex flex-wrap justify-between gap-2 py-1">
              <a class="link" [routerLink]="['/rh/formacao', e.sessionId]"
                >{{ e.course }} · {{ date(e.startsOn) }}</a
              >
              <span class="badge" [class]="tone(e.status)">{{ label(e.status) }}</span>
            </li>
          }
        </ul>
      </section>
    }

    <app-modal title="Avaliar competência" [open]="assessing()" (closed)="assessing.set(false)">
      <app-error-alert [error]="action.error()" [showDetails]="false" />
      <div class="space-y-3">
        <app-field label="Competência" [required]="true" [error]="action.field('competencyId')">
          <select
            appControl
            class="input"
            data-testid="trc-competency"
            [(ngModel)]="assess.competencyId"
            [ngModelOptions]="{ standalone: true }"
          >
            <option [ngValue]="null">—</option>
            @for (k of competencies(); track k.id) {
              <option [ngValue]="k.id">{{ k.name }}</option>
            }
          </select>
        </app-field>
        <app-field label="Nível" [required]="true" [error]="action.field('level')">
          <select
            appControl
            class="input"
            data-testid="trc-level"
            [(ngModel)]="assess.level"
            [ngModelOptions]="{ standalone: true }"
          >
            @for (n of [1, 2, 3, 4, 5]; track n) {
              <option [ngValue]="n">{{ n }}</option>
            }
          </select>
        </app-field>
        <app-field label="Data" [required]="true" [error]="action.field('acquiredOn')">
          <input
            appControl
            class="input"
            type="date"
            [(ngModel)]="assess.acquiredOn"
            [ngModelOptions]="{ standalone: true }"
          />
        </app-field>
      </div>
      <ng-container actions>
        <button type="button" class="btn-secondary" (click)="assessing.set(false)">Cancelar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="trc-assess-confirm"
          [disabled]="action.busy()"
          (click)="saveAssess()"
        >
          Registar
        </button>
      </ng-container>
    </app-modal>

    <app-modal title="Registar certificado" [open]="certing()" (closed)="certing.set(false)">
      <app-error-alert [error]="action.error()" [showDetails]="false" />
      <div class="space-y-3">
        <app-field label="Nome" [required]="true" [error]="action.field('name')">
          <input
            appControl
            class="input"
            data-testid="trc-cert-name"
            [(ngModel)]="cert.name"
            [ngModelOptions]="{ standalone: true }"
          />
        </app-field>
        <app-field label="Entidade emissora" [required]="true" [error]="action.field('issuer')">
          <input
            appControl
            class="input"
            data-testid="trc-cert-issuer"
            [(ngModel)]="cert.issuer"
            [ngModelOptions]="{ standalone: true }"
          />
        </app-field>
        <div class="grid gap-3 sm:grid-cols-2">
          <app-field label="Emissão" [required]="true" [error]="action.field('issuedOn')">
            <input
              appControl
              class="input"
              type="date"
              data-testid="trc-cert-issued"
              [(ngModel)]="cert.issuedOn"
              [ngModelOptions]="{ standalone: true }"
            />
          </app-field>
          <app-field label="Validade" [error]="action.field('expiresOn')">
            <input
              appControl
              class="input"
              type="date"
              [(ngModel)]="cert.expiresOn"
              [ngModelOptions]="{ standalone: true }"
            />
          </app-field>
        </div>
      </div>
      <ng-container actions>
        <button type="button" class="btn-secondary" (click)="certing.set(false)">Cancelar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="trc-cert-confirm"
          [disabled]="action.busy()"
          (click)="saveCert()"
        >
          Registar
        </button>
      </ng-container>
    </app-modal>
  `,
})
export class TrainingCard {
  readonly employeeId = input.required<string>();
  private readonly api = inject(Api);
  private readonly toasts = inject(ToastService);
  protected readonly data = signal<EmployeeTraining | null>(null);
  protected readonly competencies = signal<Competency[]>([]);
  protected readonly assessing = signal(false);
  protected readonly certing = signal(false);
  protected readonly docs = signal<string | null>(null);
  protected readonly action = new Action();
  protected assess = { competencyId: null as string | null, level: 1, acquiredOn: '' };
  protected cert = { name: '', issuer: '', issuedOn: '', expiresOn: '' };
  protected readonly date = formatDate;
  protected readonly dots = levelDots;
  protected readonly tone = enrollmentTone;
  protected readonly label = (s: keyof typeof ENROLLMENT_STATUS) => ENROLLMENT_STATUS[s];

  constructor() {
    effect(() => {
      const id = this.employeeId();
      untracked(() => void this.load(id));
    });
  }

  private async load(id: string) {
    try {
      this.data.set(await this.api.get<EmployeeTraining>(`hr/employees/${id}/training`));
    } catch {
      this.data.set(null);
    }
  }

  protected async openAssess() {
    this.action.error.set(null);
    try {
      this.competencies.set(
        (await this.api.get<Competency[]>('hr/training/competencies')).filter(
          (k) => k.status === 'ACTIVE',
        ),
      );
    } catch {
      this.competencies.set([]);
    }
    this.assess = {
      competencyId: null,
      level: 1,
      acquiredOn: new Date().toISOString().slice(0, 10),
    };
    this.assessing.set(true);
  }

  protected async saveAssess() {
    const done = await this.action.run(() =>
      this.api.post(`hr/employees/${this.employeeId()}/competencies`, {
        ...this.assess,
        level: Number(this.assess.level),
      }),
    );
    if (!done) return;
    this.assessing.set(false);
    await this.load(this.employeeId());
    this.toasts.show('Competência registada.');
  }

  protected openCert() {
    this.action.error.set(null);
    this.cert = { name: '', issuer: '', issuedOn: '', expiresOn: '' };
    this.certing.set(true);
  }

  protected async saveCert() {
    const done = await this.action.run(() =>
      this.api.post(`hr/employees/${this.employeeId()}/certificates`, {
        name: this.cert.name,
        issuer: this.cert.issuer,
        issuedOn: this.cert.issuedOn || null,
        expiresOn: this.cert.expiresOn || undefined,
      }),
    );
    if (!done) return;
    this.certing.set(false);
    await this.load(this.employeeId());
    this.toasts.show('Certificado registado.');
  }
}
