import type { Permission, PermissionDefinition } from '../permissions/permission.model';
import type {
  ModuleFeature,
  ModuleKind,
  ModuleLifecycle,
  ModuleManifest,
  ModuleRouteDef,
  ModuleScope,
  ModuleSetting,
} from './module.model';

/** Id estável derivado do código técnico. Usado em dependências, subscrições e tenant modules. */
export function moduleId(code: string): string {
  return `mod_${code.replace(/[.-]/g, '_')}`;
}

export interface ModuleDefinition {
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly group: string;
  readonly icon: string;
  readonly kind?: ModuleKind;
  readonly scope?: ModuleScope;
  readonly version?: string;
  readonly lifecycle?: ModuleLifecycle;
  readonly order?: number;
  /** Códigos (não ids) dos módulos de que este depende. */
  readonly dependencies?: readonly string[];
  /** Por omissão: `<code>.read` e `<code>.manage`. */
  readonly permissions?: readonly PermissionDefinition[];
  readonly accessPermission?: Permission;
  readonly features?: readonly ModuleFeature[];
  readonly settings?: readonly ModuleSetting[];
  readonly routes?: readonly ModuleRouteDef[];
  readonly featureFlag?: string;
  readonly showInNavigation?: boolean;
}

/** Cria um manifesto completo com valores por omissão coerentes. */
export function defineModule(def: ModuleDefinition): ModuleManifest {
  const kind = def.kind ?? 'module';
  const scope = def.scope ?? 'tenant';
  const permissions = def.permissions ?? [
    { key: `${def.code}.read`, name: `Ver ${def.name}` },
    { key: `${def.code}.manage`, name: `Gerir ${def.name}` },
  ];

  return {
    id: moduleId(def.code),
    code: def.code,
    name: def.name,
    description: def.description,
    groupId: def.group,
    kind,
    scope,
    version: def.version ?? '0.1.0',
    lifecycle: def.lifecycle ?? (kind === 'foundation' ? 'stable' : 'planned'),
    dependencies: (def.dependencies ?? []).map(moduleId),
    permissions,
    accessPermission: def.accessPermission ?? permissions[0]?.key ?? `${def.code}.read`,
    features: def.features ?? [],
    settings: def.settings ?? [],
    routes: def.routes ?? [],
    icon: def.icon,
    order: def.order ?? 100,
    showInNavigation: def.showInNavigation ?? (kind === 'module' && scope === 'tenant'),
    featureFlag: def.featureFlag,
    basePath: def.code.replace(/\./g, '/'),
  };
}
