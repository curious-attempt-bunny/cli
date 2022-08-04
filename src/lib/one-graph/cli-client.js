// @ts-check
/* eslint-disable eslint-comments/disable-enable-pair */
/* eslint-disable fp/no-loops */
const crypto = require('crypto')
const os = require('os')
const path = require('path')
const process = require('process')

const gitRepoInfo = require('git-repo-info')
// eslint-disable-next-line no-unused-vars
const { CliEventHelper, GraphQL, InternalConsole, OneGraphClient } = require('netlify-onegraph-internal')
const { NetlifyGraph } = require('netlify-onegraph-internal')

// eslint-disable-next-line no-unused-vars
const { StateConfig, USER_AGENT, chalk, error, execa, log, warn, watchDebounced } = require('../../utils')

const {
  generateFunctionsFile,
  generateHandlerByOperationId,
  getCodegenFunctionById,
  getCodegenModule,
  normalizeOperationsDoc,
  readGraphQLOperationsSourceFile,
  writeGraphQLOperationsSourceFile,
  writeGraphQLSchemaFile,
} = require('./cli-netlify-graph')

const { parse } = GraphQL
const { defaultExampleOperationsDoc, extractFunctionsFromOperationDoc } = NetlifyGraph
const {
  ensureAppForSite,
  executeCreatePersistedQueryMutation,
  executeMarkCliSessionActiveHeartbeat,
  executeMarkCliSessionInactive,
  updateCLISessionMetadata,
} = OneGraphClient

const internalConsole = {
  log,
  warn,
  error,
  debug: console.debug,
}

/**
 * Keep track of which document hashes we've received from the server so we can ignore events from the filesystem based on them
 */
const witnessedIncomingDocumentHashes = []

InternalConsole.registerConsole(internalConsole)

/**
 * Start polling for CLI events for a given session to process locally
 * @param {object} input
 * @param {string} input.appId The app to query against, typically the siteId
 * @param {string} input.netlifyToken The (typically netlify) access token that is used for authentication, if any
 * @param {object} input.config The parsed netlify.toml file
 * @param {NetlifyGraph.NetlifyGraphConfig} input.netlifyGraphConfig A standalone config object that contains all the information necessary for Netlify Graph to process events
 * @param {function} input.onClose A function to call when the polling loop is closed
 * @param {function} input.onError A function to call when an error occurs
 * @param {function} input.onEvents A function to call when CLI events are received and need to be processed
 * @param {function} input.onSchemaIdChange A function to call when the CLI schemaId has changed
 * @param {string} input.sessionId The session id to monitor CLI events for
 * @param {StateConfig} input.state A function to call to set/get the current state of the local Netlify project
 * @param {any} input.site The site object
 * @returns
 */
