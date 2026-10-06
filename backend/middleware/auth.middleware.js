const admin = require('firebase-admin');

let isFirebaseInitialized = false;

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
  // Firebase Admin not initialized → hard reject rather than allowing unauthenticated access.
  // Set FIREBASE_SERVICE_ACCOUNT_BASE64 in the deployment environment to enable auth.
  if (!isFirebaseInitialized) {
    if (process.env.NODE_ENV === 'development') {
      console.warn('[Auth] Mocking Firebase token for local development.');
      return { uid: 'dev-user', email: 'dev@localhost' };
    }
    console.error('[Auth] Firebase Admin not initialized — rejecting request. Set FIREBASE_SERVICE_ACCOUNT_BASE64.');
    const err = new Error('Service unavailable: authentication not configured.');
    err.status = 503;
    throw err;
  }

  if (!token) {
    if (process.env.NODE_ENV === 'development') {
      console.warn('[Auth] Mocking Firebase token for local development (no token provided).');
      return { uid: 'dev-user', email: 'dev@localhost' };
    }
    const err = new Error('Unauthorized: Missing or invalid token');
    err.status = 401;
    throw err;
  }

  return admin.auth().verifyIdToken(token);
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

module.exports = { requireAuth, getRequestToken, verifyFirebaseToken };
