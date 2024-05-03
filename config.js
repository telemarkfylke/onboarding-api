module.exports = {
  NODE_ENV: process.env.NODE_ENV || 'production',
  MONGODB: {
    CONNECTION_STRING: process.env.MONGODB_CONNECTION_STRING,
    DB_NAME: process.env.MONGODB_DB_NAME
  },
  APPREG: {
    CLIENT_ID: process.env.APPREG_CLIENT_ID,
    CLIENT_SECRET: process.env.APPREG_CLIENT_SECRET,
    TENANT_ID: process.env.APPREG_TENANT_ID
  },
  AUTHENTICATION_ADMINISTRATOR: {
    USERNAME: process.env.AUTHENTICATION_ADMINISTRATOR_USERNAME,
    PASSWORD: process.env.AUTHENTICATION_ADMINISTRATOR_PASSWORD,
    SCOPE: process.env.AUTHENTICATION_ADMINISTRATOR_SCOPE
  },
  GRAPH: {
    SSN_EXTENSION_ATTRIBUTE: process.env.GRAPH_SSN_EXTENSION_ATTRIBUTE,
    SCOPE: process.env.GRAPH_SCOPE || 'https://graph.microsoft.com/.default',
    URL: process.env.GRAPH_URL || 'https://graph.microsoft.com'
  },
  IDPORTEN: {
    CLIENT_ID: process.env.IDPORTEN_CLIENT_ID,
    ClIENT_SECRET: process.env.IDPORTEN_CLIENT_SECRET,
    ClIENT_REDIRECT_URI: process.env.IDPORTEN_CLIENT_REDIRECT_URI,
    WELL_KNOWN_ENDPOINT: process.env.IDPORTEN_WELL_KNOWN_ENDPOINT
  },
  KRR: {
    URL: process.env.KRR_URL,
    KEY: process.env.KRR_KEY
  },
  SMS: {
    URL: process.env.SMS_URL,
    KEY: process.env.SMS_KEY,
    SENDER: process.env.SMS_SENDER
  },
  DEMO_MODE: {
    ENABLED: (process.env.DEMO_MODE_ENABLED && process.env.DEMO_MODE_ENABLED === 'true') || false,
    SSN: process.env.DEMO_MODE_SSN,
    UPN: process.env.DEMO_MODE_UPN,
    PHONE_NUMBER: process.env.DEMO_MODE_PHONE_NUMBER,
    MOCK_RESET_PASSWORD: (process.env.DEMO_MODE_MOCK_RESET_PASSWORD && process.env.DEMO_MODE_MOCK_RESET_PASSWORD === 'true') || false
  }
}