const monitorCLISessionEvents = (input) => {
  const { appId, config, netlifyGraphConfig, netlifyToken, onClose, onError, onEvents, site, state } = input
  const currentSessionId = input.sessionId
  // TODO (sg): Track changing schemaId for a session
  // eslint-disable-next-line prefer-const
  let schemaId = 'TODO_SCHEMA'

  const frequency = 5000
  // 30 minutes
  const defaultHeartbeatFrequency = 1_800_000
  let shouldClose = false
  let nextMarkActiveHeartbeat = defaultHeartbeatFrequency

  const markActiveHelper = async () => {
    const graphJwt = await OneGraphClient.getGraphJwtForSite({ siteId: appId, nfToken: netlifyToken })
    const fullSession = await OneGraphClient.fetchCliSession({ jwt: graphJwt.jwt, appId, sessionId: currentSessionId })
    // @ts-ignore
    const heartbeatIntervalms = fullSession.session.cliHeartbeatIntervalMs || defaultHeartbeatFrequency
    nextMarkActiveHeartbeat = heartbeatIntervalms
    const markCLISessionActiveResult = await executeMarkCliSessionActiveHeartbeat(
      graphJwt.jwt,
      site.id,
      currentSessionId,
    )
    if (
      !markCLISessionActiveResult ||
      (markCLISessionActiveResult.errors && markCLISessionActiveResult.errors.length !== 0)
    ) {
      warn(
        `Failed to mark CLI session active: ${
          markCLISessionActiveResult &&
          markCLISessionActiveResult.errors &&
          markCLISessionActiveResult.errors.join(', ')
        }`,
      )
    }
    setTimeout(markActiveHelper, nextMarkActiveHeartbeat)
  }

  setTimeout(markActiveHelper, nextMarkActiveHeartbeat)

  const enabledServiceWatcher = async (jwt, { appId: siteId, sessionId }) => {
    const enabledServices = state.get('oneGraphEnabledServices') || ['onegraph']

    const enabledServicesInfo = await OneGraphClient.fetchEnabledServicesForSession(jwt, siteId, sessionId)
    if (!enabledServicesInfo) {
      warn('Unable to fetch enabled services for site for code generation')
      return
    }
    const newEnabledServices = enabledServicesInfo.map((service) => service.graphQLField)
    const enabledServicesCompareKey = enabledServices.sort().join(',')
    const newEnabledServicesCompareKey = newEnabledServices.sort().join(',')

    if (enabledServicesCompareKey !== newEnabledServicesCompareKey) {
      log(
        `${chalk.magenta(
          'Reloading',
        )} Netlify Graph schema..., ${enabledServicesCompareKey} => ${newEnabledServicesCompareKey}`,
      )
      await refetchAndGenerateFromOneGraph({ config, netlifyGraphConfig, state, jwt, siteId, sessionId, schemaId })
      log(`${chalk.green('Reloaded')} Netlify Graph schema and regenerated functions`)
    }
  }

  const close = () => {
    shouldClose = true
  }

  let handle

  const helper = async () => {
    if (shouldClose) {
      clearTimeout(handle)
      onClose && onClose()
    }

    const graphJwt = await OneGraphClient.getGraphJwtForSite({ siteId: appId, nfToken: netlifyToken })
    const next = await OneGraphClient.fetchCliSessionEvents({ appId, jwt: graphJwt.jwt, sessionId: currentSessionId })

    if (next && next.errors) {
      next.errors.forEach((fetchEventError) => {
        onError(fetchEventError)
      })
    }

    const events = (next && next.events) || []

    if (events.length !== 0) {
      let ackIds = []
      try {
        ackIds = await onEvents(events)
      } catch (eventHandlerError) {
        warn(`Error handling event: ${eventHandlerError}`)
      } finally {
        await OneGraphClient.ackCLISessionEvents({
          appId,
          jwt: graphJwt.jwt,
          sessionId: currentSessionId,
          eventIds: ackIds,
        })
      }
    }

    await enabledServiceWatcher(graphJwt.jwt, { appId, sessionId: currentSessionId })

    handle = setTimeout(helper, frequency)
  }

  // Fire immediately to start rather than waiting the initial `frequency`
  helper()

  return close
}

/**
 * Monitor the operations document for changes
 * @param {object} input
 * @param {NetlifyGraph.NetlifyGraphConfig} input.netlifyGraphConfig A standalone config object that contains all the information necessary for Netlify Graph to process events
 * @param {() => void} input.onAdd A callback function to handle when the operations document is added
 * @param {() => void} input.onChange A callback function to handle when the operations document is changed
 * @param {() => void=} input.onUnlink A callback function to handle when the operations document is unlinked
 * @returns {Promise<any>}
 */
const monitorOperationFile = async ({ netlifyGraphConfig, onAdd, onChange, onUnlink }) => {
  const filePath = path.resolve(...(netlifyGraphConfig.graphQLOperationsSourceFilename || []))
  const newWatcher = await watchDebounced([filePath], {
    depth: 1,
    onAdd,
    onChange,
    onUnlink,
  })

  return newWatcher
}

/**
 * Fetch the schema for a site, and regenerate all of the downstream files
 * @param {object} input
 * @param {string} input.siteId The id of the site to query against
 * @param {string} input.jwt The Graph JWT
 * @param {string} input.sessionId The session ID for the current session
 * @param {NetlifyGraph.NetlifyGraphConfig} input.netlifyGraphConfig A standalone config object that contains all the information necessary for Netlify Graph to process events
 * @param {StateConfig} input.state A function to call to set/get the current state of the local Netlify project
 * @param {(message: string) => void=} input.logger A function that if provided will be used to log messages
 * @returns {Promise<Record<string, unknown> | undefined>}
 */
