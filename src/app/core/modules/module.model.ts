import type { Permission } from '../permissions/permission.model';

/** Agrupamento na navegação. */
export type ModuleGroup = 'general' | 'dynamic' | 'vertical';

/** Secção interna de um módulo. */
export interface ModuleRoute {
  readonly path: string;
  readonly label: string;
  readonly permission?: Permission;
}

/**
 * Manifesto de um módulo no catálogo da plataforma. É independente do tenant:
 * o estado "contratado/activado" vive em `TenantModuleState`.
 */
export interface ModuleManifest {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly icon: string;
  readonly group: ModuleGroup;
  readonly routes: readonly ModuleRoute[];
  /** Permissões que o utilizador tem de possuir (todas) para ver o módulo. */
  readonly permissions: readonly Permission[];
  /** Módulos que têm de estar contratados e activados no tenant. */
  readonly dependencies: readonly string[];
  readonly featureFlag?: string;
}

/**
 * Resultado da resolução, pela ordem de verificação:
 * contratado → activado → dependências → feature flag → permissões.
 */
export type ModuleAccessStatus =
  | 'not-contracted'
  | 'inactive'
  | 'missing-dependency'
  | 'flag-disabled'
  | 'forbidden'
  | 'accessible';

export interface ResolvedModule {
  readonly manifest: ModuleManifest;
  readonly access: ModuleAccessStatus;
}
