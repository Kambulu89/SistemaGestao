import { computed, inject, Injectable } from '@angular/core';
import { TenantModulesService } from '../modules/tenant-modules.service';
import { PermissionService } from '../permissions/permission.service';
import { DynamicEntityRegistryService } from './entity-registry.service';
import {
  evaluateOperation,
  type OperationCheck,
  type RecordForPolicy,
} from './engine/entity-permissions';
import { type FieldAccess, fieldAccessFromPermissions } from './engine/field-state';
import type { EntityDefinition, EntityOperation } from './models/entity-definition.model';

export type EntityDenial = 'module' | 'permission' | 'policy';

export interface EntityOperationCheck extends Omit<OperationCheck, 'denied'> {
  readonly denied?: EntityDenial;
}

/**
 * Decide o que o utilizador vê e pode fazer numa entidade. Usa o IAM existente
 * (`PermissionService`) e o estado dos módulos: não há um segundo sistema de permissões.
 * Serve a experiência de utilização; a autorização efectiva é do backend.
 */
@Injectable({ providedIn: 'root' })
export class EntityAccessService {
  private readonly permissions = inject(PermissionService);
  private readonly modules = inject(TenantModulesService);
  private readonly registry = inject(DynamicEntityRegistryService);

  /** Acesso a campos com as permissões do utilizador no tenant activo. */
  readonly fieldAccess: FieldAccess = fieldAccessFromPermissions((p) => this.permissions.can(p));

  /** O módulo de origem está contratado e activo neste tenant? */
  isAvailable(entity: EntityDefinition): boolean {
    return entity.moduleId === null || this.modules.isAvailable(entity.moduleId);
  }

  check(
    entity: EntityDefinition,
    operation: EntityOperation,
    record?: RecordForPolicy,
  ): EntityOperationCheck {
    if (!this.isAvailable(entity)) return { allowed: false, denied: 'module' };
    return evaluateOperation(entity, operation, (p) => this.permissions.can(p), record);
  }

  can(entity: EntityDefinition, operation: EntityOperation, record?: RecordForPolicy): boolean {
    return this.check(entity, operation, record).allowed;
  }

  /** Entidades publicadas que o utilizador pode ver. */
  readonly readable = computed(() => this.registry.published().filter((e) => this.can(e, 'read')));
}