const fetchCliSessionSchema = async (input) => {
  const { jwt, siteId } = input

  await OneGraphClient.ensureAppForSite(jwt, siteId)

  const schemaInfo = await OneGraphClient.fetchNetlifySessionSchemaQuery(
    { sessionId: input.sessionId },
    {
      accessToken: jwt,
      siteId,
    },
  )
  if (!schemaInfo) {
    warn('Unable to fetch schema for session')
    return
  }

  try {
    const schemaMetadata = schemaInfo.data.oneGraph.netlifyCliSession.graphQLSchema
    return schemaMetadata
  } catch {}
}

/**
 * Fetch the schema for a site, and regenerate all of the downstream files
 * @param {object} input
 * @param {string} input.siteId The id of the site to query against
 * @param {string} input.jwt The Graph JWT
 * @param {object} input.config The parsed netlify.toml file
 * @param {string} input.sessionId The session ID for the current session
 * @param {string} input.schemaId The schemaId for the current session
 * @param {NetlifyGraph.NetlifyGraphConfig} input.netlifyGraphConfig A standalone config object that contains all the information necessary for Netlify Graph to process events
 * @param {StateConfig} input.state A function to call to set/get the current state of the local Netlify project
 * @param {(message: string) => void=} input.logger A function that if provided will be used to log messages
 * @returns {Promise<void>}
 */
const refetchAndGenerateFromOneGraph = async (input) => {
  const { config, jwt, logger, netlifyGraphConfig, schemaId, siteId, state } = input

  await OneGraphClient.ensureAppForSite(jwt, siteId)

  const enabledServicesInfo = await OneGraphClient.fetchEnabledServicesForSession(jwt, siteId, input.sessionId)
  if (!enabledServicesInfo) {
    warn('Unable to fetch enabled services for site for code generation')
    return
  }

  const enabledServices = enabledServicesInfo
    .map((service) => service.graphQLField)
    .sort((aString, bString) => aString.localeCompare(bString))

  const schema = await OneGraphClient.fetchOneGraphSchemaForServices(siteId, enabledServices)

  let currentOperationsDoc = readGraphQLOperationsSourceFile(netlifyGraphConfig)
  if (currentOperationsDoc.trim().length === 0) {
    currentOperationsDoc = defaultExampleOperationsDoc
  }

  const parsedDoc = parse(currentOperationsDoc)
  const { fragments, functions } = extractFunctionsFromOperationDoc(GraphQL, parsedDoc)

  if (!schema) {
    warn('Unable to parse schema, please run graph:pull to update')
    return
  }

  generateFunctionsFile({
    config,
    logger,
    netlifyGraphConfig,
    schema,
    operationsDoc: currentOperationsDoc,
    functions,
    fragments,
    schemaId,
  })
  writeGraphQLSchemaFile({ logger, netlifyGraphConfig, schema })
  state.set('oneGraphEnabledServices', enabledServices)
}

/**
 * Regenerate the function library based on the current operations document on disk
 * @param {object} input
 * @param {object} input.config The parsed netlify.toml file
 * @param {GraphQL.GraphQLSchema} input.schema The GraphQL schema to use when generating code
 * @param {string} input.schemaId The GraphQL schemaId to use when generating code
 * @param {NetlifyGraph.NetlifyGraphConfig} input.netlifyGraphConfig A standalone config object that contains all the information necessary for Netlify Graph to process events
 * @returns
 */
const regenerateFunctionsFileFromOperationsFile = (input) => {
  const { config, netlifyGraphConfig, schema, schemaId } = input

  const appOperationsDoc = readGraphQLOperationsSourceFile(netlifyGraphConfig)

  const hash = quickHash(appOperationsDoc)

  if (witnessedIncomingDocumentHashes.includes(hash)) {
    // We've already seen this document, so don't regenerate
    return
  }

  const parsedDoc = parse(appOperationsDoc, {
    noLocation: true,
  })
  const { fragments, functions } = extractFunctionsFromOperationDoc(GraphQL, parsedDoc)
  generateFunctionsFile({
    config,
    netlifyGraphConfig,
    schema,
    operationsDoc: appOperationsDoc,
    functions,
    fragments,
    schemaId,
  })
}

/**
 * Compute a md5 hash of a string
 * @param {string} input String to compute a quick md5 hash for
 * @returns hex digest of the input string
 */
