const admin = require('firebase-admin');

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
  } else {
    console.warn("⚠️ Firebase Admin not initialized. Missing FIREBASE_SERVICE_ACCOUNT_BASE64 env var.");
  }
} catch (error) {
  console.error("Firebase Admin initialization error:", error);
}

const requireAuth = async (req, res, next) => {
  // Allow bypassing auth in dev if needed, or if Firebase admin isn't set up yet
  if (!admin.apps.length) {
    console.warn("Auth bypassed because Firebase Admin is not initialized.");
    return next(); // For safety, you might want to return 401 here in production.
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing or invalid token' });
  }

  const token = authHeader.split('Bearer ')[1];

  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken;
    next();
  } catch (error) {
    console.error('Error verifying auth token:', error);
    return res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }
};

module.exports = { requireAuth };
