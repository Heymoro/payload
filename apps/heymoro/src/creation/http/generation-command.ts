import type { CreationInput } from '../domain/input.js'

import { GenerationError } from '../domain/generation.js'
import { normalizeCreationInput } from '../domain/input.js'
import { libraryInput, requestId } from '../domain/library.js'

type GenerateCommand = Readonly<{ input: CreationInput; sessionId: number }>
type SubmissionCommand = Readonly<{ clientRequestId: string; quoteToken: string }>
type QuoteCommand =
  | (GenerateCommand & Readonly<{ operation: 'generate' }>)
  | Readonly<{ operation: 'regenerate'; sourceArtifactId: number }>

export function parseGenerationQuote({ value }: { value: unknown }): QuoteCommand {
  const command = libraryInput({ fields: ['sessionId', 'input', 'sourceArtifactId'], value })
  if (Object.hasOwn(command, 'sourceArtifactId')) {
    libraryInput({ fields: ['sourceArtifactId'], value: command })
    return {
      operation: 'regenerate',
      sourceArtifactId: requestId({ value: command.sourceArtifactId }),
    }
  }
  return {
    input: normalizeCreationInput({ value: command.input }),
    operation: 'generate',
    sessionId: requestId({ value: command.sessionId }),
  }
}

export function parseGenerationSubmission(args: {
  operation: 'generate'
  value: unknown
}): GenerateCommand & SubmissionCommand
export function parseGenerationSubmission(args: {
  operation: 'regenerate'
  value: unknown
}): SubmissionCommand
export function parseGenerationSubmission({
  operation,
  value,
}: {
  operation: 'generate' | 'regenerate'
  value: unknown
}): (GenerateCommand & SubmissionCommand) | SubmissionCommand {
  const command = libraryInput({
    fields:
      operation === 'generate'
        ? ['sessionId', 'input', 'clientRequestId', 'quoteToken']
        : ['clientRequestId', 'quoteToken'],
    value,
  })
  if (
    typeof command.clientRequestId !== 'string' ||
    !command.clientRequestId.trim() ||
    command.clientRequestId.length > 128 ||
    typeof command.quoteToken !== 'string'
  ) {
    throw new GenerationError({ code: 'INPUT_INVALID' })
  }
  const submission = {
    clientRequestId: command.clientRequestId,
    quoteToken: command.quoteToken,
  }
  return operation === 'generate'
    ? {
        ...submission,
        input: normalizeCreationInput({ value: command.input }),
        sessionId: requestId({ value: command.sessionId }),
      }
    : submission
}