const quickHash = (input) => {
  const hashSum = crypto.createHash('md5')
  hashSum.update(input)
  return hashSum.digest('hex')
}

/**
 * Fetch a persisted operations doc by its id, write it to the system, and regenerate the library
 * @param {object} input
 * @param {string} input.siteId The site id to query against
 * @param {string} input.netlifyToken The (typically netlify) access token that is used for authentication, if any
 * @param {string} input.docId The GraphQL operations document id to fetch
 * @param {object} input.config The parsed netlify.toml file
 * @param {(message: string) => void=} input.logger A function that if provided will be used to log messages
 * @param {GraphQL.GraphQLSchema} input.schema The GraphQL schema to use when generating code
 * @param {string} input.schemaId The GraphQL schemaId to use when generating code
 * @param {NetlifyGraph.NetlifyGraphConfig} input.netlifyGraphConfig A standalone config object that contains all the information necessary for Netlify Graph to process events
 * @returns
 */
const updateGraphQLOperationsFileFromPersistedDoc = async (input) => {
  const { config, docId, logger, netlifyGraphConfig, netlifyToken, schema, schemaId, siteId } = input
  const { jwt } = await OneGraphClient.getGraphJwtForSite({ siteId, nfToken: netlifyToken })
  const persistedDoc = await OneGraphClient.fetchPersistedQuery(jwt, siteId, docId)
  if (!persistedDoc) {
    warn(`No persisted doc found for: ${docId}`)
    return
  }

  // Sorts the operations stably, prepends the @netlify directive, etc.
  const operationsDocString = normalizeOperationsDoc(GraphQL, persistedDoc.query)

  writeGraphQLOperationsSourceFile({ logger, netlifyGraphConfig, operationsDocString })
  regenerateFunctionsFileFromOperationsFile({ config, netlifyGraphConfig, schema, schemaId })

  const hash = quickHash(operationsDocString)

  const relevantHasLength = 10

  if (witnessedIncomingDocumentHashes.length > relevantHasLength) {
    witnessedIncomingDocumentHashes.shift()
  }

  witnessedIncomingDocumentHashes.push(hash)
}

const handleCliSessionEvent = async ({
  config,
  event,
  netlifyGraphConfig,
  netlifyToken,
  schema,
  schemaId,
  sessionId,
  siteId,
  siteRoot,
}) => {
  const { __typename } = await event
  switch (__typename) {
    case 'OneGraphNetlifyCliSessionTestEvent': {
      /** @type {CliEventHelper.OneGraphNetlifyCliSessionTestEvent} */
      const localEvent = event
      const { payload } = localEvent

      await handleCliSessionEvent({
        config,
        netlifyToken,
        event: payload,
        netlifyGraphConfig,
        schema,
        schemaId,
        sessionId,
        siteId,
        siteRoot,
      })
      break
    }
    case 'OneGraphNetlifyCliSessionGenerateHandlerEvent': {
      /** @type {CliEventHelper.OneGraphNetlifyCliSessionGenerateHandlerEvent} */
      const localEvent = event
      const { payload } = localEvent

      if (!payload.operationId) {
        warn(`No operation id found in payload,
  ${JSON.stringify(payload, null, 2)}`)
        return
      }

      const codegenModule = await getCodegenModule({ config })
      if (!codegenModule) {
        error(
          `No Graph codegen module specified in netlify.toml under the [graph] header. Please specify 'codeGenerators' field and try again.`,
        )
        return
      }

      const codeGenerator = await getCodegenFunctionById({ config, id: payload.codeGeneratorId })
      if (!codeGenerator) {
        warn(`Unable to find Netlify Graph code generator with id "${payload.codeGeneratorId}"`)
        return
      }

      const files = generateHandlerByOperationId({
        netlifyGraphConfig,
        schema,
        operationId: payload.operationId,
        handlerOptions: payload,
        generate: codeGenerator.generateHandler,
      })

      if (!files) {
        warn(`No files generated for operation id: ${payload.operationId}`)
        return
      }

      const editor = process.env.EDITOR || null

      for (const file of files) {
        /** @type {CliEventHelper.OneGraphNetlifyCliSessionFileWrittenEvent} */
        // @ts-expect-error: TODO (sg): verify this works
        const fileWrittenEvent = {
          __typename: 'OneGraphNetlifyCliSessionFileWrittenEvent',
          sessionId,
          payload: {
            editor,
            filePath: file.filePath,
          },
          audience: 'UI',
        }

        const graphJwt = await OneGraphClient.getGraphJwtForSite({ siteId, nfToken: netlifyToken })

        await OneGraphClient.executeCreateCLISessionEventMutation(
          {
            sessionId,
            payload: fileWrittenEvent,
          },
          { accesToken: graphJwt.jwt },
        )
      }
      break
    }
    case 'OneGraphNetlifyCliSessionOpenFileEvent': {
      /** @type {CliEventHelper.OneGraphNetlifyCliSessionOpenFileEvent} */
      const localEvent = event
      const { payload } = localEvent

      if (!payload.filePath) {
        warn(`No filePath found in payload, ${JSON.stringify(payload, null, 2)}`)
        return
      }

      const editor = process.env.EDITOR || null

      if (!editor) {
        warn(
          `No $EDITOR environmental variable defined. Please define an env var with e.g. $EDITOR="code" for the best end-to-end Netlify Graph experience`,
        )
        return
      }

      if (editor) {
        log(`Opening ${editor} for ${payload.filePath}`)
        execa(editor, [payload.filePath], {
          preferLocal: true,
          // windowsHide needs to be false for child process to terminate properly on Windows
          windowsHide: false,
        })
      }
      break
    }
    case 'OneGraphNetlifyCliSessionPersistedLibraryUpdatedEvent': {
      /** @type {CliEventHelper.OneGraphNetlifyCliSessionPersistedLibraryUpdatedEvent} */
      const localEvent = event
      const { payload } = localEvent
      await updateGraphQLOperationsFileFromPersistedDoc({
        config,
        netlifyToken,
        docId: payload.docId,
        netlifyGraphConfig,
        schema,
        schemaId,
        siteId,
      })
      break
    }
    default: {
      warn(
        `Unrecognized event received, you may need to upgrade your CLI version: ${__typename}: ${JSON.stringify(
          event,
          null,
          2,
        )}`,
      )
      break
    }
  }
}

