import { ApiError } from '#core/http/api_error'
import type { TenantContext, TenantScope, TenantUnitOfWork } from '#core/tenancy/index'
import {
  FORM_CODE,
  checkFormAgainstFields,
  normalizeModes,
  normalizeSections,
  type FormIssue,
  type FormStatus,
} from '#dynamic/forms/domain/form'
import type {
  Form,
  FormStore,
  FormTarget,
  FormTargets,
  FormValues,
  FormView,
} from '#dynamic/forms/application/ports'

export const formValidation = (details: FormIssue[]) =>
  new ApiError(422, 'VALIDATION_ERROR', 'Verifique os campos indicados.', details)

export interface FormInput {
  name?: string
  description?: string | null
  modes?: unknown
  isDefault?: boolean
  sections?: unknown
}

export interface PreviewResult {
  /** Problemas que impediriam a publicação (vazio = publicável). */
  issues: FormIssue[]
  publishable: boolean
  entityRevision: number | null
}

/**
 * Casos de uso dos formulários (C11): rascunho → publicação imutável → retirada. Guardar um rascunho é distinto de
 * publicar: o rascunho só precisa de estar bem formado; a publicação volta a verificá-lo contra os campos da entidade
 * em vigor. Os formulários não mudam registos nem regras da entidade: só organizam a apresentação.
 */
