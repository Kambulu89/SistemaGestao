import { NgTemplateOutlet } from '@angular/common';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { ReactiveFormsModule } from '@angular/forms';
import {
  FULL_ACCESS,
  type FieldAccess,
  type FieldState,
  resolveFieldState,
} from '../../core/dynamic/engine/field-state';
import { applyFormConfiguration } from '../../core/dynamic/engine/form-config';
import { resolveForm } from '../../core/dynamic/engine/form-resolver';
import { validateRecordData } from '../../core/dynamic/engine/validation';
import type { EntityDefinition } from '../../core/dynamic/models/entity-definition.model';
import type { RecordData } from '../../core/dynamic/models/entity-record.model';
import type { FieldDefinition, FieldValue } from '../../core/dynamic/models/field-definition.model';
import type {
  FormColumns,
  FormMode,
  FormSection,
} from '../../core/dynamic/models/form-definition.model';
import type { ValidationIssue } from '../../core/dynamic/models/validation-issue.model';
import { Alert } from '../ui/alert/alert';
import { Button } from '../ui/button/button';
import {
  activeFields,
  buildEntityForm,
  collectSubmitValues,
  dependentFieldKeys,
  type EntityFormContext,
  initialFormValues,
} from './build-entity-form';
import { DynamicField } from './dynamic-field';
import { DynamicValue } from './dynamic-value';

const GRID: Record<FormColumns, string> = {
  1: 'grid-cols-1',
  2: 'grid-cols-1 sm:grid-cols-2',
  3: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
  4: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4',
};

const SPAN: Record<FormColumns, string> = {
  1: '',
  2: 'sm:col-span-2',
  3: 'sm:col-span-2 lg:col-span-3',
  4: 'sm:col-span-2 lg:col-span-4',
};

let nextUid = 0;

/**
 * Gera o formulário de qualquer entidade a partir dos seus metadados, com Reactive Forms.
 * Não conhece nenhuma entidade concreta: recebe a definição, o modo e os valores.
 * Validação, visibilidade e obrigatoriedade condicionais vêm do motor declarativo.
 */