/**
 *
 * @param {object} input
 * @param {string} input.jwt The GraphJWT string
 * @param {string} input.oneGraphSessionId The id of the cli session to fetch the current metadata for
 * @param {object} input.siteId The site object that contains the root file path for the site
 */
const getCLISession = async ({ jwt, oneGraphSessionId, siteId }) => {
  const input = {
    appId: siteId,
    sessionId: oneGraphSessionId,
    jwt,
    desiredEventCount: 1,
  }
  return await OneGraphClient.fetchCliSession(input)
}

/**
 *
 * @param {object} input
 * @param {string} input.jwt The GraphJWT string
 * @param {string} input.oneGraphSessionId The id of the cli session to fetch the current metadata for
 * @param {string} input.siteId The site object that contains the root file path for the site
 */
const getCLISessionMetadata = async ({ jwt, oneGraphSessionId, siteId }) => {
  const result = await getCLISession({ jwt, oneGraphSessionId, siteId })
  if (!result) {
    warn(`Unable to fetch CLI session metadata`)
  }
  const { errors, session } = result
  return { metadata: session && session.metadata, errors }
}

/**
 * Look at the current project, filesystem, etc. and determine relevant metadata for a cli session
 * @param {object} input
 * @param {string} input.siteRoot The root file path for the site
 * @param {object} input.config The parsed netlify.toml config file
 * @returns {Promise<Record<string, any>>} Any locally detected facts that are relevant to include in the cli session metadata
 */
const detectLocalCLISessionMetadata = async ({ config, siteRoot }) => {
  const { branch } = gitRepoInfo()
  const hostname = os.hostname()
  const userInfo = os.userInfo({ encoding: 'utf-8' })
  const { username } = userInfo
  const cliVersion = USER_AGENT

  const editor = process.env.EDITOR || null

  let codegen = {}

  const codegenModule = await getCodegenModule({ config })

  if (codegenModule) {
    codegen = {
      id: codegenModule.id,
      version: codegenModule.id,
      generators: codegenModule.generators.map((generator) => ({
        id: generator.id,
        name: generator.name,
        options: generator.generateHandlerOptions,
        supportedDefinitionTypes: generator.supportedDefinitionTypes,
        version: generator.version,
      })),
    }
  }

  const detectedMetadata = {
    gitBranch: branch,
    hostname,
    username,
    siteRoot,
    cliVersion,
    editor,
    codegen,
  }

  return detectedMetadata
}

