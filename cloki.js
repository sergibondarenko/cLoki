#!/usr/bin/env node

/*
 * Loki API to Clickhouse Gateway
 * (C) 2018-2021 QXIP BV
 */

this.debug = process.env.DEBUG || false
// const debug = this.debug

this.readonly = process.env.READONLY || false
this.http_user = process.env.CLOKI_LOGIN || false
this.http_password = process.env.CLOKI_PASSWORD || false

require('./plugins/engine')

const path = require('path')
const DATABASE = require('./lib/db/clickhouse')
const UTILS = require('./lib/utils')

/* ProtoBuf Helper */
const fs = require('fs')
const protoBuff = require('protocol-buffers')
const messages = protoBuff(fs.readFileSync('lib/loki.proto'))

/* Fingerprinting */
this.fingerPrint = UTILS.fingerPrint
this.toJSON = UTILS.toJSON

/* Database this.bulk Helpers */
this.bulk = DATABASE.cache.bulk // samples
this.bulk_labels = DATABASE.cache.bulk_labels // labels
this.labels = DATABASE.cache.labels // in-memory labels

/* Function Helpers */
this.labelParser = UTILS.labelParser

const init = DATABASE.init
this.reloadFingerprints = DATABASE.reloadFingerprints
this.scanFingerprints = DATABASE.scanFingerprints
this.scanMetricFingerprints = DATABASE.scanMetricFingerprints
this.scanClickhouse = DATABASE.scanClickhouse

if (!this.readonly) init(process.env.CLICKHOUSE_DB || 'cloki')

/* Fastify Helper */
const fastify = require('fastify')({
  logger: false
})

fastify.register(require('fastify-url-data'))
fastify.register(require('fastify-websocket'))

fastify.register((instance, opts, next) => {
  instance.register(require('fastify-static'), {
    root: path.join(__dirname, './frontend/dist'), prefix: '/'
  })
  next()
})

fastify.after((err) => {
  if (err) throw err
})

/* Enable Simple Authentication */
if (this.http_user && this.http_password) {
  function checkAuth (username, password, req, reply, done) {
    if (username === this.http_user && password === this.http_password) {
      done()
    } else {
      done(new Error('Unauthorized!: Wrong username/password.'))
    }
  }
  const validate = checkAuth.bind(this)

  fastify.register(require('fastify-basic-auth'), {
    validate
  })
  fastify.after(() => {
    fastify.addHook('preHandler', fastify.basicAuth)
  })
}

fastify.addContentTypeParser('text/plain', {
  parseAs: 'string'
}, function (req, body, done) {
  try {
    const json = JSON.parse(body)
    done(null, json)
  } catch (err) {
    err.statusCode = 400
    done(err, undefined)
  }
})

try {
  const snappy = require('snappyjs')
  /* Protobuf Handler */
  fastify.addContentTypeParser('application/x-protobuf', { parseAs: 'buffer' },
    async function (req, body, done) {
      let _data = await snappy.uncompress(body)
      _data = messages.PushRequest.decode(_data)
      _data.streams = _data.streams.map(s => ({
        ...s,
        entries: s.entries.map(e => {
          const millis = Math.floor(e.timestamp.nanos / 1000000)
          return {
            ...e,
            timestamp: e.timestamp.seconds * 1000 + millis
          }
        })
      }))
      return _data.streams
    })
} catch (e) {
  console.log(e)
  console.log('Protobuf ingesting is unsupported')
}

fastify.addContentTypeParser('*', function (request, payload, done) {
  if (request.headers['content-type']) {
    done(payload)
    return
  }
  let data = ''
  payload.on('data', chunk => { data += chunk })
  payload.on('end', () => {
    done(null, data)
  })
})
fastify.addSchema({
  $id: 'http://cloki/alertRule.json',
  type: 'object',
  properties: {
    name: {
      type: 'string'
    },
    request: {
      type: 'string'
    },
    labels: {
      type: 'object',
      additionalProperties: {
        type: 'string'
      }
    }
  },
  required: ['name', 'request']
})
/* 404 Handler */
const handler404 = require('./lib/handlers/404.js').bind(this)
fastify.setNotFoundHandler(handler404)
fastify.setErrorHandler(require('./lib/handlers/errors').handler.bind(this))

/* Hello cloki test API */
const handlerHello = require('./lib/handlers/ready').bind(this)
fastify.get('/hello', handlerHello)
fastify.get('/ready', handlerHello)

/* Write Handler */
const handlerPush = require('./lib/handlers/push.js').bind(this)
fastify.post('/loki/api/v1/push', handlerPush)

/* Telegraf HTTP Bulk handler */
const handlerTelegraf = require('./lib/handlers/telegraf.js').bind(this)
fastify.post('/telegraf', handlerTelegraf)

/* Query Handler */
const handlerQueryRange = require('./lib/handlers/query_range.js').bind(this)
fastify.get('/loki/api/v1/query_range', handlerQueryRange)

/* Label Handlers */
/* Label Value Handler via query (test) */
const handlerQuery = require('./lib/handlers/query.js').bind(this)
fastify.get('/loki/api/v1/query', handlerQuery)

/* Label Handlers */
const handlerLabel = require('./lib/handlers/label.js').bind(this)
fastify.get('/loki/api/v1/label', handlerLabel)
fastify.get('/loki/api/v1/labels', handlerLabel)

/* Label Value Handler */
const handlerLabelValues = require('./lib/handlers/label_values.js').bind(this)
fastify.get('/loki/api/v1/label/:name/values', handlerLabelValues)

/* Series Placeholder - we do not track this as of yet */
const handlerSeries = require('./lib/handlers/series.js').bind(this)
fastify.get('/loki/api/v1/series', handlerSeries)

fastify.get('/loki/api/v1/tail', { websocket: true }, require('./lib/handlers/tail').bind(this))

fastify.get('/alerts', require('./lib/handlers/alterts'))
fastify.post('/alerts_data', require('./lib/handlers/alterts_data').bind(this))

fastify.post('/config/v1/alerts', {
  handler: require('./lib/handlers/alerts/post_rule').bind(this),
  schema: {
    body: {
      $ref: 'http://cloki/alertRule.json#'
    }
  }
})
fastify.get('/config/v1/alerts', require('./lib/handlers/alerts/get_rules').bind(this))
fastify.get('/config/v1/alerts/:name', require('./lib/handlers/alerts/get_rule').bind(this))
fastify.put('/config/v1/alerts/:name', {
  handler: require('./lib/handlers/alerts/put_rule').putAlert.bind(this),
  schema: {
    body: {
      $ref: 'http://cloki/alertRule.json#'
    }
  }
})
fastify.delete('/config/v1/alerts/:name', require('./lib/handlers/alerts/delete_rule').deleteAlert.bind(this))

fastify.register(require('fastify-serve-swagger-ui'), {
  // swagger specification which should be exposed
  specification: {
    type: 'file',
    path: 'cLoki_config_api.yaml'
  },
  // path under which swagger-ui will be available
  path: 'swagger'
})

// Run API Service
fastify.listen(
  process.env.PORT || 3100,
  process.env.HOST || '0.0.0.0',
  (err, address) => {
    if (err) throw err
    console.log('cLoki API up')
    fastify.log.info(`cloki API listening on ${address}`)
  }
)

module.exports.stop = () => {
  fastify.close()
  DATABASE.stop()
}
