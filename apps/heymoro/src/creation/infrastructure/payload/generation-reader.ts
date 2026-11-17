import type { Where } from 'payload'

import type { GenerationReader } from '../../application/generation-reader-types.js'
import type { SnapshotFind } from './read-snapshot.js'

import { GenerationError } from '../../domain/generation.js'

const selections: Readonly<Record<string, readonly string[]>> = {
  artifacts: ['userId', 'sessionId', 'taskId', 'mediaId', 'outputIndex', 'isDeleted'],
  auditLogs: [
    'actorType',
    'actorId',
    'action',
    'resourceType',
    'resourceId',
    'correlationId',
    'requestId',
    'summary',
    'beforeState',
    'afterState',
    'isDeleted',
  ],
  'creation-sessions': [
    'userId',
    'templateId',
    'mode',
    'nextRoundNo',
    'title',
    'titleSource',
    'autoNameStartedAt',
    'autoNamedAt',
    'autoNameStatus',
    'coverArtifactId',
    'lastActivityAt',
    'isDeleted',
  ],
  'creation-templates': [
    'kind',
    'status',
    'isDeleted',
    'costCredits',
    'displayConfigJson',
    'generationConfigJson',
    'inputSchemaJson',
    'minClientCapability',
    'schemaVersion',
  ],
  'credit-accounts': ['userId', 'availableCredits', 'reservedCredits', 'isDeleted'],
  'credit-allocations': ['reservationId', 'grantId', 'amountCredits', 'status', 'isDeleted'],
  'credit-grants': [
    'accountId',
    'userId',
    'grantKey',
    'sourceType',
    'sourceId',
    'issuedCredits',
    'availableCredits',
    'reservedCredits',
    'consumedCredits',
    'expiredCredits',
    'revokedCredits',
    'validFrom',
    'expiresAt',
    'isDeleted',
  ],
  'credit-ledger': [
    'accountId',
    'userId',
    'grantId',
    'reservationId',
    'eventKey',
    'operation',
    'amountCredits',
    'availableDelta',
    'reservedDelta',
    'consumedDelta',
    'expiredDelta',
    'revokedDelta',
    'reasonCode',
    'isDeleted',
  ],
  'credit-reservations': [
    'accountId',
    'userId',
    'taskId',
    'reservationKey',
    'amountCredits',
    'status',
    'isDeleted',
  ],
  'generation-attempts': [
    'taskId',
    'attemptNo',
    'provider',
    'model',
    'status',
    'providerRequestId',
    'leaseUntil',
    'startedAt',
    'finishedAt',
    'errorCode',
    'resultStorageBackend',
    'resultStorageBucket',
    'resultStorageKey',
    'resultSha256',
    'isDeleted',
  ],
  'generation-inputs': ['taskId', 'userId', 'mediaId', 'position', 'contentSha256', 'isDeleted'],
  'generation-tasks': [
    'templateId',
    'userId',
    'sessionId',
    'roundNo',
    'sourceTaskId',
    'clientRequestId',
    'requestHash',
    'status',
    'description',
    'userNotes',
    'executionSnapshotJson',
    'costCredits',
    'errorCode',
    'startedAt',
    'finishedAt',
    'isDeleted',
  ],
  media: [
    'owner',
    'isDeleted',
    'lifecycle',
    'visibility',
    'purpose',
    'mimeType',
    'filesize',
    'width',
    'height',
    'storageBackend',
    'storageBucket',
    'storageName',
    'sha256',
  ],
  users: ['status', 'isDeleted'],
}
/** Fixed semantic read contracts; all values remain untrusted until application validation. */
export function createGenerationReader({ find }: { find: SnapshotFind }): GenerationReader {
  const query = async ({
    collection,
    limit = 2,
    sort,
    where,
  }: {
    collection: string
    limit?: number
    sort?: string
    where: Where
  }) => {
    const fields = selections[collection]!
    const result = await find({
      collection,
      limit,
      select: Object.fromEntries(['id', ...fields].map((field) => [field, true])),
      showHiddenFields: true,
      sort,
      where,
    })
    if (limit === 0 && result.docs.length !== result.totalDocs) {
      throw new GenerationError({ code: 'DATA_INTEGRITY_CONFLICT' })
    }
    return result.docs
  }
  return {
    findAllocationCandidates: async ({ grantId, reservationId }) =>
      (
        await query({
          collection: 'credit-allocations',
          limit: 2,
          sort: undefined,
          where: {
            and: [{ reservationId: { equals: reservationId } }, { grantId: { equals: grantId } }],
          },
        })
      ).map((doc) => ({
        id: doc.id,
        amountCredits: doc.amountCredits,
        grantId: doc.grantId,
        isDeleted: doc.isDeleted,
        reservationId: doc.reservationId,
        status: doc.status,
      })),
    findArtifactCandidates: async ({ artifactId }) =>
      (
        await query({
          collection: 'artifacts',
          limit: 2,
          sort: undefined,
          where: { id: { equals: artifactId } },
        })
      ).map((doc) => ({
        id: doc.id,
        isDeleted: doc.isDeleted,
        mediaId: doc.mediaId,
        outputIndex: doc.outputIndex,
        sessionId: doc.sessionId,
        taskId: doc.taskId,
        userId: doc.userId,
      })),
    findBlockingTaskCandidates: async ({ sessionId }) =>
      (
        await query({
          collection: 'generation-tasks',
          limit: 2,
          sort: undefined,
          where: {
            and: [
              { sessionId: { equals: sessionId } },
              { status: { in: ['queued', 'running', 'unknown'] } },
            ],
          },
        })
      ).map((doc) => ({
        id: doc.id,
        clientRequestId: doc.clientRequestId,
        costCredits: doc.costCredits,
        description: doc.description,
        errorCode: doc.errorCode,
        executionSnapshotJson: doc.executionSnapshotJson,
        finishedAt: doc.finishedAt,
        isDeleted: doc.isDeleted,
        requestHash: doc.requestHash,
        roundNo: doc.roundNo,
        sessionId: doc.sessionId,
        sourceTaskId: doc.sourceTaskId,
        startedAt: doc.startedAt,
        status: doc.status,
        templateId: doc.templateId,
        userId: doc.userId,
        userNotes: doc.userNotes,
      })),
    findCloseOperationConflicts: async ({ operationId, taskId }) =>
      (
        await query({
          collection: 'auditLogs',
          limit: 2,
          sort: undefined,
          where: {
            or: [
              { correlationId: { equals: operationId } },
              {
                and: [
                  { action: { equals: 'GENERATION_UNKNOWN_CLOSED' } },
                  { resourceId: { equals: String(taskId) } },
                ],
              },
            ],
          },
        })
      ).map((doc) => ({
        id: doc.id,
        action: doc.action,
        actorId: doc.actorId,
        actorType: doc.actorType,
        afterState: doc.afterState,
        beforeState: doc.beforeState,
        correlationId: doc.correlationId,
        isDeleted: doc.isDeleted,
        requestId: doc.requestId,
        resourceId: doc.resourceId,
        resourceType: doc.resourceType,
        summary: doc.summary,
      })),
    findFinancialEventCandidates: async ({ eventKey }) =>
      (
        await query({
          collection: 'credit-ledger',
          limit: 2,
          sort: undefined,
          where: { eventKey: { equals: eventKey } },
        })
      ).map((doc) => ({
        id: doc.id,
        accountId: doc.accountId,
        amountCredits: doc.amountCredits,
        availableDelta: doc.availableDelta,
        consumedDelta: doc.consumedDelta,
        eventKey: doc.eventKey,
        expiredDelta: doc.expiredDelta,
        grantId: doc.grantId,
        isDeleted: doc.isDeleted,
        operation: doc.operation,
        reasonCode: doc.reasonCode,
        reservationId: doc.reservationId,
        reservedDelta: doc.reservedDelta,
        revokedDelta: doc.revokedDelta,
        userId: doc.userId,
      })),
    findGenerationReservationCandidates: async ({ taskId }) =>
      (
        await query({
          collection: 'credit-reservations',
          limit: 2,
          sort: undefined,
          where: {
            or: [
              { taskId: { equals: taskId } },
              { reservationKey: { equals: `generation:${taskId}` } },
            ],
          },
        })
      ).map((doc) => ({
        id: doc.id,
        accountId: doc.accountId,
        amountCredits: doc.amountCredits,
        isDeleted: doc.isDeleted,
        reservationKey: doc.reservationKey,
        status: doc.status,
        taskId: doc.taskId,
        userId: doc.userId,
      })),
    findGrantCandidates: async ({ grantId }) =>
      (
        await query({
          collection: 'credit-grants',
          limit: 2,
          sort: undefined,
          where: { id: { equals: grantId } },
        })
      ).map((doc) => ({
        id: doc.id,
        accountId: doc.accountId,
        availableCredits: doc.availableCredits,
        consumedCredits: doc.consumedCredits,
        expiredCredits: doc.expiredCredits,
        expiresAt: doc.expiresAt,
        grantKey: doc.grantKey,
        isDeleted: doc.isDeleted,
        issuedCredits: doc.issuedCredits,
        reservedCredits: doc.reservedCredits,
        revokedCredits: doc.revokedCredits,
        sourceId: doc.sourceId,
        sourceType: doc.sourceType,
        userId: doc.userId,
        validFrom: doc.validFrom,
      })),
    findGrantKeyCandidates: async ({ grantKey }) =>
      (
        await query({
          collection: 'credit-grants',
          limit: 2,
          sort: undefined,
          where: { grantKey: { equals: grantKey } },
        })
      ).map((doc) => ({
        id: doc.id,
        accountId: doc.accountId,
        availableCredits: doc.availableCredits,
        consumedCredits: doc.consumedCredits,
        expiredCredits: doc.expiredCredits,
        expiresAt: doc.expiresAt,
        grantKey: doc.grantKey,
        isDeleted: doc.isDeleted,
        issuedCredits: doc.issuedCredits,
        reservedCredits: doc.reservedCredits,
        revokedCredits: doc.revokedCredits,
        sourceId: doc.sourceId,
        sourceType: doc.sourceType,
        userId: doc.userId,
        validFrom: doc.validFrom,
      })),
    findGrantKeysCandidates: async ({ grantKeys }) =>
      (
        await query({
          collection: 'credit-grants',
          limit: grantKeys.length * 2,
          sort: undefined,
          where: { grantKey: { in: [...grantKeys] } },
        })
      ).map((doc) => ({
        id: doc.id,
        accountId: doc.accountId,
        availableCredits: doc.availableCredits,
        consumedCredits: doc.consumedCredits,
        expiredCredits: doc.expiredCredits,
        expiresAt: doc.expiresAt,
        grantKey: doc.grantKey,
        isDeleted: doc.isDeleted,
        issuedCredits: doc.issuedCredits,
        reservedCredits: doc.reservedCredits,
        revokedCredits: doc.revokedCredits,
        sourceId: doc.sourceId,
        sourceType: doc.sourceType,
        userId: doc.userId,
        validFrom: doc.validFrom,
      })),
    findMediaCandidates: async ({ mediaId }) =>
      (
        await query({
          collection: 'media',
          limit: 2,
          sort: undefined,
          where: { id: { equals: mediaId } },
        })
      ).map((doc) => ({
        id: doc.id,
        filesize: doc.filesize,
        height: doc.height,
        isDeleted: doc.isDeleted,
        lifecycle: doc.lifecycle,
        mimeType: doc.mimeType,
        owner: doc.owner,
        purpose: doc.purpose,
        sha256: doc.sha256,
        storageBackend: doc.storageBackend,
        storageBucket: doc.storageBucket,
        storageName: doc.storageName,
        visibility: doc.visibility,
        width: doc.width,
      })),
    findMediaLocationCandidates: async ({ ref }) =>
      (
        await query({
          collection: 'media',
          limit: 2,
          sort: undefined,
          where: {
            and: [
              { storageBackend: { equals: ref.backend } },
              { storageBucket: { equals: ref.bucket } },
              { storageName: { equals: ref.key } },
            ],
          },
        })
      ).map((doc) => ({
        id: doc.id,
        filesize: doc.filesize,
        height: doc.height,
        isDeleted: doc.isDeleted,
        lifecycle: doc.lifecycle,
        mimeType: doc.mimeType,
        owner: doc.owner,
        purpose: doc.purpose,
        sha256: doc.sha256,
        storageBackend: doc.storageBackend,
        storageBucket: doc.storageBucket,
        storageName: doc.storageName,
        visibility: doc.visibility,
        width: doc.width,
      })),
    findOutputIdentityCandidates: async ({ outputIndex, taskId }) =>
      (
        await query({
          collection: 'artifacts',
          limit: 2,
          sort: undefined,
          where: {
            and: [{ taskId: { equals: taskId } }, { outputIndex: { equals: outputIndex } }],
          },
        })
      ).map((doc) => ({
        id: doc.id,
        isDeleted: doc.isDeleted,
        mediaId: doc.mediaId,
        outputIndex: doc.outputIndex,
        sessionId: doc.sessionId,
        taskId: doc.taskId,
        userId: doc.userId,
      })),
    findOwnerAccountCandidates: async ({ userId }) =>
      (
        await query({
          collection: 'credit-accounts',
          limit: 2,
          sort: undefined,
          where: { userId: { equals: userId } },
        })
      ).map((doc) => ({
        id: doc.id,
        availableCredits: doc.availableCredits,
        isDeleted: doc.isDeleted,
        reservedCredits: doc.reservedCredits,
        userId: doc.userId,
      })),
    findRequestCandidates: async ({ clientRequestId, userId }) =>
      (
        await query({
          collection: 'generation-tasks',
          limit: 2,
          sort: undefined,
          where: {
            and: [{ userId: { equals: userId } }, { clientRequestId: { equals: clientRequestId } }],
          },
        })
      ).map((doc) => ({
        id: doc.id,
        clientRequestId: doc.clientRequestId,
        costCredits: doc.costCredits,
        description: doc.description,
        errorCode: doc.errorCode,
        executionSnapshotJson: doc.executionSnapshotJson,
        finishedAt: doc.finishedAt,
        isDeleted: doc.isDeleted,
        requestHash: doc.requestHash,
        roundNo: doc.roundNo,
        sessionId: doc.sessionId,
        sourceTaskId: doc.sourceTaskId,
        startedAt: doc.startedAt,
        status: doc.status,
        templateId: doc.templateId,
        userId: doc.userId,
        userNotes: doc.userNotes,
      })),
    findReservationAccountCandidates: async ({ accountId, userId }) =>
      (
        await query({
          collection: 'credit-accounts',
          limit: 2,
          sort: undefined,
          where: { or: [{ userId: { equals: userId } }, { id: { equals: accountId } }] },
        })
      ).map((doc) => ({
        id: doc.id,
        availableCredits: doc.availableCredits,
        isDeleted: doc.isDeleted,
        reservedCredits: doc.reservedCredits,
        userId: doc.userId,
      })),
    findRoundCandidates: async ({ roundNo, sessionId }) =>
      (
        await query({
          collection: 'generation-tasks',
          limit: 2,
          sort: undefined,
          where: { and: [{ sessionId: { equals: sessionId } }, { roundNo: { equals: roundNo } }] },
        })
      ).map((doc) => ({
        id: doc.id,
        clientRequestId: doc.clientRequestId,
        costCredits: doc.costCredits,
        description: doc.description,
        errorCode: doc.errorCode,
        executionSnapshotJson: doc.executionSnapshotJson,
        finishedAt: doc.finishedAt,
        isDeleted: doc.isDeleted,
        requestHash: doc.requestHash,
        roundNo: doc.roundNo,
        sessionId: doc.sessionId,
        sourceTaskId: doc.sourceTaskId,
        startedAt: doc.startedAt,
        status: doc.status,
        templateId: doc.templateId,
        userId: doc.userId,
        userNotes: doc.userNotes,
      })),
    findSessionCandidates: async ({ sessionId }) =>
      (
        await query({
          collection: 'creation-sessions',
          limit: 2,
          sort: undefined,
          where: { id: { equals: sessionId } },
        })
      ).map((doc) => ({
        id: doc.id,
        autoNamedAt: doc.autoNamedAt,
        autoNameStartedAt: doc.autoNameStartedAt,
        autoNameStatus: doc.autoNameStatus,
        coverArtifactId: doc.coverArtifactId,
        isDeleted: doc.isDeleted,
        lastActivityAt: doc.lastActivityAt,
        mode: doc.mode,
        nextRoundNo: doc.nextRoundNo,
        templateId: doc.templateId,
        title: doc.title,
        titleSource: doc.titleSource,
        userId: doc.userId,
      })),
    findTaskArtifactCandidates: async ({ taskId }) =>
      (
        await query({
          collection: 'artifacts',
          limit: 2,
          sort: undefined,
          where: { taskId: { equals: taskId } },
        })
      ).map((doc) => ({
        id: doc.id,
        isDeleted: doc.isDeleted,
        mediaId: doc.mediaId,
        outputIndex: doc.outputIndex,
        sessionId: doc.sessionId,
        taskId: doc.taskId,
        userId: doc.userId,
      })),
    findTaskCandidates: async ({ taskId }) =>
      (
        await query({
          collection: 'generation-tasks',
          limit: 2,
          sort: undefined,
          where: { id: { equals: taskId } },
        })
      ).map((doc) => ({
        id: doc.id,
        clientRequestId: doc.clientRequestId,
        costCredits: doc.costCredits,
        description: doc.description,
        errorCode: doc.errorCode,
        executionSnapshotJson: doc.executionSnapshotJson,
        finishedAt: doc.finishedAt,
        isDeleted: doc.isDeleted,
        requestHash: doc.requestHash,
        roundNo: doc.roundNo,
        sessionId: doc.sessionId,
        sourceTaskId: doc.sourceTaskId,
        startedAt: doc.startedAt,
        status: doc.status,
        templateId: doc.templateId,
        userId: doc.userId,
        userNotes: doc.userNotes,
      })),
    findTaskCloseAuditCandidates: async ({ taskId }) =>
      (
        await query({
          collection: 'auditLogs',
          limit: 2,
          sort: undefined,
          where: {
            and: [
              { action: { equals: 'GENERATION_UNKNOWN_CLOSED' } },
              { resourceType: { equals: 'generation-task' } },
              { resourceId: { equals: String(taskId) } },
            ],
          },
        })
      ).map((doc) => ({
        id: doc.id,
        action: doc.action,
        actorId: doc.actorId,
        actorType: doc.actorType,
        afterState: doc.afterState,
        beforeState: doc.beforeState,
        correlationId: doc.correlationId,
        isDeleted: doc.isDeleted,
        requestId: doc.requestId,
        resourceId: doc.resourceId,
        resourceType: doc.resourceType,
        summary: doc.summary,
      })),
    findTaskReservationCandidates: async ({ taskId }) =>
      (
        await query({
          collection: 'credit-reservations',
          limit: 2,
          sort: undefined,
          where: { taskId: { equals: taskId } },
        })
      ).map((doc) => ({
        id: doc.id,
        accountId: doc.accountId,
        amountCredits: doc.amountCredits,
        isDeleted: doc.isDeleted,
        reservationKey: doc.reservationKey,
        status: doc.status,
        taskId: doc.taskId,
        userId: doc.userId,
      })),
    findTemplateCandidates: async ({ templateId }) =>
      (
        await query({
          collection: 'creation-templates',
          limit: 2,
          sort: undefined,
          where: { id: { equals: templateId } },
        })
      ).map((doc) => ({
        id: doc.id,
        costCredits: doc.costCredits,
        displayConfigJson: doc.displayConfigJson,
        generationConfigJson: doc.generationConfigJson,
        inputSchemaJson: doc.inputSchemaJson,
        isDeleted: doc.isDeleted,
        kind: doc.kind,
        minClientCapability: doc.minClientCapability,
        schemaVersion: doc.schemaVersion,
        status: doc.status,
      })),
    findUserCandidates: async ({ userId }) =>
      (
        await query({
          collection: 'users',
          limit: 2,
          sort: undefined,
          where: { id: { equals: userId } },
        })
      ).map((doc) => ({ id: doc.id, isDeleted: doc.isDeleted, status: doc.status })),
    readFirstSessionArtifact: async ({ sessionId }) =>
      (
        await query({
          collection: 'artifacts',
          limit: 1,
          sort: 'id',
          where: { sessionId: { equals: sessionId } },
        })
      ).map((doc) => ({
        id: doc.id,
        isDeleted: doc.isDeleted,
        mediaId: doc.mediaId,
        outputIndex: doc.outputIndex,
        sessionId: doc.sessionId,
        taskId: doc.taskId,
        userId: doc.userId,
      })),
    readGenerationFinancialEvidence: async ({ reservationId, taskId }) =>
      (
        await query({
          collection: 'credit-ledger',
          limit: 0,
          sort: undefined,
          where: {
            or: [
              { reservationId: { equals: reservationId } },
              ...['reserve', 'capture', 'release'].map((operation) => {
                const prefix = `${operation}:generation:${taskId}:`
                return {
                  and: [
                    { eventKey: { greater_than_equal: prefix } },
                    { eventKey: { less_than: `${prefix.slice(0, -1)};` } },
                  ],
                }
              }),
            ],
          },
        })
      ).map((doc) => ({
        id: doc.id,
        accountId: doc.accountId,
        amountCredits: doc.amountCredits,
        availableDelta: doc.availableDelta,
        consumedDelta: doc.consumedDelta,
        eventKey: doc.eventKey,
        expiredDelta: doc.expiredDelta,
        grantId: doc.grantId,
        isDeleted: doc.isDeleted,
        operation: doc.operation,
        reasonCode: doc.reasonCode,
        reservationId: doc.reservationId,
        reservedDelta: doc.reservedDelta,
        revokedDelta: doc.revokedDelta,
        userId: doc.userId,
      })),
    readRelatedGrants: async ({ accountId, userId }) =>
      (
        await query({
          collection: 'credit-grants',
          limit: 0,
          sort: undefined,
          where: { or: [{ accountId: { equals: accountId } }, { userId: { equals: userId } }] },
        })
      ).map((doc) => ({
        id: doc.id,
        accountId: doc.accountId,
        availableCredits: doc.availableCredits,
        consumedCredits: doc.consumedCredits,
        expiredCredits: doc.expiredCredits,
        expiresAt: doc.expiresAt,
        grantKey: doc.grantKey,
        isDeleted: doc.isDeleted,
        issuedCredits: doc.issuedCredits,
        reservedCredits: doc.reservedCredits,
        revokedCredits: doc.revokedCredits,
        sourceId: doc.sourceId,
        sourceType: doc.sourceType,
        userId: doc.userId,
        validFrom: doc.validFrom,
      })),
    readReservationAllocations: async ({ reservationId }) =>
      (
        await query({
          collection: 'credit-allocations',
          limit: 0,
          sort: undefined,
          where: { reservationId: { equals: reservationId } },
        })
      ).map((doc) => ({
        id: doc.id,
        amountCredits: doc.amountCredits,
        grantId: doc.grantId,
        isDeleted: doc.isDeleted,
        reservationId: doc.reservationId,
        status: doc.status,
      })),
    readTaskArtifacts: async ({ taskId }) =>
      (
        await query({
          collection: 'artifacts',
          limit: 0,
          sort: undefined,
          where: { taskId: { equals: taskId } },
        })
      ).map((doc) => ({
        id: doc.id,
        isDeleted: doc.isDeleted,
        mediaId: doc.mediaId,
        outputIndex: doc.outputIndex,
        sessionId: doc.sessionId,
        taskId: doc.taskId,
        userId: doc.userId,
      })),
    readTaskAttempts: async ({ taskId }) =>
      (
        await query({
          collection: 'generation-attempts',
          limit: 0,
          sort: 'attemptNo',
          where: { taskId: { equals: taskId } },
        })
      ).map((doc) => ({
        id: doc.id,
        attemptNo: doc.attemptNo,
        errorCode: doc.errorCode,
        finishedAt: doc.finishedAt,
        isDeleted: doc.isDeleted,
        leaseUntil: doc.leaseUntil,
        model: doc.model,
        provider: doc.provider,
        providerRequestId: doc.providerRequestId,
        resultSha256: doc.resultSha256,
        resultStorageBackend: doc.resultStorageBackend,
        resultStorageBucket: doc.resultStorageBucket,
        resultStorageKey: doc.resultStorageKey,
        startedAt: doc.startedAt,
        status: doc.status,
        taskId: doc.taskId,
      })),
    readTaskInputs: async ({ taskId }) =>
      (
        await query({
          collection: 'generation-inputs',
          limit: 0,
          sort: 'position',
          where: { taskId: { equals: taskId } },
        })
      ).map((doc) => ({
        id: doc.id,
        contentSha256: doc.contentSha256,
        isDeleted: doc.isDeleted,
        mediaId: doc.mediaId,
        position: doc.position,
        taskId: doc.taskId,
        userId: doc.userId,
      })),
  }
}
