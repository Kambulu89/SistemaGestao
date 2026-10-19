import { inject } from '@angular/core';
import { type ActivatedRouteSnapshot, type CanActivateFn, Router } from '@angular/router';
import { EntityAccessService } from '../dynamic/entity-access.service';
import { DynamicEntityRegistryService } from '../dynamic/entity-registry.service';
import type { EntityOperation } from '../dynamic/models/entity-definition.model';

/** Procura o parâmetro `entityKey` na rota ou nas suas ascendentes. */
export function entityKeyOf(route: ActivatedRouteSnapshot): string | null {
  for (let r: ActivatedRouteSnapshot | null = route; r; r = r.parent) {
    const key = r.paramMap.get('entityKey');
    if (key) return key;
  }
  return null;
}

/**
 * Só deixa entrar se a entidade existir para o tenant, o módulo estiver disponível e o utilizador
 * tiver a permissão da operação. Uma entidade desconhecida e uma proibida respondem o mesmo.
 */
export function requireEntityOperation(operation: EntityOperation): CanActivateFn {
  return (route) => {
    const key = entityKeyOf(route);
    const entity = key ? inject(DynamicEntityRegistryService).find(key) : undefined;
    const allowed = entity !== undefined && inject(EntityAccessService).can(entity, operation);
    return allowed || inject(Router).createUrlTree(['/auth/no-access']);
  };
}
