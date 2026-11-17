import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

const domain = () => import('../src/creation/domain/input.ts')
const effectLimits = Object.freeze({
  minImages: 1,
  maxImages: 3,
  maxDescriptionLength: 12,
  maxNotesLength: 5,
})
const freeLimits = Object.freeze({ ...effectLimits, minImages: 0 })
const digest = (value) => createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')

const invalid = ({ run, CreationInputError, code = 'INPUT_INVALID' }) => {
  assert.throws(run, (error) => error instanceof CreationInputError && error.code === code)
}

test('should supply omitted fields in canonical key order', async () => {
  const { normalizeCreationInput } = await domain()

  assert.deepEqual(normalizeCreationInput({ value: {} }), {
    inputMediaIds: [],
    description: '',
    userNotes: '',
  })
  const input = normalizeCreationInput({
    value: Object.assign(Object.create(null), {
      userNotes: 'x',
      description: 'y',
      inputMediaIds: [9, 2],
    }),
  })

  assert.deepEqual(Object.keys(input), ['inputMediaIds', 'description', 'userNotes'])
  assert.deepEqual(input.inputMediaIds, [9, 2])
})

test('should copy and freeze input without freezing or mutating the caller', async () => {
  const { normalizeCreationInput } = await domain()
  const value = {
    inputMediaIds: [4, 2],
    description: '  雪\r\ne\u0301 🐈  ',
    userNotes: '\t原文\n',
  }
  const input = normalizeCreationInput({ value })

  assert.notEqual(input, value)
  assert.notEqual(input.inputMediaIds, value.inputMediaIds)
  assert.ok(Object.isFrozen(input))
  assert.ok(Object.isFrozen(input.inputMediaIds))
  assert.equal(Object.isFrozen(value), false)
  assert.equal(Object.isFrozen(value.inputMediaIds), false)
  assert.equal(input.description, value.description)
  assert.equal(input.userNotes, value.userNotes)
  assert.throws(() => {
    input.description = 'changed'
  }, TypeError)
  assert.throws(() => input.inputMediaIds.push(8), TypeError)
  value.inputMediaIds.reverse()
  value.description = 'changed'
  assert.deepEqual(input.inputMediaIds, [4, 2])
  assert.equal(input.description, '  雪\r\ne\u0301 🐈  ')
})

test('should reject non-JSON objects, extra fields, and explicitly absent or mistyped fields', async () => {
  const { normalizeCreationInput, CreationInputError } = await domain()
  const values = [
    null,
    undefined,
    [],
    'text',
    1,
    true,
    new Date(),
    new (class Input {})(),
    Object.create({ description: 'inherited' }),
    { extra: 1 },
    { [Symbol('extra')]: 1 },
  ]

  for (const field of ['inputMediaIds', 'description', 'userNotes']) {
    for (const value of [null, undefined, 0, false, {}]) values.push({ [field]: value })
  }
  values.push({ inputMediaIds: '1' }, { description: [] }, { userNotes: [] })
  values.push(Object.defineProperty({}, 'description', { get: () => 'hidden', enumerable: true }))
  values.push(Object.defineProperty({}, 'description', { value: 'hidden' }))
  for (const value of values)
    invalid({ run: () => normalizeCreationInput({ value }), CreationInputError })
})

test('should accept only unique ordered positive safe integer media IDs', async () => {
  const { normalizeCreationInput, CreationInputError } = await domain()

  assert.deepEqual(
    normalizeCreationInput({ value: { inputMediaIds: [Number.MAX_SAFE_INTEGER, 1] } })
      .inputMediaIds,
    [Number.MAX_SAFE_INTEGER, 1],
  )
  for (const inputMediaIds of [
    [1, 1],
    ['1'],
    [0],
    [-1],
    [1.5],
    [NaN],
    [Infinity],
    [Number.MAX_SAFE_INTEGER + 1],
    [null],
    [undefined],
    Array(1),
    [1, , 2],
  ]) {
    invalid({ run: () => normalizeCreationInput({ value: { inputMediaIds } }), CreationInputError })
  }
})

test('should let drafts remain incomplete in both modes', async () => {
  const { validateCreationInput } = await domain()

  for (const [mode, limits] of [
    ['effect', effectLimits],
    ['free', freeLimits],
  ]) {
    const input = validateCreationInput({ input: {}, mode, stage: 'draft', limits })

    assert.deepEqual(input, { inputMediaIds: [], description: '', userNotes: '' })
    assert.ok(Object.isFrozen(input))
    assert.ok(Object.isFrozen(input.inputMediaIds))
  }
})

