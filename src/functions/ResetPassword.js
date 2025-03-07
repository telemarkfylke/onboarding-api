const { app } = require('@azure/functions')
const { resetPassword, getUserByExtensionAttributeSsn, getUserByCustomSecurityAttributeSsn } = require('../call-graph')
const { logger } = require('@vtfk/logger')
const { getStateCache } = require('../state-cache')
const { getIdPortenClient } = require('../idporten-client')
const { IDPORTEN, DEMO_MODE } = require('../../config')
const { getKrrPerson } = require('../krr')
const { sendSms } = require('../sms')
const { createLogEntry, insertLogEntry, updateLogEntry } = require('../logEntry')
const { createPwdStat } = require('../stats')

const maskSsn = (ssn) => {
  return `${ssn.substring(0, 6)}*****` // 123456*****
}

const maskPhoneNumber = (phoneNumber) => {
  return `+${phoneNumber.substring(0, 2)} *****${phoneNumber.substring(7)}` // +47 *****682
}

const fixPhoneNumber = (phoneNumber) => {
  let fixedPhoneNumber = phoneNumber
  if (fixedPhoneNumber.startsWith('+')) fixedPhoneNumber = fixedPhoneNumber.substring(1)
  if (fixedPhoneNumber.length === 12 && fixedPhoneNumber.startsWith('00')) fixedPhoneNumber = fixedPhoneNumber.substring(2)
  if (fixedPhoneNumber.length !== 10) throw new Error(`We cannot send sms to this phonenumber, wrong format: ${phoneNumber}`)
  return fixedPhoneNumber
}

/**
 *
 * @param {Object} error
 * @param {('idPorten'|'entraId'|'krr'|'resetPassword'|'sms')} error.jobName
 * @param {string} [error.message]
 * @param {string} [error.status]
 * @param {string} error.jobName
 * @param {string} [error.logPrefix]
 * @param {Object} error.logEntry
 * @param {import('mongodb').ObjectId} error.logEntryId
 * @param {Error} error.error
 *
 * @returns
 */
const handleError = async (error, context) => {
  if (!error.error) throw new Error('Missing required parameter "error.error"')
  if (!error.logEntry) throw new Error('Missing required parameter "error.logEntry"')
  if (!error.logEntryId) throw new Error('Missing required parameter "error.logEntryId"')
  if (!error.jobName) throw new Error('Missing required parameter "error.jobName"')
  if (!error.status) error.status = 500
  if (!error.logPrefix) error.logPrefix = ''
  if (!error.message) error.message = `Failed when running job "${error.jobName}"`
  const errorData = error.error.response?.data || error.error.stack || error.error.toString()
  logger('error', [error.logPrefix, error.message, errorData], context)
  error.logEntry.status = 'failed'
  error.logEntry.finishedTimestamp = new Date().toISOString()
  error.logEntry.result = error.message
  error.logEntry.message = error.message
  error.logEntry[error.jobName].result = {
    status: 'failed',
    message: errorData
  }
  await updateLogEntry(error.logEntryId, error.logEntry)
  return { status: error.status, jsonBody: { message: error.message, data: errorData } }
}

const stateCache = getStateCache()

