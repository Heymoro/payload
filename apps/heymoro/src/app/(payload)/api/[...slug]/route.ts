/* THIS FILE WAS GENERATED AUTOMATICALLY BY PAYLOAD. MODIFY AT YOUR OWN RISK. */
import config from '@payload-config'
import '@payloadcms/next/css'
import {
  REST_DELETE,
  REST_GET,
  REST_OPTIONS,
  REST_PATCH,
  REST_POST,
  REST_PUT,
} from '@payloadcms/next/routes'

import { wrapProductREST } from '../../../../creation/http/rest-route.js'

export const GET = wrapProductREST({ handler: REST_GET(config) })
export const POST = wrapProductREST({ handler: REST_POST(config) })
export const DELETE = wrapProductREST({ handler: REST_DELETE(config) })
export const PATCH = wrapProductREST({ handler: REST_PATCH(config) })
export const PUT = wrapProductREST({ handler: REST_PUT(config) })
export const OPTIONS = wrapProductREST({ handler: REST_OPTIONS(config) })
