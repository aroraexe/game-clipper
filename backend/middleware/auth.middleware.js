const admin = require('firebase-admin');

let isFirebaseInitialized = false;

/*
 * Dev-auth bypass — DANGEROUS, opt-in only.
 *
 * Previously the mock branches below keyed off NODE_ENV === 'development' alone.
 * .env.example ships NODE_ENV=development, so a deploy target that copied it (or
 * set that var on Railway out of habit) silently accepted EVERY request as
 * `dev-user` with no token at all. Authentication was not merely weakened there,
 * it was absent.
 *
 * The bypass now requires an explicit second opt-in and refuses to engage in
 * production no matter what is set.
 */
const DEV_AUTH_ENABLED =
  process.env.NODE_ENV !== 'production' && process.env.ALLOW_DEV_AUTH === 'true';

const MOCK_USER = { uid: 'dev-user', email: 'dev@localhost' };

// Initialize Firebase Admin only once
try {
  // Option 1: Using a service account file
  // const serviceAccount = require('../../serviceAccountKey.json');
  // admin.initializeApp({
  //   credential: admin.credential.cert(serviceAccount)
  // });

  // Option 2: Using environment variables (recommended for production)
  // Set FIREBASE_SERVICE_ACCOUNT_BASE64 in your .env
  if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
    const serviceAccount = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString());
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    isFirebaseInitialized = true;
  } else {
    console.warn("⚠️ Firebase Admin not initialized. Missing FIREBASE_SERVICE_ACCOUNT_BASE64 env var.");
  }
} catch (error) {
  console.error("Firebase Admin initialization error:", error);
}

async function verifyFirebaseToken(token) {
  // Single source of truth — DEV_AUTH_ENABLED above already encodes
  // "double opt-in: NODE_ENV !== production AND ALLOW_DEV_AUTH === 'true'".
  // Do not recompute the condition here; two copies of an auth guard is how it
  // silently gets disabled later.
  const allowDevAuth = DEV_AUTH_ENABLED;

  if (!isFirebaseInitialized) {
    if (allowDevAuth) {
      console.warn('[Auth] Mocking Firebase token for local development.');
      return { ...MOCK_USER };
    }
    // Do NOT process.exit() here. This function runs inside request handlers, so
    // exiting would let the first anonymous request kill the whole process —
    // turning a config mistake into a self-inflicted DoS. Throw instead; the
    // loud startup warning lives in authPreflight(), which server.js calls once.
    const err = new Error(
      'Service unavailable: authentication not configured. ' +
      'Set FIREBASE_SERVICE_ACCOUNT_BASE64, or set ALLOW_DEV_AUTH=true for local development.'
    );
    err.status = 503;
    throw err;
  }

  if (!token) {
    if (allowDevAuth) {
      console.warn('[Auth] Mocking Firebase token for local development (no token provided).');
      return { ...MOCK_USER };
    }
    const err = new Error('Unauthorized: Missing or invalid token');
    err.status = 401;
    throw err;
  }

  return admin.auth().verifyIdToken(token);
}

/**
 * Boot-time preflight, called once from server.js start(). Reports
 * configuration that would leave the deployment serving unauthenticated
 * traffic or crash on the first request. Returns an array of problems
 * (empty means good to go) so the caller decides whether to exit.
 */
function authPreflight() {
  const problems = [];
  const isProd = process.env.NODE_ENV === 'production';

  if (isProd) {
    if (!isFirebaseInitialized)
      problems.push('FIREBASE_SERVICE_ACCOUNT_BASE64 is not set — every authenticated route will 503.');
    if (process.env.ALLOW_DEV_AUTH)
      problems.push('ALLOW_DEV_AUTH is set in production — remove it.');
    if (!process.env.OUTPUT_URL_SECRET)
      problems.push('OUTPUT_URL_SECRET is not set — completed videos would be signed with an insecure default.');

    // Narration is the product. Catch an unusable TTS configuration at boot
    // rather than failing every render after a customer has already paid.
    const tts = require('../services/tts.service');
    const ttsCfg = tts.describeConfig();
    if (ttsCfg.error) {
      problems.push(`TTS is not usable: ${ttsCfg.error}`);
    } else if (ttsCfg.provider === 'edge') {
      problems.push('TTS_PROVIDER=edge in production — Microsoft Edge read-aloud is unlicensed for commercial use.');
    } else if (!process.env.OPENAI_API_KEY) {
      problems.push('TTS_PROVIDER is openai (the default) but OPENAI_API_KEY is not set — every render would fail.');
    }
  } else if (!isFirebaseInitialized && process.env.ALLOW_DEV_AUTH !== 'true') {
    problems.push(
      'Firebase Admin is not initialized and ALLOW_DEV_AUTH is not set, so authenticated routes will 503. ' +
      'Set ALLOW_DEV_AUTH=true in .env for local development.'
    );
  }

  return problems;
}

function getRequestToken(req) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.split('Bearer ')[1];
  }
  return req.cookies?.sessionToken || null;
}

const requireAuth = async (req, res, next) => {
  try {
    req.user = await verifyFirebaseToken(getRequestToken(req));
    next();
  } catch (error) {
    console.error('Error verifying auth token:', error);
    return res.status(error.status || 401).json({ error: error.status ? error.message : 'Unauthorized: Invalid token' });
  }
};

module.exports = { requireAuth, getRequestToken, verifyFirebaseToken, authPreflight, DEV_AUTH_ENABLED };
