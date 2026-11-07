/** API pública das aprovações. */
export {
  ApprovalRequestService,
  canViewRequest,
  registerSubjectHandler,
  submitForSubject,
  isActiveWorkflowFor,
  type ApprovalOutcome,
  approvalStats,
  searchApprovals,
  WorkflowService,
} from '#modules/approvals/application/approval_service'
export { SUBJECT_TYPES } from '#modules/approvals/domain/approvals'