test('should enforce mode-exclusive fields even for drafts without trimming them', async () => {
  const { validateCreationInput, CreationInputError } = await domain()

  for (const stage of ['draft', 'quote', 'submit']) {
    for (const text of ['x', ' ', '\n']) {
      invalid({
        run: () =>
          validateCreationInput({
            input: { inputMediaIds: [1], description: text },
            mode: 'effect',
            stage,
            limits: effectLimits,
          }),
        CreationInputError,
      })
      invalid({
        run: () =>
          validateCreationInput({
            input: { description: 'x', userNotes: text },
            mode: 'free',
            stage,
            limits: freeLimits,
          }),
        CreationInputError,
      })
    }
  }
})

test('should require the configured effect image minimum only at quote and submit', async () => {
  const { validateCreationInput, CreationInputError } = await domain()
  const limits = { ...effectLimits, minImages: 2 }

  assert.doesNotThrow(() =>
    validateCreationInput({
      input: { inputMediaIds: [1] },
      mode: 'effect',
      stage: 'draft',
      limits,
    }),
  )
  for (const stage of ['quote', 'submit']) {
    for (const inputMediaIds of [[], [1]])
      invalid({
        run: () =>
          validateCreationInput({ input: { inputMediaIds }, mode: 'effect', stage, limits }),
        CreationInputError,
      })
    const input = validateCreationInput({
      input: { inputMediaIds: [2, 1], userNotes: '备注' },
      mode: 'effect',
      stage,
      limits,
    })

    assert.deepEqual(input, { inputMediaIds: [2, 1], description: '', userNotes: '备注' })
    assert.doesNotThrow(() =>
      validateCreationInput({ input: { inputMediaIds: [1, 2] }, mode: 'effect', stage, limits }),
    )
  }
})

test('should require free description at quote and submit while permitting zero images', async () => {
  const { validateCreationInput, CreationInputError } = await domain()

  for (const stage of ['quote', 'submit']) {
    for (const description of ['', ' \t\r\n', '\u3000'])
      invalid({
        run: () =>
          validateCreationInput({
            input: { description },
            mode: 'free',
            stage,
            limits: freeLimits,
          }),
        CreationInputError,
        code: 'DESCRIPTION_REQUIRED',
      })
    const input = validateCreationInput({
      input: { description: ' \n雪\n ' },
      mode: 'free',
      stage,
      limits: freeLimits,
    })

    assert.equal(input.description, ' \n雪\n ')
    assert.deepEqual(input.inputMediaIds, [])
  }
})

test('should enforce configured upper bounds including during draft saves', async () => {
  const { validateCreationInput, CreationInputError } = await domain()

  for (const stage of ['draft', 'quote', 'submit']) {
    assert.doesNotThrow(() =>
      validateCreationInput({
        input: { inputMediaIds: [1, 2, 3], userNotes: '12345' },
        mode: 'effect',
        stage,
        limits: effectLimits,
      }),
    )
    invalid({
      run: () =>
        validateCreationInput({
          input: { inputMediaIds: [1, 2, 3, 4] },
          mode: 'effect',
          stage,
          limits: effectLimits,
        }),
      CreationInputError,
    })
    invalid({
      run: () =>
        validateCreationInput({
          input: { inputMediaIds: [1], userNotes: '123456' },
          mode: 'effect',
          stage,
          limits: effectLimits,
        }),
      CreationInputError,
    })
    assert.doesNotThrow(() =>
      validateCreationInput({
        input: { description: '123456789012' },
        mode: 'free',
        stage,
        limits: freeLimits,
      }),
    )
    invalid({
      run: () =>
        validateCreationInput({
          input: { description: '1234567890123' },
          mode: 'free',
          stage,
          limits: freeLimits,
        }),
      CreationInputError,
    })
    invalid({
      run: () =>
        validateCreationInput({
          input: { description: null },
          mode: 'free',
          stage,
          limits: freeLimits,
        }),
      CreationInputError,
    })
  }
})

test('should use server limits rather than legacy image or text constants', async () => {
  const { validateCreationInput } = await domain()
  const input = {
    inputMediaIds: Array.from({ length: 9 }, (_, index) => index + 1),
    description: 'x'.repeat(2001),
  }
  const limits = { minImages: 0, maxImages: 9, maxDescriptionLength: 2001, maxNotesLength: 0 }

  assert.deepEqual(validateCreationInput({ input, mode: 'free', stage: 'submit', limits }), {
    ...input,
    userNotes: '',
  })
})

test('should reject unknown modes and validation stages', async () => {
  const { validateCreationInput, CreationInputError } = await domain()

  for (const mode of [undefined, null, 'other', 'toString', 1])
    invalid({
      run: () => validateCreationInput({ input: {}, mode, stage: 'draft', limits: freeLimits }),
      CreationInputError,
    })
  for (const stage of [undefined, null, 'other', 'toString', 1])
    invalid({
      run: () => validateCreationInput({ input: {}, mode: 'free', stage, limits: freeLimits }),
      CreationInputError,
    })
})

