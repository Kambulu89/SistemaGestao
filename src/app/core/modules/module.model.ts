import type { Type } from '@angular/core';
import type { Permission, PermissionDefinition } from '../permissions/permission.model';
import type { ModuleSettingValue } from '../tenant-context/tenant.model';

/** Categoria que organiza módulos relacionados (ex.: CRM, Financeiro). */
export interface ModuleGroup {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly icon: string;
  readonly order: number;
}

/**
 * - `foundation`: capacidade estrutural da plataforma (ex.: autenticação). Sempre activa,
 *   não se contrata nem se desactiva; só depende de permissões.
 * - `module`: unidade funcional contratável e activável por tenant.
 */
export type ModuleKind = 'foundation' | 'module';

/** Onde a capacidade vive: administração global ou área do tenant. */
export type ModuleScope = 'platform' | 'tenant';

/**
 * - `planned`: registado no catálogo; ecrãs ainda provisórios.
 * - `beta` / `stable`: em evolução / estável.
 * - `deprecated`: ainda funciona, a abandonar.
 * - `retired`: já não pode ser usado.
 */
export type ModuleLifecycle = 'planned' | 'beta' | 'stable' | 'deprecated' | 'retired';

/** Capacidade específica de um módulo, que pode ser ligada/desligada por tenant e por flag. */
export interface ModuleFeature {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** Feature flag que também tem de estar ligada. */
  readonly flag?: string;
  /** Permissão adicional necessária para usar a funcionalidade. */
  readonly permission?: Permission;
}

/** Parâmetro configurável por tenant. */
export interface ModuleSetting {
  readonly key: string;
  readonly label: string;
  readonly type: 'boolean' | 'number' | 'text';
  readonly defaultValue: ModuleSettingValue;
}

/** Rota Angular de um módulo, relativa ao seu `basePath`. Sempre lazy. */
export interface ModuleRouteDef {
  readonly path: string;
  readonly title: string;
  readonly permission?: Permission;
  readonly loadComponent: () => Promise<Type<unknown>>;
}

/** Manifesto tipado: tudo o que a plataforma precisa de saber sobre um módulo. */
export interface ModuleManifest {
  /** Identificador único e estável; é o que o backend referencia (ver `moduleId`). */
  readonly id: string;
  /** Código técnico legível, ex.: `crm.customers`. Prefixo das permissões e base do URL. */
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly groupId: string;
  readonly kind: ModuleKind;
  readonly scope: ModuleScope;
  readonly version: string;
  readonly lifecycle: ModuleLifecycle;
  /** Ids de módulos que têm de estar contratados e activos. */
  readonly dependencies: readonly string[];
  readonly permissions: readonly PermissionDefinition[];
  /** Permissão mínima para entrar no módulo. */
  readonly accessPermission: Permission;
  readonly features: readonly ModuleFeature[];
  readonly settings: readonly ModuleSetting[];
  /** Vazio = ecrã provisório (scaffold) até o módulo ser implementado. */
  readonly routes: readonly ModuleRouteDef[];
  readonly icon: string;
  /** Posição dentro do grupo (menor primeiro). */
  readonly order: number;
  readonly showInNavigation: boolean;
  /** Feature flag que liga o módulo inteiro. */
  readonly featureFlag?: string;
  /** Módulo do registo do servidor, quando difere do primeiro segmento do código. */
  readonly backendModule?: string;
  /** Segmento de URL dentro do tenant: `/t/:slug/<basePath>`. */
  readonly basePath: string;
}
