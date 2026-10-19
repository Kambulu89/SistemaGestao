import { inject, Injectable } from '@angular/core';
import { type Observable } from 'rxjs';
import type { ApiError } from '../api/api-error.model';
import { AuthService } from '../auth/auth.service';
import {
  CustomFieldGateway,
  type DefinitionFailure,
  type SaveCustomFieldInput,
} from '../dynamic/data-access/custom-field.gateway';
import {
  checkCustomFieldChange,
  validateCustomFieldDefinition,
} from '../dynamic/engine/custom-fields';
import { type DefinitionIssue, integrityContext } from '../dynamic/engine/definition-integrity';
import { fieldTypeDefinition } from '../dynamic/engine/field-types';
import { type CustomFieldDefinition, entityRefId } from '../dynamic/models/custom-definition.model';
import { PermissionService } from '../permissions/permission.service';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import { mockError, respond } from './mock-helpers';
import { MockMetadataStore } from './mock-metadata-store';

const MANAGE = 'configuration.forms.manage';
const PUBLISH = 'configuration.forms.publish';

const unprocessable = (issues: readonly DefinitionIssue[]): ApiError => ({
  status: 422,
  message: 'A definição do campo não é válida.',
  details: { issues } satisfies DefinitionFailure,
});

/**
 * Simula o **backend** dos campos personalizados: o tenant vem do contexto do pedido, guardar
 * exige a permissão de gestão e a definição é sempre revalidada aqui, seja qual for o cliente.
 */
@Injectable()
export class MockCustomFieldGateway extends CustomFieldGateway {
  private readonly tenantContext = inject(TenantContextService);
  private readonly permissions = inject(PermissionService);
  private readonly auth = inject(AuthService);
  private readonly store = inject(MockMetadataStore);

  list(): Observable<readonly CustomFieldDefinition[]> {
    return respond(() => this.store.customFieldsFor(this.tenantId()));
  }

  save(input: SaveCustomFieldInput): Observable<CustomFieldDefinition> {
    return respond(() => {
      const tenantId = this.tenantId();
      this.requireManage();
      if (input.state === 'active') this.require(PUBLISH, 'publicar campos personalizados');

      const previous = input.id
        ? this.store.customFieldsFor(tenantId).find((c) => c.id === input.id)
        : undefined;
      if (input.id && !previous) throw mockError(404, 'Campo não encontrado.');
      if (previous && previous.version !== input.expectedVersion) {
        throw mockError(409, 'O campo foi alterado entretanto. Recarregue e volte a tentar.');
      }

      const now = new Date().toISOString();
      const actor = this.auth.user()?.id ?? 'anonymous';
      const candidate: CustomFieldDefinition = {
        id: previous?.id ?? `cf-${tenantId}-${input.entity.key}-${input.field.key}`,
        tenantId,
        entity: input.entity,
        field: { ...input.field, origin: 'custom', archived: undefined },
        displayOrder:
          input.displayOrder ??
          previous?.displayOrder ??
          this.nextOrder(tenantId, entityRefId(input.entity)),
        showInList: input.showInList,
        state: input.state,
        version: previous ? previous.version + 1 : 1,
        audit: {
          createdAt: previous?.audit.createdAt ?? now,
          createdBy: previous?.audit.createdBy ?? actor,
          updatedAt: now,
          updatedBy: actor,
        },
      };

      const issues = this.validate(tenantId, candidate, previous);
      if (issues.length > 0) throw unprocessable(issues);
      return this.store.saveCustomField(candidate);
    });
  }

  setState(id: string, state: 'active' | 'archived'): Observable<CustomFieldDefinition> {
    return respond(() => {
      const tenantId = this.tenantId();
      this.requireManage();
      this.require(PUBLISH, 'arquivar ou reactivar campos personalizados');
      const previous = this.store.customFieldsFor(tenantId).find((c) => c.id === id);
      if (!previous) throw mockError(404, 'Campo não encontrado.');
      if (previous.state === 'draft')
        throw mockError(422, 'Publique o rascunho antes de o arquivar ou reactivar.');

      const next: CustomFieldDefinition = {
        ...previous,
        state,
        version: previous.version + 1,
        audit: {
          ...previous.audit,
          updatedAt: new Date().toISOString(),
          updatedBy: this.auth.user()?.id ?? 'anonymous',
        },
      };
      return this.store.saveCustomField(next);
    });
  }

  // ------------------------------------------------------------------ interno

  private tenantId(): string {
    const id = this.tenantContext.tenant()?.id;
    if (!id) throw mockError(403, 'Sem tenant activo.');
    return id;
  }

  private require(permission: string, action: string): void {
    if (!this.permissions.can(permission))
      throw mockError(403, `Não tem permissão para ${action}.`);
  }

  private requireManage(): void {
    if (!this.permissions.can(MANAGE))
      throw mockError(403, 'Não tem permissão para gerir campos personalizados.');
  }

  private nextOrder(tenantId: string, entityId: string): number {
    const orders = this.store
      .customFieldsFor(tenantId)
      .filter((c) => entityRefId(c.entity) === entityId)
      .map((c) => c.displayOrder);
    return orders.length > 0 ? Math.max(...orders) + 1 : 1;
  }

  private validate(
    tenantId: string,
    candidate: CustomFieldDefinition,
    previous: CustomFieldDefinition | undefined,
  ): DefinitionIssue[] {
    const path = `customFields.${candidate.field.key}`;
    const issues: DefinitionIssue[] = [];

    const entity = this.store
      .baseDefinitions(tenantId)
      .find(
        (d) =>
          entityRefId({ kind: d.scope === 'global' ? 'core' : 'custom', key: d.key }) ===
          entityRefId(candidate.entity),
      );
    issues.push(
      ...validateCustomFieldDefinition(entity, candidate, this.store.customFieldsFor(tenantId), {
        ...integrityContext(this.store.effective(tenantId)),
      }),
    );

    if (!/^[a-z][A-Za-z0-9]{1,39}$/.test(candidate.field.key))
      issues.push({
        severity: 'error',
        path,
        message: 'O código começa por minúscula e tem 2 a 40 letras ou dígitos (camelCase).',
      });
    if (!candidate.field.label.trim())
      issues.push({ severity: 'error', path, message: 'O nome do campo é obrigatório.' });
    if (fieldTypeDefinition(candidate.field.type).status === 'preview')
      issues.push({
        severity: 'error',
        path,
        message: `O tipo "${fieldTypeDefinition(candidate.field.type).label}" ainda não está disponível.`,
      });

    if (previous) {
      for (const change of checkCustomFieldChange(previous, candidate)) {
        if (change.severity === 'breaking')
          issues.push({ severity: 'error', path: change.path, message: change.message });
      }
    }
    return issues;
  }
}