test('should reject missing, malformed, or mode-inconsistent server limits', async () => {
  const { validateCreationInput } = await domain()
  const limitsCases = [
    undefined,
    null,
    [],
    {},
    { ...freeLimits, extra: 1 },
    { ...freeLimits, minImages: 1 },
    { ...freeLimits, maxImages: -1 },
  ]

  for (const field of Object.keys(freeLimits)) {
    for (const value of [undefined, null, '3', -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])
      limitsCases.push({ ...freeLimits, [field]: value })
    const missing = { ...freeLimits }

    delete missing[field]
    limitsCases.push(missing)
  }
  for (const limits of limitsCases)
    assert.throws(
      () => validateCreationInput({ input: {}, mode: 'free', stage: 'draft', limits }),
      RangeError,
    )
  for (const limits of [
    { ...effectLimits, minImages: 0 },
    { ...effectLimits, minImages: 4 },
  ])
    assert.throws(
      () => validateCreationInput({ input: {}, mode: 'effect', stage: 'draft', limits }),
      RangeError,
    )
  assert.doesNotThrow(() =>
    validateCreationInput({
      input: {},
      mode: 'free',
      stage: 'draft',
      limits: { minImages: 0, maxImages: 0, maxDescriptionLength: 0, maxNotesLength: 0 },
    }),
  )
})

test('should hash canonical UTF-8 input and apply the same structural validation', async () => {
  const { hashCreationInput, CreationInputError } = await domain()
  const input = { userNotes: '\t', description: ' 雪\r\ne\u0301 ', inputMediaIds: [9, 2] }
  const hash = hashCreationInput({ input })

  assert.match(hash, /^[a-f0-9]{64}$/)
  assert.equal(
    hash,
    digest({ inputMediaIds: [9, 2], description: input.description, userNotes: '\t' }),
  )
  assert.equal(
    hash,
    hashCreationInput({
      input: { inputMediaIds: [9, 2], description: input.description, userNotes: '\t' },
    }),
  )
  assert.equal(
    hashCreationInput({ input: {} }),
    hashCreationInput({ input: { userNotes: '', description: '', inputMediaIds: [] } }),
  )
  invalid({ run: () => hashCreationInput({ input: { unknown: true } }), CreationInputError })
})

test('should bind image order, exact whitespace, newlines, Unicode and notes in input hashes', async () => {
  const { hashCreationInput } = await domain()
  const input = { inputMediaIds: [9, 2], description: ' e\u0301\r\n', userNotes: 'x' }
  const hash = hashCreationInput({ input })

  for (const change of [
    { inputMediaIds: [2, 9] },
    { description: 'e\u0301\r\n' },
    { description: ' e\u0301\n' },
    { description: ' é\r\n' },
    { userNotes: 'x ' },
  ])
    assert.notEqual(hash, hashCreationInput({ input: { ...input, ...change } }))
})

test('should create canonical immutable generate client input with a deeply copied input', async () => {
  const { normalizeTaskClientInput } = await domain()
  const value = {
    input: { userNotes: 'x', inputMediaIds: [3, 2] },
    sessionId: 7,
    operation: 'generate',
  }
  const clientInput = normalizeTaskClientInput({ value })

  assert.deepEqual(clientInput, {
    operation: 'generate',
    sessionId: 7,
    input: { inputMediaIds: [3, 2], description: '', userNotes: 'x' },
  })
  assert.deepEqual(Object.keys(clientInput), ['operation', 'sessionId', 'input'])
  assert.deepEqual(Object.keys(clientInput.input), ['inputMediaIds', 'description', 'userNotes'])
  for (const nested of [clientInput, clientInput.input, clientInput.input.inputMediaIds])
    assert.ok(Object.isFrozen(nested))
  assert.notEqual(clientInput, value)
  assert.notEqual(clientInput.input, value.input)
  assert.notEqual(clientInput.input.inputMediaIds, value.input.inputMediaIds)
  for (const nested of [value, value.input, value.input.inputMediaIds])
    assert.equal(Object.isFrozen(nested), false)
  value.input.inputMediaIds.push(8)
  assert.deepEqual(clientInput.input.inputMediaIds, [3, 2])
})

test('should create a canonical immutable regenerate client input', async () => {
  const { normalizeTaskClientInput } = await domain()
  const value = Object.assign(Object.create(null), {
    sourceArtifactId: 8,
    sessionId: 7,
    operation: 'regenerate',
  })
  const clientInput = normalizeTaskClientInput({ value })

  assert.deepEqual(clientInput, { operation: 'regenerate', sessionId: 7, sourceArtifactId: 8 })
  assert.deepEqual(Object.keys(clientInput), ['operation', 'sessionId', 'sourceArtifactId'])
  assert.notEqual(clientInput, value)
  assert.ok(Object.isFrozen(clientInput))
  assert.equal(Object.isFrozen(value), false)
})

