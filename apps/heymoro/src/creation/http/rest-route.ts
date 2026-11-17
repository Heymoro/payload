import { createRequestId } from '../domain/request-id.js'
import { businessErrorResponse } from './business-errors.js'
import { HttpRequestError } from './request.js'

export type ProductRESTArguments = { params: Promise<{ slug?: string[] }> }
export type ProductRESTHandler = (request: Request, args: ProductRESTArguments) => Promise<Response>

/** Guard decoded Native route params before Payload can parse an overridden POST body. */
export function wrapProductREST({ handler }: { handler: ProductRESTHandler }): ProductRESTHandler {
  return async (request, args) => {
    const params = await args.params
    if (
      params.slug?.[0] === 'v1' &&
      (request.headers.has('x-payload-http-method-override') ||
        request.headers.has('x-http-method-override'))
    ) {
      return businessErrorResponse({
        error: new HttpRequestError({ code: 'INPUT_INVALID' }),
        requestId: createRequestId(),
      })
    }
    return handler(request, { params: Promise.resolve(params) })
  }
}
