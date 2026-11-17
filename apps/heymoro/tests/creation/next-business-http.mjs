import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

import { observingHTTP, observeE2Leases, runE2Worker } from './next-http-fixture.mjs'
import { readJSON } from './next-http-e2-revision.mjs'

const digest = ({ value }) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const taskFields = [
  'clientRequestId',
  'costCredits',
  'errorCode',
  'id',
  'input',
  'roundNo',
  'sessionId',
  'sourceTaskId',
  'status',
  'templateId',
]
const stableTask = ({ task }) =>
  Object.fromEntries(
    taskFields
      .filter((key) => !['status', 'errorCode'].includes(key))
      .map((key) => [key, task[key]]),
  )
/** One JSON envelope/privacy contract for ordinary and concurrent actual HTTP replies. */
export function validateE2JSONResponse({ response, envelope }) {
  assert(envelope && typeof envelope === 'object' && !Array.isArray(envelope))
  assert.match(envelope.requestId, /^[a-f0-9-]{36}$/)
  assert.equal(response.headers.get('x-request-id'), envelope.requestId)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  if (response.status < 400) {
    assert.deepEqual(Object.keys(envelope).sort(), ['data', 'requestId'])
    assert(
      !/systemPrompt|payloadSecret|tokenHash|storageBackend|storageBucket|openId|apiKey/.test(
        JSON.stringify(envelope),
      ),
    )
    return envelope.data
  }
  assert.deepEqual(Object.keys(envelope).sort(), ['error', 'requestId'])
  assert(envelope.error && typeof envelope.error.code === 'string')
  return envelope.error
}

export function validateE2AdmissionResponse({ response, envelope, input }) {
  assert([200, 201].includes(response.status))
  const task = validateE2JSONResponse({ response, envelope })
  assert(task && typeof task === 'object' && !Array.isArray(task))
  assert.deepEqual(Object.keys(task).sort(), [...taskFields].sort())
  assert.deepEqual(task.input, input)
  return { status: response.status, task }
}

