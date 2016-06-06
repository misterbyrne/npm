var mkdir = require('mkdirp')
var assert = require('assert')
var log = require('npmlog')
var path = require('path')
var crypto = require('crypto')
var retry = require('retry')
var writeStreamAtomic = require('fs-write-stream-atomic')
var PassThrough = require('readable-stream').PassThrough
var npm = require('../npm.js')
var inflight = require('inflight')
var addLocalTarball = require('./add-local-tarball.js')
var cacheFile = require('npm-cache-filename')
var rimraf = require('rimraf')
var pulseTillDone = require('../utils/pulse-till-done.js')

module.exports = addRemoteTarball

function addRemoteTarball (u, pkgData, shasum, auth, cb_) {
  assert(typeof u === 'string', 'must have module URL')
  assert(typeof cb_ === 'function', 'must have callback')

  function cb (er, data) {
    if (data) {
      data._from = u
      data._resolved = u
      data._shasum = data._shasum || shasum
    }
    cb_(er, data)
  }

  cb_ = inflight(u, cb_)
  if (!cb_) return log.verbose('addRemoteTarball', u, 'already in flight; waiting')
  log.verbose('addRemoteTarball', u, 'not in flight; adding')

  // XXX Fetch direct to cache location, store tarballs under
  // ${cache}/registry.npmjs.org/pkg/-/pkg-1.2.3.tgz
  var tmp = cacheFile(npm.tmp, u)

  function next (er, resp, shasum) {
    if (er) return cb(er)
    addLocalTarball(tmp, pkgData, shasum, cleanup)
  }
  function cleanup (er, data) {
    if (er) return cb(er)
    rimraf(tmp, function () {
      cb(er, data)
    })
  }

  log.verbose('addRemoteTarball', [u, shasum])
  mkdir(path.dirname(tmp), function (er) {
    if (er) return cb(er)
    addRemoteTarball_(u, tmp, shasum, auth, next)
  })
}

function addRemoteTarball_ (u, tmp, shasum, auth, cb) {
  // Tuned to spread 3 attempts over about a minute.
  // See formula at <https://github.com/tim-kos/node-retry>.
  var operation = retry.operation({
    retries: npm.config.get('fetch-retries'),
    factor: npm.config.get('fetch-retry-factor'),
    minTimeout: npm.config.get('fetch-retry-mintimeout'),
    maxTimeout: npm.config.get('fetch-retry-maxtimeout')
  })

  operation.attempt(function (currentAttempt) {
    log.info(
      'retry',
      'fetch attempt', currentAttempt,
      'at', (new Date()).toLocaleTimeString()
    )
    fetchAndShaCheck(u, tmp, shasum, auth, function (er, response, shasum) {
      // Only retry on 408, 5xx or no `response`.
      var sc = response && response.statusCode
      var statusRetry = !sc || (sc === 408 || sc >= 500)
      if (er && statusRetry && operation.retry(er)) {
        log.warn('retry', 'will retry, error on last attempt: ' + er)
        return
      }
      cb(er, response, shasum)
    })
  })
}

function fetchAndShaCheck (u, tmp, shasum, auth, cb) {
  cb = pulseTillDone('fetchTarball', cb)
  npm.registry.fetch(u, { auth: auth }, function (er, response) {
    if (er) {
      log.error('fetch failed', u)
      return cb(er, response)
    }

    var tarball = writeStreamAtomic(tmp, { mode: npm.modes.file })
    tarball.on('error', function (er) {
      cb(er)
      tarball.destroy()
    })

    var sha = crypto.createHash('sha1')

    response.on('data', function (data) {
      sha.update(data)
    })

    tarball.on('finish', function () {
      var actualShaSum = sha.digest('hex')
      log.silly('fetchAndShaCheck', 'shasum', actualShaSum)

      if (shasum && shasum !== actualShaSum) {
        return cb(new Error(
          'shasum check failed for ' + tmp + '\n' +
          'Expected: ' + shasum + '\n' +
          'Actual:   ' + actualShaSum + '\n' +
          'From:     ' + u))
      }
      return cb(er, response, actualShaSum)
    })

    // 0.8 http streams have a bug, where if they're paused with data in
    // their buffers when the socket closes, they call `end` before emptying
    // those buffers, which results in the entire pipeline ending and thus
    // the point that applied backpressure never being able to trigger a
    // `resume`.
    // We work around this by piping into a pass through stream that has
    // unlimited buffering. The pass through stream is from readable-stream
    // and is thus a current streams3 implementation that is free of these
    // bugs even on 0.8.
    response.pipe(PassThrough({highWaterMark: Infinity})).pipe(tarball)
  })
}