/**
 * Fetch the existing cli session metadata if it exists, and mutate it remotely with the passed in metadata
 * @param {object} input
 * @param {object} input.config The parsed netlify.toml file
 * @param {string} input.jwt The Graph JWT string
 * @param {string} input.oneGraphSessionId The id of the cli session to fetch the current metadata for
 * @param {string} input.siteId The site object that contains the root file path for the site
 * @param {string} input.siteRoot The root file path for the site
 * @param {object} input.newMetadata The metadata to merge into (with priority) the existing metadata
 * @returns {Promise<object>}
 */
const upsertMergeCLISessionMetadata = async ({ config, jwt, newMetadata, oneGraphSessionId, siteId, siteRoot }) => {
  const { errors, metadata } = await getCLISessionMetadata({ jwt, oneGraphSessionId, siteId })
  if (errors) {
    warn(`Error fetching cli session metadata: ${JSON.stringify(errors, null, 2)}`)
  }

  const detectedMetadata = await detectLocalCLISessionMetadata({ config, siteRoot })

  // @ts-ignore
  const finalMetadata = { ...metadata, ...detectedMetadata, ...newMetadata }

  const result = OneGraphClient.updateCLISessionMetadata(jwt, siteId, oneGraphSessionId, finalMetadata)

  return result
}

const persistNewOperationsDocForSession = async ({
  config,
  netlifyToken,
  oneGraphSessionId,
  operationsDoc,
  siteId,
  siteRoot,
}) => {
  const { branch } = gitRepoInfo()
  const { jwt } = await OneGraphClient.getGraphJwtForSite({ siteId, nfToken: netlifyToken })
  const persistedResult = await executeCreatePersistedQueryMutation(
    {
      appId: siteId,
      description: 'Temporary snapshot of local queries',
      query: operationsDoc,
      tags: ['netlify-cli', `session:${oneGraphSessionId}`, `git-branch:${branch}`, `local-change`],
    },
    {
      accessToken: jwt,
      siteId,
    },
  )

  const persistedDoc =
    persistedResult.data &&
    persistedResult.data.oneGraph &&
    persistedResult.data.oneGraph.createPersistedQuery &&
    persistedResult.data.oneGraph.createPersistedQuery.persistedQuery

  if (!persistedDoc) {
    warn(`Failed to create persisted query for editing, ${JSON.stringify(persistedResult, null, 2)}`)
  }

  const newMetadata = { docId: persistedDoc.id }
  const result = await upsertMergeCLISessionMetadata({
    config,
    jwt,
    siteId,
    oneGraphSessionId,
    newMetadata,
    siteRoot,
  })

  if (!result || result.errors) {
    warn(`Unable to update session metadata with updated operations doc ${JSON.stringify(result.errors, null, 2)}`)
  }
}

const createCLISession = async ({ metadata, netlifyToken, sessionName, siteId }) => {
  const { jwt } = await OneGraphClient.getGraphJwtForSite({ siteId, nfToken: netlifyToken })
  const result = OneGraphClient.createCLISession(jwt, siteId, sessionName, metadata)
  return result
}

/**
 * Load the CLI session id from the local state
 * @param {StateConfig} state
 * @returns
 */
const loadCLISession = (state) => state.get('oneGraphSessionId')

/**
 * Idemponentially save the CLI session id to the local state and start monitoring for CLI events, upstream schema changes, and local operation file changes
 * @param {object} input
 * @param {object} input.config
 * @param {string} input.netlifyToken The (typically netlify) access token that is used for authentication, if any
 * @param {string | undefined} input.oneGraphSessionId The session ID to use for this CLI session (default: read from state)
 * @param {NetlifyGraph.NetlifyGraphConfig} input.netlifyGraphConfig A standalone config object that contains all the information necessary for Netlify Graph to process events
 * @param {StateConfig} input.state A function to call to set/get the current state of the local Netlify project
 * @param {any} input.site The site object
 */