@Component({
  selector: 'app-dynamic-form',
  imports: [ReactiveFormsModule, NgTemplateOutlet, Alert, Button, DynamicField, DynamicValue],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <form [formGroup]="form()" (ngSubmit)="submit()" novalidate class="space-y-6">
      @if (formErrors().length > 0) {
        <app-alert tone="danger" title="Não foi possível guardar">
          <ul class="list-disc ps-4">
            @for (issue of formErrors(); track $index) {
              <li>{{ issue.message }}</li>
            }
          </ul>
        </app-alert>
      }

      @for (section of visibleSections(); track section.key) {
        <section
          class="rounded-xl border border-line bg-surface p-5"
          [attr.aria-labelledby]="uid + section.key"
        >
          <h2 [id]="uid + section.key" class="text-base font-semibold">{{ section.title }}</h2>
          @if (section.description) {
            <p class="mt-0.5 text-sm text-fg-muted">{{ section.description }}</p>
          }

          @if (mode() === 'read') {
            <dl class="mt-4 grid gap-4" [class]="grid(section.columns)">
              <ng-container
                *ngTemplateOutlet="
                  items;
                  context: { $implicit: section.items, columns: section.columns }
                "
              />
            </dl>
          } @else {
            <div class="mt-4 grid gap-4" [class]="grid(section.columns)">
              <ng-container
                *ngTemplateOutlet="
                  items;
                  context: { $implicit: section.items, columns: section.columns }
                "
              />
            </div>
          }
        </section>
      }

      @if (mode() !== 'read' && showActions()) {
        <div class="flex justify-end gap-2">
          <app-button variant="secondary" (click)="cancelled.emit()">Cancelar</app-button>
          <app-button type="submit" [loading]="submitting()">{{ submitText() }}</app-button>
        </div>
      }
    </form>

    <ng-template #items let-list let-columns="columns">
      @for (item of list; track $index) {
        @if (item.kind === 'field') {
          <ng-container
            *ngTemplateOutlet="cell; context: { $implicit: item.field, span: item.span }"
          />
        } @else {
          <fieldset class="col-span-full rounded-lg border border-dashed border-line p-4">
            @if (item.title) {
              <legend class="px-1 text-sm font-medium">{{ item.title }}</legend>
            }
            <div class="grid gap-4" [class]="grid(item.columns ?? columns)">
              <ng-container
                *ngTemplateOutlet="
                  items;
                  context: { $implicit: item.items, columns: item.columns ?? columns }
                "
              />
            </div>
          </fieldset>
        }
      }
    </ng-template>

    <ng-template #cell let-key let-span="span">
      @if (fieldOf(key); as field) {
        @if (states()[key]; as state) {
          @if (state.visible) {
            <div [class]="spanClass(span)">
              @if (mode() === 'read') {
                <dt class="text-sm font-medium text-fg-muted">{{ field.label }}</dt>
                <dd class="mt-0.5">
                  <app-dynamic-value [field]="field" [value]="value()?.[key]" />
                </dd>
              } @else {
                <app-dynamic-field [field]="field" [control]="controlOf(key)" [state]="state" />
              }
            </div>
          }
        }
      }
    </ng-template>
  `,
})
export class DynamicFormRenderer {
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly entity = input.required<EntityDefinition>();
  readonly mode = input<FormMode>('create');
  /** Valores do registo (edição e leitura). */
  readonly value = input<RecordData | null>(null);
  /** Estado do registo, para condições que dependem dele. */
  readonly status = input<string | null>(null);
  /** Problemas devolvidos pelo servidor (422). */
  readonly issues = input<readonly ValidationIssue[]>([]);
  readonly submitting = input(false);
  readonly access = input<FieldAccess>(FULL_ACCESS);
  readonly submitLabel = input<string>();
  /** `false` para pré-visualizações sem botões. */
  readonly showActions = input(true);

  readonly submitted = output<RecordData>();
  readonly cancelled = output();

  protected readonly uid = `dyn-${nextUid++}-`;

  private readonly context: EntityFormContext = {
    mode: () => this.mode(),
    status: () => this.status(),
    access: () => this.access(),
  };

  /** O formulário em vigor para o modo (o publicado do tenant, ou o gerado a partir dos campos). */
  private readonly layout = computed(() => resolveForm(this.entity(), this.mode()));

  /**
   * A entidade **como este formulário a apresenta**: rótulos, ajudas e condições do formulário, e os campos que ele
   * não inclui escondidos (não se validam nem se enviam). O servidor continua a decidir o que se aceita.
   */
  private readonly effective = computed(() => applyFormConfiguration(this.entity(), this.layout()));

  /** Só se reconstrói quando muda a entidade (ou o modo): não a cada tecla. */
  protected readonly form = computed(() => {
    this.mode();
    return buildEntityForm(this.effective(), this.context);
  });

  private readonly values = signal<Readonly<Record<string, FieldValue>>>({});

  protected readonly states = computed<Readonly<Record<string, FieldState>>>(() => {
    const context = { values: this.values(), status: this.status() };
    return Object.fromEntries(
      activeFields(this.effective()).map((f) => [
        f.key,
        resolveFieldState(f, context, this.mode(), this.access()),
      ]),
    );
  });

  private readonly sections = computed(() => this.layout().sections);

  protected readonly visibleSections = computed(() =>
    this.sections().filter((s) => this.sectionKeys(s).some((k) => this.states()[k]?.visible)),
  );

  /** Problemas que não se podem mostrar junto a um campo visível. */
  protected readonly formErrors = computed(() =>
    this.issues().filter((i) => !i.fieldKey || !this.states()[i.fieldKey]?.visible),
  );

  protected readonly submitText = computed(
    () => this.submitLabel() ?? (this.mode() === 'create' ? 'Criar' : 'Guardar'),
  );

  private readonly fields = computed(
    () => new Map(activeFields(this.effective()).map((f) => [f.key, f])),
  );

  constructor() {
    // Repõe os valores quando muda o formulário ou o registo. `untracked`: o reset corre
    // validadores que lêem sinais, e isso não pode tornar este efeito dependente deles.
    effect(() => {
      const form = this.form();
      const initial = initialFormValues(this.effective(), this.value(), this.mode());
      untracked(() => {
        form.reset(initial);
        this.values.set(form.getRawValue());
      });
    });

    effect((onCleanup) => {
      const form = this.form();
      const dependents = dependentFieldKeys(this.effective());
      const sub = form.valueChanges.subscribe(() => {
        this.values.set(form.getRawValue());
        // Campos que dependem de outros: a sua validade pode ter mudado sem terem sido editados.
        for (const key of dependents)
          form.controls[key]?.updateValueAndValidity({ emitEvent: false });
      });
      onCleanup(() => sub.unsubscribe());
    });

    // Campos só de leitura (ou escondidos por condição) ficam desactivados no formulário.
    effect(() => {
      const states = this.states();
      const form = this.form();
      untracked(() => {
        for (const [key, state] of Object.entries(states)) {
          const control = form.controls[key];
          if (!control) continue;
          if (state.editable && control.disabled) control.enable({ emitEvent: false });
          else if (!state.editable && control.enabled) control.disable({ emitEvent: false });
        }
      });
    });

    // Problemas do servidor aparecem junto ao campo e desaparecem quando o utilizador o edita.
    effect(() => {
      const issues = this.issues();
      const form = this.form();
      untracked(() => {
        for (const issue of issues) {
          const control = issue.fieldKey ? form.controls[issue.fieldKey] : undefined;
          control?.setErrors({ server: { message: issue.message } });
          control?.markAsTouched();
        }
      });
    });
  }

  protected grid(columns: FormColumns): string {
    return GRID[columns];
  }

  protected spanClass(span: FormColumns | undefined): string {
    return SPAN[span ?? 1];
  }

  protected fieldOf(key: string): FieldDefinition | undefined {
    return this.fields().get(key);
  }

  protected controlOf(key: string) {
    return this.form().controls[key]!;
  }

  private sectionKeys(section: FormSection): string[] {
    const collect = (items: FormSection['items']): string[] =>
      items.flatMap((i) => (i.kind === 'field' ? [i.field] : collect(i.items)));
    return collect(section.items);
  }

  protected submit(): void {
    const form = this.form();
    form.markAllAsTouched();

    const raw = form.getRawValue();
    const issues = validateRecordData(this.effective(), raw, {
      mode: this.mode(),
      status: this.status(),
      access: this.access(),
    });
    if (form.invalid || issues.length > 0) {
      afterNextRender(
        () => this.host.nativeElement.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
        { injector: this.injector },
      );
      return;
    }
    this.submitted.emit(collectSubmitValues(this.effective(), raw, this.context));
  }
}
