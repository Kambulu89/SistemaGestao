import type { TenantContext, TenantScope } from '#core/tenancy/index'
import type {
  FormFieldInfo,
  FormIssue,
  FormMode,
  FormSection,
  FormStatus,
} from '#dynamic/forms/domain/form'

export interface Form {
  id: string
  entityDefinitionId: string
  entityCode: string
  code: string
  name: string
  description: string | null
  revision: number
  status: FormStatus
  modes: FormMode[]
  isDefault: boolean
  sections: FormSection[]
  /** Revisão da versão da entidade contra a qual a publicação foi verificada (só nas publicadas). */
  schemaRevision: number | null
  publishedAt: Date | null
  version: number
  createdAt: Date
  updatedAt: Date
}

/** Um formulário publicado com o que o servidor verificou agora contra a entidade (`issues` vazio = utilizável). */
export interface FormView extends Form {
  issues: FormIssue[]
}

export interface FormValues {
  entityDefinitionId: string
  code: string
  name: string
  description: string | null
  modes: FormMode[]
  isDefault: boolean
  sections: FormSection[]
}

export interface FormStore {
  list(
    scope: TenantScope,
    filter: { entityDefinitionId?: string; status?: FormStatus }
  ): Promise<Form[]>
  find(scope: TenantScope, id: string): Promise<Form | null>
  /** A revisão mais alta deste formulário (qualquer estado). */
  latest(scope: TenantScope, entityDefinitionId: string, code: string): Promise<Form | null>
  /** `null` se já existe um rascunho ou a revisão pedida. */
  insert(scope: TenantScope, values: FormValues & { revision: number }): Promise<Form | null>
  update(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    patch: Partial<Omit<FormValues, 'entityDefinitionId' | 'code'>>
  ): Promise<Form>
  /** Retira a revisão em vigor do mesmo código e publica esta, numa só operação. */
  publish(
    scope: TenantScope,
    form: Form,
    schemaRevision: number,
    expectedVersion: number
  ): Promise<Form>
  retire(scope: TenantScope, id: string, expectedVersion: number): Promise<Form>
}

export interface FormTarget {
  id: string
  code: string
  published: boolean
  /** Revisão da versão publicada em vigor. */
  revision: number | null
  fields: readonly FormFieldInfo[]
}

/** Entidades dinâmicas (módulo de metadados) vistas pelos formulários. */
export interface FormTargets {
  findByCode(context: TenantContext, code: string): Promise<FormTarget | null>
  findById(context: TenantContext, id: string): Promise<FormTarget | null>
}