const startOneGraphCLISession = async (input) => {
  const { config, netlifyGraphConfig, netlifyToken, site, state } = input
  const { jwt } = await OneGraphClient.getGraphJwtForSite({ siteId: site.id, nfToken: netlifyToken })
  OneGraphClient.ensureAppForSite(jwt, site.id)
  let schemaId = 'TODO_SCHEMA'

  const oneGraphSessionId = await ensureCLISession({
    config,
    netlifyGraphConfig,
    metadata: {},
    netlifyToken,
    site,
    state,
    oneGraphSessionId: input.oneGraphSessionId,
  })

  const enabledServices = []
  const schema = await OneGraphClient.fetchOneGraphSchemaForServices(site.id, enabledServices)

  const opsFileWatcher = monitorOperationFile({
    netlifyGraphConfig,
    onChange: async (filePath) => {
      log('NetlifyGraph operation file changed at', filePath, 'updating function library...')
      if (!schema) {
        warn('Unable to load schema, run graph:pull to update')
        return
      }

      regenerateFunctionsFileFromOperationsFile({ config, netlifyGraphConfig, schema, schemaId })
      const newOperationsDoc = readGraphQLOperationsSourceFile(netlifyGraphConfig)
      await persistNewOperationsDocForSession({
        config,
        netlifyToken,
        oneGraphSessionId,
        operationsDoc: newOperationsDoc,
        siteId: site.id,
        siteRoot: site.root,
      })
    },
    onAdd: async (filePath) => {
      log('NetlifyGraph operation file created at', filePath, 'creating function library...')
      if (!schema) {
        warn('Unable to load schema, run graph:pull to update')
        return
      }

      regenerateFunctionsFileFromOperationsFile({ config, netlifyGraphConfig, schema, schemaId })
      const newOperationsDoc = readGraphQLOperationsSourceFile(netlifyGraphConfig)
      await persistNewOperationsDocForSession({
        config,
        netlifyToken,
        oneGraphSessionId,
        operationsDoc: newOperationsDoc,
        siteId: site.id,
        siteRoot: site.root,
      })
    },
  })

  const cliEventsCloseFn = monitorCLISessionEvents({
    config,
    appId: site.id,
    netlifyToken,
    netlifyGraphConfig,
    sessionId: oneGraphSessionId,
    site,
    state,
    onClose: () => {
      log('CLI session closed, stopping monitoring...')
    },
    onSchemaIdChange: (newSchemaId) => {
      log('CLI session schemaId changed:', newSchemaId)
      schemaId = newSchemaId
    },
    onEvents: async (events) => {
      const ackEventIds = []

      for (const event of events) {
        const audience = OneGraphClient.eventAudience(event)
        if (audience === 'cli') {
          const eventName = OneGraphClient.friendlyEventName(event)
          log(`${chalk.magenta('Handling')} Netlify Graph: ${eventName}...`)
          await handleCliSessionEvent({
            config,
            netlifyToken,
            event,
            netlifyGraphConfig,
            schema,
            schemaId,
            sessionId: oneGraphSessionId,
            siteId: site.id,
            siteRoot: site.root,
          })
          log(`${chalk.green('Finished handling')} Netlify Graph: ${eventName}...`)
          ackEventIds.push(event.id)
        }
      }

      return ackEventIds
    },
    onError: (fetchEventError) => {
      error(`Netlify Graph upstream error: ${fetchEventError}`)
    },
  })

  return async function unregisterWatchers() {
    const watcher = await opsFileWatcher
    watcher.close()
    cliEventsCloseFn()
  }
}

/**
 * Mark a session as inactive so it doesn't show up in any UI lists, and potentially becomes available to GC later
 * @param {object} input
 * @param {string} input.netlifyToken The (typically netlify) access token that is used for authentication, if any
 * @param {string} input.siteId A function to call to set/get the current state of the local Netlify project
 * @param {string} input.sessionId The session id to monitor CLI events for
 */
const markCliSessionInactive = async ({ netlifyToken, sessionId, siteId }) => {
  const { jwt } = await OneGraphClient.getGraphJwtForSite({ siteId, nfToken: netlifyToken })
  const result = await executeMarkCliSessionInactive(jwt, siteId, sessionId)
  if (!result || result.errors) {
    warn(`Unable to mark CLI session ${sessionId} inactive: ${JSON.stringify(result.errors, null, 2)}`)
  }
}