export class FormUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly forms: FormStore,
    private readonly targets: FormTargets
  ) {}

  async list(
    context: TenantContext,
    filter: { entityCode?: string; status?: FormStatus }
  ): Promise<FormView[]> {
    let entityDefinitionId: string | undefined
    if (filter.entityCode) {
      const target = await this.targets.findByCode(context, filter.entityCode)
      if (!target) return []
      entityDefinitionId = target.id
    }
    const forms = await this.uow.run(
      (scope) => this.forms.list(scope, { entityDefinitionId, status: filter.status }),
      context
    )
    return this.withIssues(context, forms)
  }

  async get(context: TenantContext, id: string): Promise<FormView> {
    const form = await this.uow.run((scope) => this.mustFind(scope, id), context)
    const [view] = await this.withIssues(context, [form])
    return view as FormView
  }

  async create(
    context: TenantContext,
    input: FormInput & { entityCode: string; code: string }
  ): Promise<Form> {
    const issues: FormIssue[] = []
    const code = input.code.trim()
    if (!FORM_CODE.test(code)) {
      issues.push({
        path: 'code',
        code: 'INVALID_CODE',
        message: 'Código: começa por letra; a-z, 0-9 e _ (2 a 50).',
      })
    }
    const target = await this.publishedTarget(context, input.entityCode, issues)
    const values = this.values(input, null, issues)
    if (issues.length > 0 || !target || !values) throw formValidation(issues)

    return this.uow.run(async (scope) => {
      if (await this.forms.latest(scope, target.id, code)) {
        throw ApiError.conflict(
          'FORM_CODE_TAKEN',
          'Já existe um formulário com este código nesta entidade: abra uma nova revisão.'
        )
      }
      const form = await this.forms.insert(scope, {
        ...values,
        entityDefinitionId: target.id,
        code,
        revision: 1,
      })
      if (!form)
        throw ApiError.conflict('FORM_CODE_TAKEN', 'Já existe um formulário com este código.')
      return form
    }, context)
  }

  /** Só um rascunho se altera; um publicado ou retirado é imutável (nova revisão). */
  async update(
    context: TenantContext,
    id: string,
    input: FormInput & { expectedVersion: number }
  ): Promise<Form> {
    const current = await this.uow.run((scope) => this.mustFind(scope, id), context)
    if (current.status !== 'DRAFT') {
      throw ApiError.conflict('FORM_NOT_DRAFT', 'Só um rascunho se altera: abra uma nova revisão.')
    }
    const issues: FormIssue[] = []
    const values = this.values(input, current, issues)
    if (issues.length > 0 || !values) throw formValidation(issues)
    return this.uow.run(
      (scope) =>
        this.forms.update(scope, id, input.expectedVersion, {
          name: values.name,
          description: values.description,
          modes: values.modes,
          isDefault: values.isDefault,
          sections: values.sections,
        }),
      context
    )
  }

  /** Abre a próxima revisão em rascunho, a partir da mais recente. */
  createRevision(context: TenantContext, id: string): Promise<Form> {
    return this.uow.run(async (scope) => {
      const current = await this.mustFind(scope, id)
      const latest = (await this.forms.latest(
        scope,
        current.entityDefinitionId,
        current.code
      )) as Form
      if (latest.status === 'DRAFT') {
        throw ApiError.conflict('FORM_DRAFT_EXISTS', 'Já existe um rascunho deste formulário.')
      }
      const revision = await this.forms.insert(scope, {
        entityDefinitionId: latest.entityDefinitionId,
        code: latest.code,
        name: latest.name,
        description: latest.description,
        modes: latest.modes,
        isDefault: latest.isDefault,
        sections: latest.sections,
        revision: latest.revision + 1,
      })
      if (!revision) {
        throw ApiError.conflict('FORM_DRAFT_EXISTS', 'Já existe um rascunho deste formulário.')
      }
      return revision
    }, context)
  }

  /** Verifica o formulário contra a entidade em vigor, sem publicar nem gravar nada. */
  async preview(context: TenantContext, id: string): Promise<PreviewResult> {
    const form = await this.uow.run((scope) => this.mustFind(scope, id), context)
    const target = await this.targets.findById(context, form.entityDefinitionId)
    const issues = this.integrity(form, target)
    return {
      issues,
      publishable: form.status === 'DRAFT' && issues.length === 0,
      entityRevision: target?.revision ?? null,
    }
  }

  /**
   * Publica o rascunho: volta a verificá-lo contra os campos em vigor e, se estiver tudo bem, retira a revisão
   * anterior e torna esta imutável. Dois formulários por omissão do mesmo modo não podem coexistir.
   */
  async publish(context: TenantContext, id: string, expectedVersion: number): Promise<Form> {
    const current = await this.uow.run((scope) => this.mustFind(scope, id), context)
    if (current.status !== 'DRAFT') {
      throw ApiError.conflict('FORM_NOT_DRAFT', 'Só um rascunho se publica.')
    }
    const target = await this.targets.findById(context, current.entityDefinitionId)
    const issues = this.integrity(current, target)
    if (issues.length > 0 || !target || target.revision === null) throw formValidation(issues)
    const schemaRevision = target.revision
    return this.uow.run(async (scope) => {
      if (current.isDefault) {
        const published = await this.forms.list(scope, {
          entityDefinitionId: current.entityDefinitionId,
          status: 'PUBLISHED',
        })
        const clash = published.find(
          (f) =>
            f.isDefault && f.code !== current.code && f.modes.some((m) => current.modes.includes(m))
        )
        if (clash) {
          throw ApiError.conflict(
            'FORM_DEFAULT_TAKEN',
            `O formulário «${clash.code}» já é o formulário por omissão de um dos modos.`
          )
        }
      }
      return this.forms.publish(scope, current, schemaRevision, expectedVersion)
    }, context)
  }

  retire(context: TenantContext, id: string, expectedVersion: number): Promise<Form> {
    return this.uow.run(async (scope) => {
      const current = await this.mustFind(scope, id)
      if (current.status !== 'PUBLISHED') {
        throw ApiError.conflict('FORM_NOT_PUBLISHED', 'Só um formulário publicado se retira.')
      }
      return this.forms.retire(scope, id, expectedVersion)
    }, context)
  }

  // --- internos ------------------------------------------------------------------------------

  private async mustFind(scope: TenantScope, id: string): Promise<Form> {
    const form = await this.forms.find(scope, id)
    if (!form) throw ApiError.notFound()
    return form
  }

  private async publishedTarget(
    context: TenantContext,
    code: string,
    issues: FormIssue[]
  ): Promise<FormTarget | null> {
    const target = await this.targets.findByCode(context, code)
    if (!target) {
      issues.push({
        path: 'entityCode',
        code: 'NOT_FOUND',
        message: 'Entidade inexistente neste tenant.',
      })
      return null
    }
    if (!target.published) {
      issues.push({
        path: 'entityCode',
        code: 'ENTITY_NOT_PUBLISHED',
        message: 'Publique a entidade antes de lhe definir formulários.',
      })
    }
    return target
  }

  /** Valida a estrutura (sobre o rascunho actual, se existir, com as alterações pedidas) e devolve os valores finais. */
  private values(input: FormInput, base: Form | null, issues: FormIssue[]): FormValues | null {
    const before = issues.length
    const name = (input.name ?? base?.name ?? '').trim()
    if (!name || name.length > 160) {
      issues.push({
        path: 'name',
        code: 'INVALID_NAME',
        message: 'O nome é obrigatório (máx. 160).',
      })
    }
    const description =
      input.description === undefined
        ? (base?.description ?? null)
        : input.description?.trim() || null
    if (description && description.length > 500) {
      issues.push({
        path: 'description',
        code: 'INVALID_DESCRIPTION',
        message: 'Máx. 500 caracteres.',
      })
    }
    const modes = normalizeModes(
      input.modes === undefined ? (base?.modes ?? ['create', 'edit', 'read']) : input.modes,
      issues
    )
    const isDefault = input.isDefault ?? base?.isDefault ?? false
    if (typeof isDefault !== 'boolean') {
      issues.push({ path: 'isDefault', code: 'INVALID_FLAG', message: 'isDefault é booleano.' })
    }
    const sections = normalizeSections(
      input.sections === undefined ? base?.sections : input.sections,
      issues
    )
    if (issues.length > before) return null
    return {
      entityDefinitionId: base?.entityDefinitionId ?? '',
      code: base?.code ?? '',
      name,
      description,
      modes,
      isDefault,
      sections,
    }
  }

  /** Verificação contra a entidade em vigor: os campos têm de existir e nada pode ficar impossível de preencher. */
  private integrity(form: Form, target: FormTarget | null): FormIssue[] {
    if (!target) {
      return [{ path: 'entityCode', code: 'NOT_FOUND', message: 'A entidade já não existe.' }]
    }
    if (!target.published) {
      return [
        {
          path: 'entityCode',
          code: 'ENTITY_NOT_PUBLISHED',
          message: 'A entidade não está publicada.',
        },
      ]
    }
    return checkFormAgainstFields(form.sections, form.modes, target.fields)
  }

  /** Junta a cada formulário publicado o que o servidor verifica agora contra a entidade (a estrutura pode ter mudado). */
  private async withIssues(context: TenantContext, forms: Form[]): Promise<FormView[]> {
    const targets = new Map<string, FormTarget | null>()
    const views: FormView[] = []
    for (const form of forms) {
      let issues: FormIssue[] = []
      if (form.status === 'PUBLISHED') {
        if (!targets.has(form.entityDefinitionId)) {
          targets.set(
            form.entityDefinitionId,
            await this.targets.findById(context, form.entityDefinitionId)
          )
        }
        issues = this.integrity(form, targets.get(form.entityDefinitionId) ?? null)
      }
      views.push({ ...form, issues })
    }
    return views
  }
}
