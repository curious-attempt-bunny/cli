// @ts-check
import { createRequire } from 'module'
import { EOL } from 'os'
import { join } from 'path'
import process from 'process'
import rl from 'readline'

import { getBinaryPath } from '@netlify/routing-local-proxy'
import { execa } from 'execa'
import waitPort from 'wait-port'

import { getPathInProject } from '../lib/settings.js'
import { clearSpinner, startSpinner, stopSpinner } from '../lib/spinner.js'

import { NETLIFYDEVERR, NETLIFYDEVLOG, NETLIFYDEVWARN, log } from './command-helpers.js'
import { createDeferred } from './deferred.js'

const { resolve } = createRequire(import.meta.url)

const EDGE_HANDLERS_BUNDLER_CLI_PATH = join(resolve('@netlify/plugin-edge-handlers'), '..', 'cli.js')

export const startForwardProxy = async ({
  debug,
  frameworkPort,
  functionsPort,
  jwtRolesPath,
  jwtSecret,
  locationDb,
  port,
  publishDir,
}) => {
  const args = [
    'run',
    '--port',
    port,
    '--forward-proxy',
    `http://localhost:${frameworkPort}`,
    '--watch',
    publishDir,
    '--bundler',
    EDGE_HANDLERS_BUNDLER_CLI_PATH,
    '--log-file',
    getPathInProject(['logs', 'traffic-mesh.log']),
    '--progress',
  ]

  if (functionsPort) {
    args.push('--local-services-uri', `http://localhost:${functionsPort}`)
  }

  if (debug) {
    args.push('--debug')
  }

  if (locationDb) {
    args.push('--geo', locationDb)
  }

  if (jwtRolesPath) {
    args.push('--jwt-roles-path', jwtRolesPath)
  }

  if (jwtSecret) {
    args.push('--signature-secret', jwtSecret)
  }

  const { subprocess } = runProcess({ args })
  const { firstBundleReady, forwarder } = forwardMessagesToLog({ subprocess })

  subprocess.on('close', process.exit)
  subprocess.on('SIGINT', process.exit)
  subprocess.on('SIGTERM', process.exit)
  ;['SIGINT', 'SIGTERM', 'SIGQUIT', 'SIGHUP', 'exit'].forEach((signal) => {
    process.on(signal, () => {
      forwarder.close()

      const sig = signal === 'exit' ? 'SIGTERM' : signal
      subprocess.kill(sig, {
        forceKillAfterTimeout: PROXY_EXIT_TIMEOUT,
      })
    })
  })

  // Wait until the first traffic-mesh bundle is ready
  //
  // In case of errors, this delays the startup process until the errors are fixed
  await firstBundleReady

  try {
    const open = await waitPort({ port, output: 'silent', timeout: PROXY_READY_TIMEOUT })
    if (!open) {
      throw new Error(`Timed out waiting for forward proxy to be ready on port '${port}'`)
    }
    return `http://localhost:${port}`
  } catch (error) {
    log(`${NETLIFYDEVERR}`, error)
  }
}

const forwardMessagesToLog = ({ subprocess }) => {
  const { promise: firstBundleReady, reject: firstBundleReject, resolve: firstBundleResolve } = createDeferred()

  let currentId = null
  let lastError = null
  let lastWasSuccess = false
  let spinner = null

  const reset = () => {
    currentId = null
    spinner = null
  }

  const forwarder = rl.createInterface({
    input: subprocess.stderr,
  })

  forwarder
    .on('line', (line) => {
      let data
      try {
        data = JSON.parse(line.trim())
      } catch (error) {
        log(`${NETLIFYDEVERR} Cannot parse log line as JSON: ${line.trim()}${EOL}${EOL}${error}`)
        return
      }

      const { error, id, type } = data
      switch (type) {
        case 'bundle:start':
          currentId = id
          if (!spinner) {
            spinner = startSpinner({ text: 'Processing request remaps, header rules and Edge Handlers...' })
          }
          break

        case 'bundle:success':
          if (currentId !== id) {
            return
          }

          // Clear spinner if there already is a log line indicating success above,
          // instead of appending another line of "Yay, your project was bundled!"
          if (lastWasSuccess) {
            clearSpinner({ spinner })
          } else {
            stopSpinner({
              spinner,
              error: false,
              text: 'Done processing request remaps, header rules and Edge Handlers',
            })
          }
          lastWasSuccess = true
          lastError = null

          firstBundleResolve()
          reset()
          break

        case 'bundle:fail': {
          if (currentId !== id) {
            return
          }

          // Only show the error if it's new
          const errorMsg = (error && error.msg) || 'Failed processing request remaps, header rules or Edge Handlers'
          if (errorMsg === lastError) {
            clearSpinner({ spinner })
          } else {
            stopSpinner({
              spinner,
              error: true,
              text: errorMsg,
            })
            log(
              `${NETLIFYDEVLOG} Change any project configuration file (netlify.toml, _headers, _redirects) or any Edge Handlers file to trigger a re-bundle`,
            )
          }

          lastWasSuccess = false
          lastError = errorMsg
          reset()
          break
        }

        default:
          log(`${NETLIFYDEVWARN} Unknown routing-local-proxy event '${type}'`)
          break
      }
    })
    .on('close', () => {
      if (spinner) {
        // Hide the spinner
        spinner.stop()
      }

      reset()
    })
    .on('error', (err) => {
      stopSpinner({
        spinner,
        error: true,
        text: `${NETLIFYDEVERR} An error occurred while bundling processing the messages from routing-local-proxy: ${err}`,
      })

      firstBundleReject(err)
      reset()
    })

  return { forwarder, firstBundleReady }
}

// 30 seconds
const PROXY_READY_TIMEOUT = 3e4
// 2 seconds
const PROXY_EXIT_TIMEOUT = 2e3

export const runProcess = ({ args }) => {
  const subprocess = execa(getBinaryPath(), args, { stdio: ['inherit', 'inherit', 'pipe'] })
  return { subprocess }
}
