import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createGenerationReader } from '../src/creation/infrastructure/payload/generation-reader.ts'
import { GenerationError } from '../src/creation/domain/generation.ts'
import {
  assertTaskEvidence,
  singleCandidate,
} from '../src/creation/application/generation-evidence.ts'
import { readFirstNamingContext } from '../src/creation/application/session-naming-context.ts'

const fields = {
  artifacts: ['userId', 'sessionId', 'taskId', 'mediaId', 'outputIndex', 'isDeleted'],
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
  'generation-inputs': ['taskId', 'userId', 'mediaId', 'position', 'contentSha256', 'isDeleted'],
  'generation-tasks': [
    'userId',
    'sessionId',
    'roundNo',
    'templateId',
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
const contracts = [
  [
    'findUserCandidates',
    'users',
    { userId: 11 },
    (args) => {
      const { userId } = args
      return { id: { equals: userId } }
    },
    (args) => {
      const { userId } = args
      return 2
    },
    undefined,
  ],
  [
    'findSessionCandidates',
    'creation-sessions',
    { sessionId: 12 },
    (args) => {
      const { sessionId } = args
      return { id: { equals: sessionId } }
    },
    (args) => {
      const { sessionId } = args
      return 2
    },
    undefined,
  ],
  [
    'findTemplateCandidates',
    'creation-templates',
    { templateId: 13 },
    (args) => {
      const { templateId } = args
      return { id: { equals: templateId } }
    },
    (args) => {
      const { templateId } = args
      return 2
    },
    undefined,
  ],
  [
    'findMediaCandidates',
    'media',
    { mediaId: 15 },
    (args) => {
      const { mediaId } = args
      return { id: { equals: mediaId } }
    },
    (args) => {
      const { mediaId } = args
      return 2
    },
    undefined,
  ],
  [
    'findArtifactCandidates',
    'artifacts',
    { artifactId: 16 },
    (args) => {
      const { artifactId } = args
      return { id: { equals: artifactId } }
    },
    (args) => {
      const { artifactId } = args
      return 2
    },
    undefined,
  ],
  [
    'findTaskCandidates',
    'generation-tasks',
    { taskId: 17 },
    (args) => {
      const { taskId } = args
      return { id: { equals: taskId } }
    },
    (args) => {
      const { taskId } = args
      return 2
    },
    undefined,
  ],
  [
    'findGrantCandidates',
    'credit-grants',
    { grantId: 18 },
    (args) => {
      const { grantId } = args
      return { id: { equals: grantId } }
    },
    (args) => {
      const { grantId } = args
      return 2
    },
    undefined,
  ],
  [
    'findRequestCandidates',
    'generation-tasks',
    { userId: 11, clientRequestId: 'request' },
    (args) => {
      const { userId, clientRequestId } = args
      return {
        and: [{ userId: { equals: userId } }, { clientRequestId: { equals: clientRequestId } }],
      }
    },
    (args) => {
      const { userId, clientRequestId } = args
      return 2
    },
    undefined,
  ],
  [
    'findBlockingTaskCandidates',
    'generation-tasks',
    { sessionId: 12 },
    (args) => {
      const { sessionId } = args
      return {
        and: [
          { sessionId: { equals: sessionId } },
          { status: { in: ['queued', 'running', 'unknown'] } },
        ],
      }
    },
    (args) => {
      const { sessionId } = args
      return 2
    },
    undefined,
  ],
  [
    'findRoundCandidates',
    'generation-tasks',
    { sessionId: 12, roundNo: 2 },
    (args) => {
      const { sessionId, roundNo } = args
      return { and: [{ sessionId: { equals: sessionId } }, { roundNo: { equals: roundNo } }] }
    },
    (args) => {
      const { sessionId, roundNo } = args
      return 2
    },
    undefined,
  ],
  [
    'findOutputIdentityCandidates',
    'artifacts',
    { taskId: 17, outputIndex: 1 },
    (args) => {
      const { taskId, outputIndex } = args
      return { and: [{ taskId: { equals: taskId } }, { outputIndex: { equals: outputIndex } }] }
    },
    (args) => {
      const { taskId, outputIndex } = args
      return 2
    },
    undefined,
  ],
  [
    'readTaskInputs',
    'generation-inputs',
    { taskId: 17 },
    (args) => {
      const { taskId } = args
      return { taskId: { equals: taskId } }
    },
    (args) => {
      const { taskId } = args
      return 0
    },
    'position',
  ],
  [
    'findGenerationReservationCandidates',
    'credit-reservations',
    { taskId: 17 },
    (args) => {
      const { taskId } = args
      return {
        or: [
          { taskId: { equals: taskId } },
          { reservationKey: { equals: `generation:${taskId}` } },
        ],
      }
    },
    (args) => {
      const { taskId } = args
      return 2
    },
    undefined,
  ],
  [
    'findTaskReservationCandidates',
    'credit-reservations',
    { taskId: 17 },
    (args) => {
      const { taskId } = args
      return { taskId: { equals: taskId } }
    },
    (args) => {
      const { taskId } = args
      return 2
    },
    undefined,
  ],
  [
    'findReservationAccountCandidates',
    'credit-accounts',
    { userId: 11, accountId: 19 },
    (args) => {
      const { userId, accountId } = args
      return { or: [{ userId: { equals: userId } }, { id: { equals: accountId } }] }
    },
    (args) => {
      const { userId, accountId } = args
      return 2
    },
    undefined,
  ],
  [
    'findOwnerAccountCandidates',
    'credit-accounts',
    { userId: 11 },
    (args) => {
      const { userId } = args
      return { userId: { equals: userId } }
    },
    (args) => {
      const { userId } = args
      return 2
    },
    undefined,
  ],
  [
    'readReservationAllocations',
    'credit-allocations',
    { reservationId: 20 },
    (args) => {
      const { reservationId } = args
      return { reservationId: { equals: reservationId } }
    },
    (args) => {
      const { reservationId } = args
      return 0
    },
    undefined,
  ],
  [
    'findAllocationCandidates',
    'credit-allocations',
    { reservationId: 20, grantId: 18 },
    (args) => {
      const { reservationId, grantId } = args
      return {
        and: [{ reservationId: { equals: reservationId } }, { grantId: { equals: grantId } }],
      }
    },
    (args) => {
      const { reservationId, grantId } = args
      return 2
    },
    undefined,
  ],
  [
    'readRelatedGrants',
    'credit-grants',
    { accountId: 19, userId: 11 },
    (args) => {
      const { accountId, userId } = args
      return { or: [{ accountId: { equals: accountId } }, { userId: { equals: userId } }] }
    },
    (args) => {
      const { accountId, userId } = args
      return 0
    },
    undefined,
  ],
  [
    'findGrantKeyCandidates',
    'credit-grants',
    { grantKey: 'grant' },
    (args) => {
      const { grantKey } = args
      return { grantKey: { equals: grantKey } }
    },
    (args) => {
      const { grantKey } = args
      return 2
    },
    undefined,
  ],
  [
    'findGrantKeysCandidates',
    'credit-grants',
    { grantKeys: ['grant', 'other'] },
    (args) => {
      const { grantKeys } = args
      return { grantKey: { in: [...grantKeys] } }
    },
    (args) => {
      const { grantKeys } = args
      return grantKeys.length * 2
    },
    undefined,
  ],
  [
    'findFinancialEventCandidates',
    'credit-ledger',
    { eventKey: 'event' },
    (args) => {
      const { eventKey } = args
      return { eventKey: { equals: eventKey } }
    },
    (args) => {
      const { eventKey } = args
      return 2
    },
    undefined,
  ],
  [
    'readGenerationFinancialEvidence',
    'credit-ledger',
    { taskId: 17, reservationId: 20 },
    (args) => {
      const { taskId, reservationId } = args
      return {
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
      }
    },
    (args) => {
      const { taskId, reservationId } = args
      return 0
    },
    undefined,
  ],
  [
    'readTaskArtifacts',
    'artifacts',
    { taskId: 17 },
    (args) => {
      const { taskId } = args
      return { taskId: { equals: taskId } }
    },
    (args) => {
      const { taskId } = args
      return 0
    },
    undefined,
  ],
  [
    'findTaskArtifactCandidates',
    'artifacts',
    { taskId: 17 },
    (args) => {
      const { taskId } = args
      return { taskId: { equals: taskId } }
    },
    (args) => {
      const { taskId } = args
      return 2
    },
    undefined,
  ],
  [
    'findMediaLocationCandidates',
    'media',
    { ref: { backend: 's3', bucket: 'bucket', key: 'name' } },
    (args) => {
      const { ref } = args
      return {
        and: [
          { storageBackend: { equals: ref.backend } },
          { storageBucket: { equals: ref.bucket } },
          { storageName: { equals: ref.key } },
        ],
      }
    },
    (args) => {
      const { ref } = args
      return 2
    },
    undefined,
  ],
  [
    'findTaskCloseAuditCandidates',
    'auditLogs',
    { taskId: 17 },
    (args) => {
      const { taskId } = args
      return {
        and: [
          { action: { equals: 'GENERATION_UNKNOWN_CLOSED' } },
          { resourceType: { equals: 'generation-task' } },
          { resourceId: { equals: String(taskId) } },
        ],
      }
    },
    (args) => {
      const { taskId } = args
      return 2
    },
    undefined,
  ],
  [
    'findCloseOperationConflicts',
    'auditLogs',
    { operationId: 'operation', taskId: 17 },
    (args) => {
      const { operationId, taskId } = args
      return {
        or: [
          { correlationId: { equals: operationId } },
          {
            and: [
              { action: { equals: 'GENERATION_UNKNOWN_CLOSED' } },
              { resourceId: { equals: String(taskId) } },
            ],
          },
        ],
      }
    },
    (args) => {
      const { operationId, taskId } = args
      return 2
    },
    undefined,
  ],
  [
    'readFirstSessionArtifact',
    'artifacts',
    { sessionId: 12 },
    (args) => {
      const { sessionId } = args
      return { sessionId: { equals: sessionId } }
    },
    (args) => {
      const { sessionId } = args
      return 1
    },
    'id',
  ],
  [
    'readTaskAttempts',
    'generation-attempts',
    { taskId: 17 },
    (args) => {
      const { taskId } = args
      return { taskId: { equals: taskId } }
    },
    (args) => {
      const { taskId } = args
      return 0
    },
    'attemptNo',
  ],
]
for (const [name, collection, args, where, limit, sort] of contracts) {
  test(`${name}: fixed query, full projection, tombstone and second candidate`, async () => {
    const calls = []
    const docs = [
      {
        ...Object.fromEntries(fields[collection].map((field) => [field, { untrusted: field }])),
        id: 1,
        isDeleted: true,
        unexpected: 'never a fact',
      },
      { id: 2, isDeleted: false },
    ]
    const reader = createGenerationReader({
      find: async (query) => {
        calls.push(query)
        return { docs, totalDocs: docs.length }
      },
    })
    assert.equal(typeof reader[name], 'function')
    const result = await reader[name](args)
    assert.deepEqual(calls, [
      {
        collection,
        where: where(args),
        limit: limit(args),
        sort,
        select: Object.fromEntries(['id', ...fields[collection]].map((field) => [field, true])),
        showHiddenFields: true,
      },
    ])
    assert.deepEqual(
      result.map((doc) => doc.id),
      [1, 2],
    )
    assert.equal(result[0].isDeleted, true)
    assert.equal('unexpected' in result[0], false)
    assert.deepEqual(Object.keys(result[0]).sort(), ['id', ...fields[collection]].sort())
    for (const field of fields[collection]) assert.equal(result[0][field], docs[0][field])
  })
  if (limit(args) === 0) {
    test(`${name}: rejects incomplete full result`, async () => {
      const reader = createGenerationReader({ find: async () => ({ docs: [], totalDocs: 1 }) })
      await assert.rejects(
        () => reader[name](args),
        (error) => error instanceof GenerationError && error.code === 'DATA_INTEGRITY_CONFLICT',
      )
    })
  }
  test(`${name}: preserves snapshot error identity`, async () => {
    const error = new Error('snapshot aborted')
    const reader = createGenerationReader({
      find: async () => {
        throw error
      },
    })
    await assert.rejects(
      () => reader[name](args),
      (actual) => actual === error,
    )
  })
}
test('grant key batch uses in for one key and 2n for full 128-key batch', async () => {
  const calls = []
  const reader = createGenerationReader({
    find: async (query) => {
      calls.push(query)
      return { docs: [], totalDocs: 0 }
    },
  })
  for (const grantKeys of [['one'], Array.from({ length: 128 }, (_, index) => `key:${index}`)]) {
    await reader.findGrantKeysCandidates({ grantKeys })
    assert.deepEqual(calls.at(-1).where, { grantKey: { in: grantKeys } })
    assert.equal(calls.at(-1).limit, grantKeys.length * 2)
  }
})
test('financial range second stage excludes adjacent task keys through actual evidence validation', async () => {
  const events = [
    { id: 1, eventKey: 'reserve:generation:170:1', reservationId: 99 },
    { id: 2, eventKey: 'reserve:generation:17;', reservationId: 99 },
    { id: 3, eventKey: 'reserve:generation:17', reservationId: 99 },
    { id: 4, eventKey: null, reservationId: 99 },
  ]
  await financialEvidence({ events })
})
for (const event of [
  { eventKey: 'bad-key', reservationId: 20 },
  { eventKey: null, reservationId: 20 },
  { eventKey: 'reserve:generation:17:1', reservationId: 99 },
  { eventKey: 'capture:generation:17:1', reservationId: 99 },
  { eventKey: 'release:generation:17:1', reservationId: 99 },
]) {
  test(`financial evidence retains bad association or exact global prefix ${JSON.stringify(event)}`, async () => {
    await assert.rejects(
      () => financialEvidence({ events: [{ ...event, id: 1, isDeleted: false }] }),
      (error) => error instanceof GenerationError && error.code === 'DATA_INTEGRITY_CONFLICT',
    )
  })
}
async function financialEvidence({ events }) {
  const task = {
    id: 17,
    userId: 11,
    sessionId: 12,
    templateId: 13,
    status: 'queued',
    costCredits: 0,
  }
  const snapshot = { templateId: 13, mode: 'effect', media: [] }
  const rows = {
    'creation-sessions': [
      {
        id: 12,
        userId: 11,
        templateId: 13,
        mode: 'effect',
        isDeleted: false,
      },
    ],
    'generation-inputs': [],
    'credit-reservations': [
      {
        id: 20,
        accountId: 19,
        userId: 11,
        taskId: 17,
        reservationKey: 'generation:17',
        amountCredits: 0,
        status: 'reserved',
        isDeleted: false,
      },
    ],
    'credit-accounts': [
      { id: 19, userId: 11, availableCredits: 0, reservedCredits: 0, isDeleted: false },
    ],
    'credit-allocations': [],
    'credit-ledger': events,
  }
  const reader = createGenerationReader({
    find: async ({ collection }) => {
      assert.ok(Object.hasOwn(rows, collection))
      const docs = rows[collection]
      return { docs, totalDocs: docs.length }
    },
  })
  return assertTaskEvidence({ reader, snapshot, task })
}
test('singleCandidate checks only candidate cardinality without swallowing a second row', () => {
  const candidate = { isDeleted: true }
  assert.equal(singleCandidate({ candidates: [] }), null)
  assert.equal(singleCandidate({ candidates: [candidate] }), candidate)
  assert.throws(
    () => singleCandidate({ candidates: [candidate, { isDeleted: false }] }),
    (error) => error instanceof GenerationError && error.code === 'DATA_INTEGRITY_CONFLICT',
  )
})
for (const artifact of [
  { id: 1, isDeleted: true, userId: 11, sessionId: 12, outputIndex: 1 },
  { id: 1, isDeleted: false, userId: 99, sessionId: 12, outputIndex: 1 },
]) {
  test(`first naming artifact never skips broken first row ${JSON.stringify(artifact)}`, async () => {
    const calls = []
    const reader = createGenerationReader({
      find: async (query) => {
        calls.push(query)
        assert.equal(query.collection, 'artifacts')
        return {
          docs: [artifact, { id: 2, isDeleted: false, userId: 11, sessionId: 12, outputIndex: 1 }],
          totalDocs: 2,
        }
      },
    })
    await assert.rejects(
      () => readFirstNamingContext({ reader, session: { id: 12, userId: 11 } }),
      (error) =>
        error instanceof GenerationError &&
        error.code === (artifact.isDeleted ? 'NOT_FOUND' : 'DATA_INTEGRITY_CONFLICT'),
    )
    assert.equal(calls.length, 1)
    assert.equal(calls[0].limit, 1)
    assert.equal(calls[0].sort, 'id')
  })
}

test('current generation reader has no template-version lookup capability', () => {
  const reader = createGenerationReader({
    find: async () => {
      throw Error('unexpected IO')
    },
  })
  assert.equal(Object.hasOwn(reader, 'findVersionCandidates'), false)
})
