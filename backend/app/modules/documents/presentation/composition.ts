import { resolve } from 'node:path'
import app from '@adonisjs/core/services/app'
import env from '#start/env'
import { iamServices } from '#core/permissions/index'
import { LucidTenantDatabase } from '#core/tenancy/index'
import { AccessPolicy } from '#modules/documents/application/access'
import { AttachmentUseCases } from '#modules/documents/application/attachment_use_cases'
import {
  DocumentUseCases,
  ResourceAttachmentUseCases,
} from '#modules/documents/application/document_use_cases'
import { TemplateUseCases } from '#modules/documents/application/template_use_cases'
import type { Authorize, Limits } from '#modules/documents/application/ports'
import { HmacUrlSigner } from '#modules/documents/infrastructure/hmac_signer'
import {
  LucidAttachmentStore,
  LucidDocumentStore,
  LucidResourceAttachmentStore,
  LucidTemplateStore,
} from '#modules/documents/infrastructure/lucid_documents'
import { LocalObjectStorage } from '#modules/documents/infrastructure/local_storage'
import { SignatureScanner } from '#modules/documents/infrastructure/signature_scanner'

const authorize: Authorize = async (context, permission) => {
  const decision = await iamServices().authorize.decision(context, permission)
  return decision.allowed
}

function build() {
  const uow = new LucidTenantDatabase()
  const clock = { now: () => new Date() }
  const limits: Limits = {
    maxFileBytes: env.get('DOCUMENTS_MAX_FILE_BYTES') ?? 25 * 1024 * 1024,
    tenantQuotaBytes: env.get('DOCUMENTS_TENANT_QUOTA_BYTES') ?? 1024 * 1024 * 1024,
    uploadTtlSeconds: env.get('DOCUMENTS_UPLOAD_TTL_SECONDS') ?? 900,
    downloadTtlSeconds: env.get('DOCUMENTS_DOWNLOAD_TTL_SECONDS') ?? 60,
  }
  const storage = new LocalObjectStorage(
    env.get('DOCUMENTS_STORAGE_DIR') ?? resolve(app.makePath('storage'), 'documents')
  )
  const attachments = new LucidAttachmentStore()
  const documents = new LucidDocumentStore()
  const policy = new AccessPolicy(authorize)
  return {
    limits,
    attachments: new AttachmentUseCases(
      uow,
      attachments,
      storage,
      new SignatureScanner(),
      new HmacUrlSigner(env.get('APP_KEY')),
      policy,
      limits,
      clock
    ),
    documents: new DocumentUseCases(uow, documents, attachments, storage, policy, authorize, clock),
    links: new ResourceAttachmentUseCases(
      uow,
      new LucidResourceAttachmentStore(),
      attachments,
      policy
    ),
    templates: new TemplateUseCases(
      uow,
      new LucidTemplateStore(),
      documents,
      attachments,
      storage,
      policy,
      limits,
      clock
    ),
  }
}

let instance: ReturnType<typeof build> | undefined

export const documentServices = () => (instance ??= build())