/**
 * Generate a session name that can be identified as belonging to the current checkout
 * @returns {string} The name of the session to create
 */
const generateSessionName = () => {
  const userInfo = os.userInfo({ encoding: 'utf-8' })
  const sessionName = `${userInfo.username}-${Date.now()}`
  log(`Generated Netlify Graph session name: ${sessionName}`)
  return sessionName
}

/**
 * Ensures a cli session exists for the current checkout, or errors out if it doesn't and cannot create one.
 */
const ensureCLISession = async (input) => {
  const { config, metadata, netlifyToken, site, state } = input
  let oneGraphSessionId = input.oneGraphSessionId ? input.oneGraphSessionId : loadCLISession(state)
  let parentCliSessionId = null
  const { jwt } = await OneGraphClient.getGraphJwtForSite({ siteId: site.id, nfToken: netlifyToken })

  // Validate that session still exists and we can access it
  try {
    if (oneGraphSessionId) {
      const sessionEvents =
        (await OneGraphClient.fetchCliSessionEvents({
          appId: site.id,
          jwt,
          sessionId: oneGraphSessionId,
        })) || {}

      if (!sessionEvents || sessionEvents.errors) {
        warn(`Unable to fetch cli session: ${JSON.stringify(sessionEvents.errors, null, 2)}`)
        log(`Creating new cli session`)
        parentCliSessionId = oneGraphSessionId
        oneGraphSessionId = null
      }
    }
  } catch (fetchSessionError) {
    warn(`Unable to fetch cli session events: ${JSON.stringify(fetchSessionError, null, 2)}`)
    oneGraphSessionId = null
  }

  if (oneGraphSessionId) {
    await upsertMergeCLISessionMetadata({
      jwt,
      config,
      newMetadata: {},
      oneGraphSessionId,
      siteId: site.id,
      siteRoot: site.root,
    })
  } else {
    // If we can't access the session in the state.json or it doesn't exist, create a new one
    const sessionName = generateSessionName()
    const detectedMetadata = await detectLocalCLISessionMetadata({
      config,
      siteRoot: site.root,
    })
    const newSessionMetadata = parentCliSessionId ? { parentCliSessionId } : {}
    const sessionMetadata = {
      ...detectedMetadata,
      ...newSessionMetadata,
      ...metadata,
    }
    const oneGraphSession = await createCLISession({
      netlifyToken,
      siteId: site.id,
      sessionName,
      metadata: sessionMetadata,
    })

    if (oneGraphSession) {
      // @ts-expect-error
      oneGraphSessionId = oneGraphSession.id
    } else {
      warn('Unable to load Netlify Graph session, please report this to Netlify support')
    }
  }

  if (!oneGraphSessionId) {
    error('Unable to create or access Netlify Graph CLI session')
  }

  state.set('oneGraphSessionId', oneGraphSessionId)
  const { errors: markCLISessionActiveErrors } = await executeMarkCliSessionActiveHeartbeat(
    jwt,
    site.id,
    oneGraphSessionId,
  )

  if (markCLISessionActiveErrors) {
    warn(`Unable to mark cli session active: ${JSON.stringify(markCLISessionActiveErrors, null, 2)}`)
  }

  return oneGraphSessionId
}

const OneGraphCliClient = {
  ackCLISessionEvents: OneGraphClient.ackCLISessionEvents,
  executeCreatePersistedQueryMutation: OneGraphClient.executeCreatePersistedQueryMutation,
  executeCreateApiTokenMutation: OneGraphClient.executeCreateApiTokenMutation,
  fetchCliSessionEvents: OneGraphClient.fetchCliSessionEvents,
  fetchCliSessionSchema,
  ensureAppForSite,
  updateCLISessionMetadata,
  getGraphJwtForSite: OneGraphClient.getGraphJwtForSite,
}

module.exports = {
  OneGraphCliClient,
  createCLISession,
  ensureCLISession,
  extractFunctionsFromOperationDoc,
  handleCliSessionEvent,
  generateSessionName,
  loadCLISession,
  markCliSessionInactive,
  monitorCLISessionEvents,
  persistNewOperationsDocForSession,
  refetchAndGenerateFromOneGraph,
  startOneGraphCLISession,
  upsertMergeCLISessionMetadata,
}
