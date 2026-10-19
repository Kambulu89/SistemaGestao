import type { EntityDefinition } from '../models/entity-definition.model';

/**
 * Definição em vigor de cada entidade para um tenant: a versão publicada mais alta.
 * Uma definição do próprio tenant sobrepõe-se à global com a mesma chave.
 * Definições de outro tenant são ignoradas, mesmo que o servidor as devolva (defesa em profundidade).
 */
export function resolvePublished(
  definitions: readonly EntityDefinition[],
  tenantId: string,
): EntityDefinition[] {
  const visible = definitions.filter(
    (d) => d.state === 'published' && (d.scope === 'global' || d.tenantId === tenantId),
  );

  const byKey = new Map<string, EntityDefinition>();
  for (const definition of visible) {
    const current = byKey.get(definition.key);
    if (!current || isPreferred(definition, current)) byKey.set(definition.key, definition);
  }
  return [...byKey.values()].sort((a, b) => a.names.plural.localeCompare(b.names.plural, 'pt'));
}

function isPreferred(candidate: EntityDefinition, current: EntityDefinition): boolean {
  if (candidate.scope !== current.scope) return candidate.scope === 'tenant';
  return candidate.version > current.version;
}

/** Todas as versões visíveis de uma entidade para o tenant, da mais recente para a mais antiga. */
export function versionsOf(
  definitions: readonly EntityDefinition[],
  key: string,
  tenantId: string,
): EntityDefinition[] {
  return definitions
    .filter((d) => d.key === key && (d.scope === 'global' || d.tenantId === tenantId))
    .sort((a, b) => b.version - a.version);
}