test('should reject invalid operations, IDs, mixed purposes and unknown task fields', async () => {
  const { normalizeTaskClientInput, CreationInputError } = await domain()
  const generate = { operation: 'generate', sessionId: 7, input: {} }
  const regenerate = { operation: 'regenerate', sessionId: 7, sourceArtifactId: 8 }
  const values = [
    null,
    undefined,
    [],
    {},
    { ...generate, operation: 'other' },
    { ...generate, operation: undefined },
    { ...generate, sourceArtifactId: 8 },
    { ...regenerate, input: {} },
    { ...generate, extra: true },
    { ...generate, input: { extra: true } },
    { operation: 'generate', sessionId: 7 },
    { operation: 'regenerate', sessionId: 7 },
  ]

  for (const id of [null, undefined, '7', 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    values.push({ ...generate, sessionId: id }, { ...regenerate, sourceArtifactId: id })
  for (const input of [null, undefined, [], 'text']) values.push({ ...generate, input })
  for (const value of values)
    invalid({ run: () => normalizeTaskClientInput({ value }), CreationInputError })
  assert.doesNotThrow(() =>
    normalizeTaskClientInput({
      value: {
        ...regenerate,
        sessionId: Number.MAX_SAFE_INTEGER,
        sourceArtifactId: Number.MAX_SAFE_INTEGER,
      },
    }),
  )
})

test('should hash complete canonical task content separately from input content', async () => {
  const { hashCreationInput, hashTaskClientInput } = await domain()
  const clientInput = { input: { description: ' 雪\n' }, sessionId: 7, operation: 'generate' }
  const hash = hashTaskClientInput({ clientInput })

  assert.equal(
    hash,
    digest({
      operation: 'generate',
      sessionId: 7,
      input: { inputMediaIds: [], description: ' 雪\n', userNotes: '' },
    }),
  )
  assert.match(hash, /^[a-f0-9]{64}$/)
  assert.notEqual(hash, hashCreationInput({ input: clientInput.input }))
  assert.equal(
    hash,
    hashTaskClientInput({
      clientInput: {
        operation: 'generate',
        sessionId: 7,
        input: { userNotes: '', description: ' 雪\n', inputMediaIds: [] },
      },
    }),
  )
  for (const change of [
    { sessionId: 8 },
    { input: { description: '雪\n' } },
    { input: { description: ' 雪\n', inputMediaIds: [1] } },
  ])
    assert.notEqual(hash, hashTaskClientInput({ clientInput: { ...clientInput, ...change } }))
  const regenerate = { operation: 'regenerate', sessionId: 7, sourceArtifactId: 8 }
  const regenerateHash = hashTaskClientInput({ clientInput: regenerate })

  assert.equal(regenerateHash, digest(regenerate))
  assert.equal(
    regenerateHash,
    hashTaskClientInput({
      clientInput: { sourceArtifactId: 8, sessionId: 7, operation: 'regenerate' },
    }),
  )
  assert.notEqual(hash, regenerateHash)
  for (const change of [{ sessionId: 8 }, { sourceArtifactId: 9 }])
    assert.notEqual(
      regenerateHash,
      hashTaskClientInput({ clientInput: { ...regenerate, ...change } }),
    )
})

test('should exclude request metadata at extraction and reject it inside client input', async () => {
  const { normalizeTaskClientInput, hashTaskClientInput, CreationInputError } = await domain()
  const content = { operation: 'generate', sessionId: 7, input: { description: '雪' } }
  const extract = ({ operation, sessionId, input }) => ({ operation, sessionId, input })
  const first = {
    ...content,
    quoteToken: 'quote-1',
    bearer: 'bearer-1',
    clientRequestId: 'request-1',
  }
  const second = {
    ...content,
    quoteToken: 'quote-2',
    bearer: 'bearer-2',
    clientRequestId: 'request-2',
  }

  assert.equal(
    hashTaskClientInput({ clientInput: extract(first) }),
    hashTaskClientInput({ clientInput: extract(second) }),
  )
  for (const field of ['quoteToken', 'bearer', 'clientRequestId']) {
    for (const operation of [
      content,
      { operation: 'regenerate', sessionId: 7, sourceArtifactId: 8 },
    ]) {
      const clientInput = { ...operation, [field]: first[field] }

      invalid({ run: () => normalizeTaskClientInput({ value: clientInput }), CreationInputError })
      invalid({ run: () => hashTaskClientInput({ clientInput }), CreationInputError })
    }
  }
})
