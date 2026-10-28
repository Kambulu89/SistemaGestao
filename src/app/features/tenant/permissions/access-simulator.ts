import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { finalize } from 'rxjs';
import { detailedErrorMessage } from '../../../core/api/error-message';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import { Alert } from '../../../shared/ui/alert/alert';
import { Badge } from '../../../shared/ui/badge/badge';
import { Button } from '../../../shared/ui/button/button';
import { Card } from '../../../shared/ui/card/card';
import { Select, type SelectOption } from '../../../shared/ui/select/select';
import { Textarea } from '../../../shared/ui/textarea/textarea';
import { IamApi, type DecisionDto } from '../data-access/iam.api';
import { parseResource, REASON_TEXT } from './simulator-model';

/**
 * Simulador: «o que este membro pode fazer?». Só diz o que o servidor decidiria agora (perfis, âmbito de unidades e
 * políticas activas); não concede nem altera nada. Útil antes de activar uma política.
 */
@Component({
  selector: 'app-access-simulator',
  imports: [FormsModule, Alert, Badge, Button, Card, Select, Textarea],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <app-card>
      <div class="grid gap-4 sm:grid-cols-2">
        <app-select
          label="Membro"
          [required]="true"
          [options]="memberOptions()"
          [ngModel]="memberId()"
          (ngModelChange)="memberId.set($event ?? '')"
        />
        <app-select
          label="Permissão"
          [required]="true"
          [options]="permissionOptions()"
          [ngModel]="permission()"
          (ngModelChange)="permission.set($event ?? '')"
        />
        <div class="sm:col-span-2">
          <app-textarea
            label="Recurso (opcional, JSON)"
            hint='Os campos que as condições leem em resource.*, p. ex. {"unitId": "…", "amount": 1500}.'
            [rows]="3"
            [ngModel]="resourceText()"
            (ngModelChange)="resourceText.set($event ?? '')"
          />
        </div>
      </div>
      @if (error(); as text) {
        <app-alert tone="danger" class="mt-4 block">{{ text }}</app-alert>
      }
      <app-button class="mt-4" [loading]="busy()" (click)="run()">Simular</app-button>
    </app-card>

    @if (result(); as r) {
      <app-card class="mt-4 block">
        <div data-testid="decision">
          <app-badge [tone]="r.allowed ? 'success' : 'danger'">{{
            r.allowed ? 'Permitido' : 'Negado'
          }}</app-badge>
          <span class="ms-2 text-sm">{{ reason(r) }}</span>
        </div>
        <dl class="mt-4 grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt class="text-xs text-fg-muted">Concedido pelos perfis</dt>
            <dd data-testid="roles">
              {{ r.grantedBy.length > 0 ? roleList(r) : '—' }}
            </dd>
          </div>
          <div>
            <dt class="text-xs text-fg-muted">Políticas que decidiram</dt>
            <dd data-testid="policies">{{ r.policies.length > 0 ? policyList(r) : '—' }}</dd>
          </div>
          <div>
            <dt class="text-xs text-fg-muted">Campos escondidos</dt>
            <dd>{{ r.hiddenFields.join(', ') || '—' }}</dd>
          </div>
          <div>
            <dt class="text-xs text-fg-muted">Campos só de leitura</dt>
            <dd>{{ r.readOnlyFields.join(', ') || '—' }}</dd>
          </div>
        </dl>
      </app-card>
    }
  `,
})
export class AccessSimulator {
  private readonly api = inject(IamApi);
  private readonly tenantContext = inject(TenantContextService);

  private readonly members = rxResource({
    params: () => this.tenantContext.tenant()?.id,
    stream: () => this.api.listMembers(),
  });
  private readonly catalog = rxResource({
    params: () => this.tenantContext.tenant()?.id,
    stream: () => this.api.permissions(),
  });
  protected readonly memberOptions = computed<readonly SelectOption[]>(() =>
    (this.members.hasValue() ? this.members.value() : []).map((m) => ({
      value: m.id,
      label: `${m.displayName ?? m.email ?? m.id}${m.status === 'ACTIVE' ? '' : ` (${m.status})`}`,
    })),
  );
  protected readonly permissionOptions = computed<readonly SelectOption[]>(() =>
    (this.catalog.hasValue() ? this.catalog.value() : [])
      .map((p) => ({ value: p.code, label: p.code }))
      .sort((a, b) => a.value.localeCompare(b.value)),
  );

  protected readonly memberId = signal('');
  protected readonly permission = signal('');
  protected readonly resourceText = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly result = signal<DecisionDto | null>(null);

  protected reason(decision: DecisionDto): string {
    return REASON_TEXT[decision.reason] ?? decision.reason;
  }

  protected roleList(decision: DecisionDto): string {
    return decision.grantedBy.map((r) => r.roleCode).join(', ');
  }

  protected policyList(decision: DecisionDto): string {
    return decision.policies
      .map((p) => `${p.name} (${p.effect === 'DENY' ? 'negar' : 'permitir'})`)
      .join(', ');
  }

  protected run(): void {
    this.error.set(null);
    this.result.set(null);
    if (!this.memberId() || !this.permission()) {
      return void this.error.set('Escolha o membro e a permissão.');
    }
    const resource = parseResource(this.resourceText());
    if (!resource.ok) return void this.error.set(resource.message);
    this.busy.set(true);
    this.api
      .simulate({
        membershipId: this.memberId(),
        permission: this.permission(),
        ...(resource.value ? { resource: resource.value } : {}),
      })
      .pipe(finalize(() => this.busy.set(false)))
      .subscribe({
        next: (decision) => this.result.set(decision),
        error: (error: unknown) => this.error.set(detailedErrorMessage(error)),
      });
  }
}