app.http('ResetPassword', {
  methods: ['POST'],
  authLevel: 'function',
  handler: async (request, context) => {
    // Validate request body
    const { code, iss, state } = await request.json()
    if (!(code && iss && state)) {
      logger('warn', ['ResetPassword', 'Someone called ResetPassword without code, iss, and state in body - is someone trying to hack us?'], context)
      return { status: 400, jsonBody: { message: 'Du har glemt state og iss og code i body da' } }
    }

    // Verify type as well, just for extra credits
    if ([code, iss, state].some(param => typeof param !== 'string')) {
      logger('warn', ['ResetPassword', 'Someone called ResetPassword without code, iss, and state as strings - is someone trying to hack us?'], context)
      return { status: 400, jsonBody: { message: 'Du har glemt at state, iss, og code skal være string...' } }
    }

    // Check that state exist in cache (originates from authorization)
    const checks = stateCache.get(state)
    if (!checks) {
      logger('warn', ['ResetPassword', `The state "${state}" sent by user does not match any state in state cache - is someone trying to be smart?`], context)
      return { status: 500, jsonBody: { message: 'Du har brukt for lang tid, rykk tilbake til start' } }
    }

    // Check state param for userType (startswith)
    const userType = state.startsWith('ansatt') ? 'ansatt' : state.startsWith('elev') ? 'elev' : null
    if (!userType) {
      logger('warn', ['ResetPassword', 'The state sent by user does not start with "ansatt" or "elev", either someone is klussing, or we developers are idiots (we are anyways..)'], context)
      return { status: 400, jsonBody: { message: 'Hva slags state er det du har fått til å sende inn? Den er ikke gyldig hvertfall' } }
    }

    const correctAction = state.startsWith(`${userType}resetpassword`)
    if (!correctAction) {
      logger('warn', ['ResetPassword', 'The state sent by user does not start with correct action after userType, seither someone is klussing, or we developers are idiots (we are anyways..)'], context)
      return { status: 400, jsonBody: { message: 'Hva slags state er det du har fått til å sende inn? Den er ikke gyldig hvertfall' } }
    }

    const user = {
      userType,
      ssn: null,
      maskedSsn: null,
      id: null,
      userPrincipalName: null,
      displayName: null,
      phoneNumber: null,
      newPassword: null,
      logoutUrl: null
    }

    // If logged in user has specified DEMO_ACCESS
    let DEMO_USER_OVERRIDE = null

    logger('info', ['"state" is ok, "code" and "iss" is present in body, creating log entry in db'], context)

    const logEntry = createLogEntry(context, request, userType, 'ResetPassword')

    let logEntryId
    try {
      logEntryId = await insertLogEntry(logEntry)
    } catch (error) {
      logger('error', ['Failed when trying to create logEntry in mongodb', error.response?.data || error.stack || error.toString()], context)
      return { status: 500, jsonBody: { message: 'Failed when trying to save logEntry in database', data: error.response?.data || error.stack || error.toString() } }
    }

    logger('info', ['Log entry successfully created, continuing to fetch tokens from ID-porten'], context)

    // Run callback for authorization - fetches tokens for user, validates the authentication
    let idPortenClient
    let tokens
    try {
      // Get idPorten client
      idPortenClient = await getIdPortenClient()

      // Fetch tokens. Verifies code_verifier, state, and nonce
      tokens = await idPortenClient.callback(IDPORTEN.ClIENT_REDIRECT_URI, { code, iss, state }, { code_verifier: checks.codeVerifier, nonce: checks.nonce, state })

      // Get id token claims
      const idTokenClaims = tokens.claims()

      // Check if we have DEMO_USER_OVERRIDE
      if (DEMO_MODE.DEMO_USERS[idTokenClaims.pid]) {
        DEMO_USER_OVERRIDE = DEMO_MODE.DEMO_USERS[idTokenClaims.pid]
      }

      // Set user ssn as pid from id token (if not demo)
      if (DEMO_MODE.ENABLED && DEMO_USER_OVERRIDE?.DEMO_SSN) {
        logger('warn', ['DEMO_MODE is enabled, and DEMO_USER_OVERRIDE is present on idPorten pid, setting user.ssn to DEMO_USER_OVERRIDE.DEMO_SSN'], context)
        user.ssn = DEMO_USER_OVERRIDE.DEMO_SSN
      } else {
        user.ssn = idTokenClaims.pid // pid in id-token is identity number of user
      }

      // Set masked ssn for logging
      user.maskedSsn = maskSsn(user.ssn)

      // If tokens are ok - delete state for this request
      stateCache.del(state)

      // Set log entry properties
      logEntry.idPorten = {
        pid: idTokenClaims.pid,
        acr: idTokenClaims.acr,
        amr: idTokenClaims.amr,
        result: {
          status: 'okey-dokey',
          message: 'Logged in with id-porten'
        }
      }
    } catch (error) {
      const { status, jsonBody } = await handleError({ error, jobName: 'idPorten', logEntry, logEntryId, message: 'Failed when trying to get tokens from ID-porten', status: 500 }, context)
      return { status, jsonBody }
    }

    // Have ssn - set masked ssn as log prefix
    let logPrefix = `${user.userType} - ${user.maskedSsn} - logEntryId: ${logEntryId}`

    // Fetch user from EntraId
    logger('info', [logPrefix, 'ID-porten is okey dokey, trying to fetch user from Entra ID'], context)
    try {
      let entraUser
      if (user.userType === 'ansatt') {
        entraUser = await getUserByExtensionAttributeSsn(user.ssn)
      } else if (user.userType === 'elev') {
        entraUser = await getUserByCustomSecurityAttributeSsn(user.ssn)
      }
      // Hvis ingen bruker returner vi tidlig med beskjed
      if (!entraUser.id) {
        const { status, jsonBody } = await handleError({ error: 'Could not find entraID user on ssn', jobName: 'entraId', logEntry, logEntryId, message: 'Fant ingen bruker hos oss med ditt fødselsnummer, ta kontakt med servicedesk eller din leder dersom du mener dette er feil.', status: 404, logPrefix }, context)
        return { status, jsonBody }
      }
      if (DEMO_MODE.ENABLED && DEMO_USER_OVERRIDE?.DEMO_UPN) {
        logger('warn', [logPrefix, 'DEMO_MODE is enabled, and DEMO_USER_OVERRIDE is present on idPorten pid, setting user.userPrincipalName to DEMO_USER_OVERRIDE.DEMO_UPN'], context)
        user.id = 'DEMO-ID'
        user.userPrincipalName = DEMO_USER_OVERRIDE.DEMO_UPN
        user.displayName = 'DEMO-BRUKER'
      } else {
        user.id = entraUser.id
        user.userPrincipalName = entraUser.userPrincipalName
        user.displayName = entraUser.displayName
      }
      logEntry.entraId = {
        userPrincipalName: user.userPrincipalName,
        displayName: user.displayName,
        id: user.id,
        result: {
          status: 'okey-dokey',
          message: 'Successfully found user in entraId'
        }
      }
    } catch (error) {
      const { status, jsonBody } = await handleError({ error, jobName: 'entraId', logEntry, logEntryId, message: 'Feilet ved henting av bruker - prøv igjen senere, eller kontakt servicesk', status: 500, logPrefix }, context)
      return { status, jsonBody }
    }

    logPrefix = `${user.userType} - ${user.maskedSsn} - logEntryId: ${logEntryId} - ${user.userPrincipalName}`

    logger('info', [logPrefix, 'Entra ID is okey dokey, trying to fetch user from KRR'], context)
    // Get user from KRR (kontakt og reservasjonsregisteret)
    try {
      const krrPerson = await getKrrPerson(user.ssn)
      if (!krrPerson.kontaktinformasjon?.mobiltelefonnummer) {
        const { status, jsonBody } = await handleError({ error: 'Found person in KRR, but person has not registered any phone number :( cannot help it', jobName: 'entraId', logEntry, logEntryId, message: 'Fant ikke telefonnummeret ditt i kontakt- og reservasjonsregisteret, så vi får ikke sendt noe sms :( Ta kontakt med servicedesk.', status: 404, logPrefix }, context)
        return { status, jsonBody }
      }
      if (DEMO_MODE.ENABLED && DEMO_USER_OVERRIDE?.DEMO_PHONE_NUMBER) {
        logger('warn', [logPrefix, 'DEMO_MODE is enabled, and DEMO_USER_OVERRIDE is present on idPorten pid, setting user.phoneNumber to DEMO_USER_OVERRIDE.DEMO_PHONE_NUMBER'], context)
        user.phoneNumber = DEMO_USER_OVERRIDE?.DEMO_PHONE_NUMBER
      } else {
        user.phoneNumber = krrPerson.kontaktinformasjon.mobiltelefonnummer
      }
      logEntry.krr = {
        phoneNumber: user.phoneNumber,
        result: {
          status: 'okey-dokey',
          message: 'Successfully found person and phonenumber in KRR'
        }
      }
    } catch (error) {
      const { status, jsonBody } = await handleError({ error, jobName: 'krr', logEntry, logEntryId, message: 'Feilet ved henting av mobilnummer fra kontakt- og reservasjons-registeret', status: 500, logPrefix }, context)
      return { status, jsonBody }
    }

    logger('info', [logPrefix, 'KRR is okey dokey, trying to reset password for user'], context)
    // Reset password for user
    try {
      if (DEMO_MODE.ENABLED && ((DEMO_USER_OVERRIDE?.MOCK_RESET_PASSWORD === 'true') || (!DEMO_USER_OVERRIDE && DEMO_MODE.GLOBAL_MOCK_RESET_PASSWORD))) {
        logger('warn', [logPrefix, 'DEMO_MODE is enabled, and DEMO_USER_OVERRIDE.MOCK_RESET_PASSWORD is true or DEMO_USER_OVERRIDE is not present and DEMO_MODE.GLOBAL_MOCK_RESET_PASSWORD is true, will not reset password, simply pretend to do it'], context)
        user.newPassword = 'Bare et mocke-passord 123, funker itj nogon stans'
      } else {
        const { newPassword } = await resetPassword(user.userPrincipalName)
        user.newPassword = newPassword
      }
      logEntry.resetPassword = {
        result: {
          status: 'okey-dokey',
          message: 'Successfully reset password for user'
        }
      }
    } catch (error) {
      const { status, jsonBody } = await handleError({ error, jobName: 'resetPassword', logEntry, logEntryId, message: 'Feilet ved resetting av passord', status: 500, logPrefix }, context)
      return { status, jsonBody }
    }

    logger('info', [logPrefix, 'Reset password is okey dokey, sending sms to user'], context)
    // Send password on sms
    try {
      user.phoneNumber = fixPhoneNumber(user.phoneNumber)
    } catch (error) {
      const { status, jsonBody } = await handleError({ error, jobName: 'sms', logEntry, logEntryId, message: 'Vi kan ikke sende sms til nummeret du har registrert i kontakt- og reservasjons-registeret. Nummeret må starte på +47 eller 0047.', status: 500, logPrefix }, context)
      return { status, jsonBody }
    }
    try {
      const message = user.newPassword
      await sendSms(user.phoneNumber, message)
      logEntry.sms = {
        phoneNumber: user.phoneNumber,
        result: {
          status: 'okey-dokey',
          message: 'Successfully sent sms'
        }
      }
      logger('info', [logPrefix, 'Sent new password on sms to', maskPhoneNumber(user.phoneNumber)], context)
    } catch (error) {
      const { status, jsonBody } = await handleError({ error, jobName: 'sms', logEntry, logEntryId, message: 'Feilet ved sending av sms - vennligst prøv igjen senere', status: 500, logPrefix }, context)
      return { status, jsonBody }
    }

    logger('info', [logPrefix, 'Send sms is okey dokey, saving logEntry'], context)
    try {
      await updateLogEntry(logEntryId, logEntry)
    } catch (error) {
      const { status, jsonBody } = await handleError({ error, jobName: 'updateLogEntry', logEntry, logEntryId, message: 'Feilet ved oppdatering av element i database', status: 500, logPrefix }, context)
      return { status, jsonBody }
    }

    // Lagre et statistikk element for det som går bra
    try {
      await createPwdStat(user.id, logEntryId.toString())
    } catch (error) {
      logger('warn', [logPrefix, 'Aiaiaia, failed when creating statistics element - this one will be lost...', error.response?.data || error.stack || error.toString()], context)
    }

    const response = {
      logEntryId,
      displayName: user.displayName,
      userPrincipalName: user.userPrincipalName,
      maskedPhoneNumber: maskPhoneNumber(user.phoneNumber)
    }

    return { status: 200, jsonBody: response }
  }
})
