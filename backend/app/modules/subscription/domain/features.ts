/**
 * Funcionalidades contratáveis, definidas no código (fonte de verdade) e sincronizadas com `node ace catalog:sync`.
 * Só entram aqui funcionalidades com efeito real numa rota ou regra. O núcleo (sessão, membros, perfis, contexto) está
 * sempre disponível e não depende de plano.
 */
export type FeatureKind = 'BOOLEAN' | 'LIMIT'

export interface FeatureDefinition {
  code: string
  module: string
  kind: FeatureKind
  description: string
}

export const FEATURES: readonly FeatureDefinition[] = [
  {
    code: 'organization',
    module: 'organization',
    kind: 'BOOLEAN',
    description:
      'Estrutura organizacional: entidades legais, filiais, departamentos, cargos e centros de custo.',
  },
  {
    code: 'members.max',
    module: 'members',
    kind: 'LIMIT',
    description: 'Número máximo de membros (activos, suspensos e convidados).',
  },
  {
    code: 'legal_entities.max',
    module: 'organization',
    kind: 'LIMIT',
    description: 'Número máximo de entidades legais.',
  },
  {
    code: 'approvals',
    module: 'approvals',
    kind: 'BOOLEAN',
    description: 'Workflows de aprovação com etapas, decisões e delegações.',
  },
  {
    code: 'attachments.storage_mb',
    module: 'attachments',
    kind: 'LIMIT',
    description: 'Espaço para anexos, em MB (sem limite = ilimitado; ausente = sem anexos).',
  },
]

export const FEATURE_KINDS: ReadonlyMap<string, FeatureKind> = new Map(
  FEATURES.map((f) => [f.code, f.kind])
)