export function recordE2Assertion({ fixture, id, evidence }) {
  assert(!fixture.report.assertions[id], `Assertion recorded twice: ${id}`)
  fixture.report.assertions[id] = { passed: true, evidence }
}
export function engineEvents({ fixture }) {
  return readdirSync(fixture.e2.journalDirectory)
    .flatMap((filename) =>
      readFileSync(path.join(fixture.e2.journalDirectory, filename), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    )
    .filter((event) => ['image', 'naming'].includes(event.event))
}
export async function businessSnapshot({ fixture }) {
  const command = await runE2Worker({ fixture, role: 'snapshot' })
  return readJSON({
    filename: path.join(fixture.e2.snapshotDirectory, `snapshot-${command.commandId}.json`),
  })
}
const publicErrorCodes = new Set([
  'AUTH_DATA_INTEGRITY_CONFLICT',
  'AUTH_INPUT_INVALID',
  'AUTH_LOGIN_INCOMPLETE',
  'AUTH_PROVIDER_UNAVAILABLE',
  'AUTH_UNAUTHENTICATED',
  'AUTH_UNCONFIGURED',
  'COORDINATION_UNAVAILABLE',
  'CREDITS_INSUFFICIENT',
  'DATA_INTEGRITY_CONFLICT',
  'DESCRIPTION_REQUIRED',
  'GENERATION_IN_PROGRESS',
  'GENERATION_NOT_CONFIGURED',
  'HTTP_BODY_TOO_LARGE',
  'HTTP_REQUEST_TIMEOUT',
  'HTTP_UNSUPPORTED_MEDIA_TYPE',
  'IDEMPOTENCY_CONFLICT',
  'INPUT_INVALID',
  'INTERNAL_ERROR',
  'INVALID_MEDIA',
  'MEDIA_STORAGE_UNAVAILABLE',
  'NOT_FOUND',
  'NOT_READY',
  'OPERATION_OUTCOME_UNKNOWN',
  'QUOTE_CHANGED',
  'QUOTE_EXPIRED',
  'RESOURCE_BUSY',
  'SESSION_UNAVAILABLE',
  'TEMPLATE_UNAVAILABLE',
  'UNAUTHENTICATED',
])

/** Failure evidence is a closed projection, never a body or an exception transcript. */
async function recordHTTPFailure({ fixture, response, signal }) {
  const diagnostic = { status: response.status, requestId: null, code: null }
  fixture.report.httpTraces.push(diagnostic)
  if (
    response.status < 400 ||
    response.headers.get('content-type')?.split(';')[0].trim() !== 'application/json'
  ) {
    void response.body?.cancel().catch(() => {})
    return
  }
  const reader = response.body?.getReader()
  if (!reader) return
  const budget = 4096
  let onAbort
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(new Error('E2 failure diagnostic cancelled.'))
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    signal.throwIfAborted()
    const chunks = []
    let size = 0
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted])
      if (done) break
      size += value.byteLength
      if (size > budget) return
      chunks.push(value)
    }
    const envelope = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
    )
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return
    if (
      typeof envelope.requestId === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        envelope.requestId,
      ) &&
      response.headers.get('x-request-id') === envelope.requestId
    )
      diagnostic.requestId = envelope.requestId
    if (publicErrorCodes.has(envelope.error?.code)) diagnostic.code = envelope.error.code
  } catch {
    // Invalid/truncated/over-budget/cancelled diagnostic bodies retain only the actual status.
  } finally {
    signal.removeEventListener('abort', onAbort)
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

async function request({
  fixture,
  route,
  method = 'GET',
  body,
  token,
  status = 200,
  bytes = false,
}) {
  const cancellation = new AbortController()
  return observingHTTP({
    observer: () => observeE2Leases({ fixture }),
    cancel: () => cancellation.abort(),
    work: async () => {
      const signal = AbortSignal.any([AbortSignal.timeout(45_000), cancellation.signal])
      const multipart = body instanceof FormData
      const response = await fetch(`http://127.0.0.1:${fixture.port}/api/v1${route}`, {
        method,
        redirect: 'error',
        signal,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined && !multipart ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body === undefined ? {} : { body: multipart ? body : JSON.stringify(body) }),
      })
      if (response.status !== status) await recordHTTPFailure({ fixture, response, signal })
      assert.equal(
        response.status,
        status,
        `Actual HTTP ${method} ${route} failed; application failures are not retried.`,
      )
      if (status === 204) {
        assert.equal((await response.arrayBuffer()).byteLength, 0)
        return null
      }
      if (bytes) return Buffer.from(await response.arrayBuffer())
      const envelope = await response.json()
      const data = validateE2JSONResponse({ response, envelope })
      fixture.report.httpTraces.push({ route, method, status, requestId: envelope.requestId })
      return data
    },
  })
}
async function createSession({ fixture, token, template, key }) {
  const body = {
    clientRequestId: key,
    templateId: template.templateId,
  }
  const created = await request({
    fixture,
    token,
    route: '/creation-sessions',
    method: 'POST',
    body,
    status: 201,
  })
  const replay = await request({
    fixture,
    token,
    route: '/creation-sessions',
    method: 'POST',
    body,
  })
  assert.equal(created.id, replay.id)
  return created
}
async function upload({ fixture, token, bytes }) {
  const body = new FormData()
  body.append('file', new Blob([bytes], { type: 'image/png' }), 'e2-owned.png')
  const media = await request({
    fixture,
    token,
    route: '/media',
    method: 'POST',
    body,
    status: 201,
  })
  const returned = await request({
    fixture,
    token,
    route: `/media/${media.id}/content`,
    bytes: true,
  })
  assert.deepEqual(returned, bytes)
  return media.id
}
async function quote({ fixture, token, body }) {
  const before = await businessSnapshot({ fixture })
  const calls = engineEvents({ fixture }).length
  const result = await request({
    fixture,
    token,
    route: '/generation-quotes',
    method: 'POST',
    body,
  })
  const after = await businessSnapshot({ fixture })
  assert.equal(after.sha, before.sha, 'Quote wrote owned business data.')
  assert.equal(engineEvents({ fixture }).length, calls, 'Quote invoked a model.')
  return { result, snapshot: before.sha, engineCalls: calls }
}
export async function businessRoundOne({ fixture, dataset, pngs }) {
  const control = fixture.e2.control
  const login = await request({
    fixture,
    route: '/auth/wechat',
    method: 'POST',
    body: { code: fixture.e2.codes.owner },
    status: 201,
  })
  assert(login.user.id > 0 && login.token.length === 43)
  const token = login.token
  const me = await request({ fixture, token, route: '/me' })
  assert.equal(me.id, login.user.id)
  const account = await request({ fixture, token, route: '/creation-account' })
  assert.equal(account.available, 12)
  assert.equal(account.reserved, 0)
  const grants = await request({ fixture, token, route: '/credits/ledger' })
  assert.equal(grants.items.filter((item) => item.operation === 'grant').length, 1)
  recordE2Assertion({
    fixture,
    id: 'freshRestLogin',
    evidence: {
      userId: me.id,
      verificationId: control.verificationId,
      codeHash: digest({ value: fixture.e2.codes.owner }),
    },
  })
  recordE2Assertion({
    fixture,
    id: 'formalTrial',
    evidence: { available: account.available, ledgerSHA: digest({ value: grants }) },
  })
  const foreign = await request({
    fixture,
    route: '/auth/wechat',
    method: 'POST',
    body: { code: fixture.e2.codes.foreign },
    status: 201,
  })
  assert.notEqual(foreign.user.id, me.id)
  const catalog = await request({ fixture, route: '/templates' })
  const free = dataset.templates.find((template) => template.kind === 'free')
  const effect = dataset.templates.find((template) => template.kind === 'effect')
  assert(catalog.items.some((item) => item.templateId === effect.templateId))
  const preset = await request({ fixture, route: '/creation-presets/free' })
  assert.equal(preset.templateId, free.templateId)
  assert.equal(
    ['templateVersionId', 'versionNo', 'publishedVersionId'].some((field) =>
      Object.hasOwn(preset, field),
    ),
    false,
  )
  recordE2Assertion({
    fixture,
    id: 'catalogFreePreset',
    evidence: {
      freeId: free.templateId,
      effectId: effect.templateId,
      catalogSHA: digest({ value: catalog }),
    },
  })
  const effectSession = await createSession({
    fixture,
    token,
    template: effect,
    key: `e2-effect-${randomUUID()}`,
  })
  const freeSession = await createSession({
    fixture,
    token,
    template: free,
    key: `e2-free-${randomUUID()}`,
  })
  recordE2Assertion({
    fixture,
    id: 'sessionCreatedAndReplayed',
    evidence: { sessionIds: [effectSession.id, freeSession.id], statuses: [201, 200] },
  })
  const mediaIds = []
  for (const bytes of pngs) mediaIds.push(await upload({ fixture, token, bytes }))
  for (const mediaId of mediaIds)
    await request({
      fixture,
      token: foreign.token,
      route: `/media/${mediaId}/content`,
      status: 404,
    })
  recordE2Assertion({
    fixture,
    id: 'effectMultipartOwnership',
    evidence: {
      mediaIds,
      orderedByteHashes: pngs.map((bytes) => createHash('sha256').update(bytes).digest('hex')),
      foreignStatus: 404,
    },
  })
  const input = {
    inputMediaIds: [mediaIds[1], mediaIds[0]],
    description: '',
    userNotes: '  E2 ordered notes\n',
  }
  await request({
    fixture,
    token,
    route: `/creation-sessions/${effectSession.id}/draft`,
    method: 'PUT',
    body: { inputMediaIds: mediaIds, description: '', userNotes: 'first' },
  })
  await request({
    fixture,
    token,
    route: `/creation-sessions/${effectSession.id}/draft`,
    method: 'PUT',
    body: input,
  })
  const draft = await request({
    fixture,
    token,
    route: `/creation-sessions/${effectSession.id}/draft`,
  })
  assert.deepEqual(draft.input, input)
  recordE2Assertion({
    fixture,
    id: 'orderedDraftNotes',
    evidence: {
      sessionId: effectSession.id,
      inputSHA: digest({ value: draft.input }),
      orderedMediaIds: draft.input.inputMediaIds,
    },
  })
  const freeInput = { inputMediaIds: [], description: '  Original E2 free text\n', userNotes: '' }
  await request({
    fixture,
    token,
    route: `/creation-sessions/${freeSession.id}/draft`,
    method: 'PUT',
    body: freeInput,
  })
  assert.deepEqual(
    (await request({ fixture, token, route: `/creation-sessions/${freeSession.id}/draft` })).input,
    freeInput,
  )
  for (const bad of [
    { ...freeInput, description: ' ' },
    { ...freeInput, userNotes: 'forbidden' },
  ])
    await request({
      fixture,
      token,
      route: '/generation-quotes',
      method: 'POST',
      body: { sessionId: freeSession.id, input: bad },
      status: 400,
    })
  const freeQuote = await quote({
    fixture,
    token,
    body: { sessionId: freeSession.id, input: freeInput },
  })
  recordE2Assertion({
    fixture,
    id: 'freeTextRequiredNoNotes',
    evidence: {
      sessionId: freeSession.id,
      rawTextSHA: digest({ value: freeInput.description }),
      invalidStatuses: [400, 400],
      cost: freeQuote.result.costCredits,
    },
  })
  const quoted = await quote({ fixture, token, body: { sessionId: effectSession.id, input } })
  recordE2Assertion({
    fixture,
    id: 'quoteZeroBusinessWrites',
    evidence: { beforeSHA: quoted.snapshot, afterSHA: quoted.snapshot },
  })
  recordE2Assertion({
    fixture,
    id: 'quoteZeroEngine',
    evidence: { callsBefore: quoted.engineCalls, callsAfter: quoted.engineCalls },
  })
  const submission = {
    sessionId: effectSession.id,
    input,
    clientRequestId: `e2-admit-${randomUUID()}`,
    quoteToken: quoted.result.quoteToken,
  }
  const admissionBefore = await businessSnapshot({ fixture })
  const admissionEngineCalls = engineEvents({ fixture }).length
  // Accept either ordering, never retry either application response.
  const responses = await Promise.all(
    [201, 200].map(() => requestConcurrentAdmission({ fixture, token, body: submission })),
  )
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 201])
  assert.deepEqual(stableTask({ task: responses[0].task }), stableTask({ task: responses[1].task }))
  const task = responses[0].task
  const admitted = await businessSnapshot({ fixture })
  for (const table of ['generation_tasks', 'payload_jobs', 'credit_reservations'])
    assert.equal(admitted.counts[table], admissionBefore.counts[table] + 1)
  assert.equal(engineEvents({ fixture }).length, admissionEngineCalls)
  recordE2Assertion({
    fixture,
    id: 'concurrentSingleTask',
    evidence: {
      taskId: task.id,
      requestKeyHash: digest({ value: submission.clientRequestId }),
      statuses: [200, 201],
      taskCountBefore: admissionBefore.counts.generation_tasks,
      taskCountAfter: admitted.counts.generation_tasks,
    },
  })
  await runE2Worker({ fixture, role: 'jobs-1' })
  const done = await request({ fixture, token, route: `/generations/${task.id}` })
  assert.equal(done.status, 'succeeded')
  assert.deepEqual(stableTask({ task: done }), stableTask({ task }))
  const engines = engineEvents({ fixture })
  assert.equal(engines.filter((event) => event.event === 'image').length, 1)
  assert.equal(engines.filter((event) => event.event === 'naming').length, 1)
  recordE2Assertion({
    fixture,
    id: 'nativeCreationJobs',
    evidence: { taskId: task.id, status: done.status, imageCalls: 1 },
  })
  recordE2Assertion({
    fixture,
    id: 'nativeNamingJobs',
    evidence: { namingCalls: 1, sessionId: effectSession.id },
  })
  const history = await request({
    fixture,
    token,
    route: `/creation-sessions/${effectSession.id}/generations`,
  })
  assert.equal(history.items.find((item) => item.id === task.id).status, 'succeeded')
  const library = await request({ fixture, token, route: '/artifacts' })
  const artifact = library.items.find((item) => item.taskId === task.id)
  assert(artifact)
  assert(history.items.find((item) => item.id === task.id).artifactIds.includes(artifact.id))
  const output = await request({
    fixture,
    token,
    route: `/media/${artifact.mediaId}/content`,
    bytes: true,
  })
  const outputSHA = createHash('sha256').update(output).digest('hex')
  assert.equal(outputSHA, engines.find((event) => event.event === 'image').details.outputSHA)
  const favorite = await request({
    fixture,
    token,
    route: `/artifacts/${artifact.id}/favorite`,
    method: 'PUT',
  })
  assert.equal(favorite.isFavorite, true)
  const credits = await request({ fixture, token, route: '/creation-account' })
  assert.equal(credits.available, 10)
  assert.equal(credits.reserved, 0)
  recordE2Assertion({
    fixture,
    id: 'succeededHistoryLibraryMediaFavoriteCredits',
    evidence: {
      taskId: task.id,
      artifactId: artifact.id,
      mediaId: artifact.mediaId,
      outputSHA,
      available: credits.available,
      favorite: true,
    },
  })
  return {
    token,
    foreignToken: foreign.token,
    userId: me.id,
    effectSessionId: effectSession.id,
    input,
    draft,
    task,
    artifact,
    outputSHA,
    submission,
    quoteExpiry: quoted.result.validUntil,
    sessionExpiry: login.expiresAt,
  }
}
export async function requestConcurrentAdmission({ fixture, token, body }) {
  const cancellation = new AbortController()
  return observingHTTP({
    observer: () => observeE2Leases({ fixture }),
    cancel: () => cancellation.abort(),
    work: async () => {
      const signal = AbortSignal.any([cancellation.signal, AbortSignal.timeout(45_000)])
      const response = await fetch(`http://127.0.0.1:${fixture.port}/api/v1/generations`, {
        method: 'POST',
        redirect: 'error',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      })
      if (![200, 201].includes(response.status)) {
        await recordHTTPFailure({ fixture, response, signal })
        assert.fail('Actual HTTP POST /generations failed; application failures are not retried.')
      }
      const envelope = await response.json()
      const admission = validateE2AdmissionResponse({ response, envelope, input: body.input })
      fixture.report.httpTraces.push({
        route: '/generations',
        method: 'POST',
        status: response.status,
        requestId: envelope.requestId,
      })
      return admission
    },
  })
}
export async function businessRoundTwo({ fixture, state }) {
  const { token, task, artifact, submission, effectSessionId } = state
  assert(Date.parse(fixture.e2.control.rounds[1]) > Date.parse(state.quoteExpiry))
  assert(Date.parse(fixture.e2.control.rounds[1]) < Date.parse(state.sessionExpiry))
  const me = await request({ fixture, token, route: '/me' })
  assert.equal(me.id, state.userId)
  assert.deepEqual(
    (await request({ fixture, token, route: `/creation-sessions/${effectSessionId}/draft` })).input,
    state.input,
  )
  const history = await request({
    fixture,
    token,
    route: `/creation-sessions/${effectSessionId}/generations`,
  })
  assert(history.items.some((item) => item.id === task.id))
  const restoredArtifact = await request({ fixture, token, route: `/artifacts/${artifact.id}` })
  assert.equal(restoredArtifact.isFavorite, true)
  const bytes = await request({
    fixture,
    token,
    route: `/media/${artifact.mediaId}/content`,
    bytes: true,
  })
  assert.equal(createHash('sha256').update(bytes).digest('hex'), state.outputSHA)
  recordE2Assertion({
    fixture,
    id: 'coldRecovery',
    evidence: {
      userId: me.id,
      sessionId: effectSessionId,
      artifactId: artifact.id,
      outputSHA: state.outputSHA,
    },
  })
  const before = await businessSnapshot({ fixture })
  const callsBefore = engineEvents({ fixture }).length
  const replay = await request({
    fixture,
    token,
    route: '/generations',
    method: 'POST',
    body: submission,
  })
  assert.deepEqual(stableTask({ task: replay }), stableTask({ task }))
  assert.equal(replay.status, 'succeeded')
  const after = await businessSnapshot({ fixture })
  assert.equal(after.sha, before.sha)
  assert.equal(engineEvents({ fixture }).length, callsBefore)
  recordE2Assertion({
    fixture,
    id: 'expiredQuoteValidSession',
    evidence: {
      quoteExpiredAt: state.quoteExpiry,
      sessionExpiresAt: state.sessionExpiry,
      roundClock: fixture.e2.control.rounds[1],
      replayStatus: 200,
    },
  })
  recordE2Assertion({
    fixture,
    id: 'sameKeyReplayStable',
    evidence: {
      taskId: task.id,
      stableDTOHash: digest({ value: stableTask({ task: replay }) }),
      beforeSHA: before.sha,
      afterSHA: after.sha,
      engineCalls: callsBefore,
    },
  })
  const conflict = await request({
    fixture,
    token,
    route: '/generations',
    method: 'POST',
    body: { ...submission, input: { ...state.input, userNotes: 'changed' } },
    status: 409,
  })
  assert.equal(conflict.code, 'IDEMPOTENCY_CONFLICT')
  recordE2Assertion({
    fixture,
    id: 'changedInputConflict',
    evidence: { taskId: task.id, status: 409, code: conflict.code },
  })
  await request({
    fixture,
    token,
    route: `/creation-sessions/${effectSessionId}/draft`,
    method: 'PUT',
    body: { ...state.input, userNotes: 'new draft must not become source snapshot' },
  })
  const quoted = await quote({ fixture, token, body: { sourceArtifactId: artifact.id } })
  const regenerated = await request({
    fixture,
    token,
    route: `/artifacts/${artifact.id}/regenerations`,
    method: 'POST',
    body: {
      clientRequestId: `e2-regenerate-${randomUUID()}`,
      quoteToken: quoted.result.quoteToken,
    },
    status: 201,
  })
  assert.deepEqual(regenerated.input, state.input)
  assert.equal(regenerated.sourceTaskId, task.id)
  await runE2Worker({ fixture, role: 'jobs-2' })
  assert.equal(
    (await request({ fixture, token, route: `/generations/${regenerated.id}` })).status,
    'succeeded',
  )
  const regeneratedCredits = await request({ fixture, token, route: '/creation-account' })
  assert.equal(regeneratedCredits.available, 8)
  assert.equal(regeneratedCredits.reserved, 0)
  recordE2Assertion({
    fixture,
    id: 'regenerationSourceSnapshot',
    evidence: {
      sourceTaskId: task.id,
      regeneratedTaskId: regenerated.id,
      inputHash: digest({ value: regenerated.input }),
      draftNotUsed: true,
    },
  })
  for (const route of [
    `/artifacts/${artifact.id}`,
    `/generations/${task.id}`,
    `/creation-sessions/${effectSessionId}`,
    `/media/${artifact.mediaId}/content`,
  ])
    await request({ fixture, token: state.foreignToken, route, status: 404 })
  recordE2Assertion({
    fixture,
    id: 'foreignNotFound',
    evidence: { artifactId: artifact.id, statuses: [404, 404, 404, 404] },
  })
  await request({ fixture, token, route: '/auth/logout', method: 'POST', status: 204 })
  await request({ fixture, token, route: '/me', status: 401 })
  await request({ fixture, token, route: '/auth/logout', method: 'POST', status: 204 })
  recordE2Assertion({
    fixture,
    id: 'logoutIdempotent',
    evidence: { userId: state.userId, statuses: [204, 401, 204] },
  })
  assert(fixture.report.httpTraces.length > 30)
  recordE2Assertion({
    fixture,
    id: 'traceDTO',
    evidence: {
      requestCount: fixture.report.httpTraces.length,
      traceSHA: digest({ value: fixture.report.httpTraces }),
      taskDTOFields: taskFields,
    },
  })
}
