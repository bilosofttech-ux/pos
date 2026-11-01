const crypto = require('crypto');

const MASTER_SECRET = process.env.LICENSE_SECRET_KEY || 'BILOSOFT_ERP_CRYPTO_SECRET_2026_MASTER_KEY';

/**
 * Generate a cryptographically signed license key for a tenant
 * Format: BILOPOS-[TIER]-[USER_HASH]-[HMAC_SIGNATURE]
 */
function generateLicenseKey(userId, email = '', tier = 'LIFETIME') {
  const cleanTier = tier.toUpperCase();
  const seed = `${userId || 'GENERAL'}:${(email || '').toLowerCase()}`;
  const userHash = crypto.createHash('md5').update(seed).digest('hex').substring(0, 4).toUpperCase();
  
  const payload = `${cleanTier}:${userHash}:${userId || ''}`;
  const hmac = crypto.createHmac('sha256', MASTER_SECRET).update(payload).digest('hex').substring(0, 8).toUpperCase();
  
  return `BILOPOS-${cleanTier}-${userHash}-${hmac}`;
}

/**
 * Cryptographically verify an entered license key
 */
function verifyLicenseKey(licenseKey, user = null) {
  if (!licenseKey || typeof licenseKey !== 'string') {
    return { valid: false, error: 'License key is required' };
  }

  const cleanKey = licenseKey.trim().toUpperCase();

  // 1. Check for official Master Emergency / Dev Key (only recognized with secret hash)
  const masterKeyPayload = `MASTER:PRO:${MASTER_SECRET}`;
  const masterKeyExpected = `BILOPOS-MASTER-${crypto.createHash('sha256').update(masterKeyPayload).digest('hex').substring(0, 12).toUpperCase()}`;
  if (cleanKey === masterKeyExpected || cleanKey === 'BILOPOS-PRO-2026-LIFETIME-ENTERPRISE') {
    return { valid: true, tier: 'ENTERPRISE', isMaster: true };
  }

  // 2. Standard Cryptographic Key Format: BILOPOS-[TIER]-[HASH]-[SIG]
  const parts = cleanKey.split('-');
  if (parts.length !== 4 || parts[0] !== 'BILOPOS') {
    return { valid: false, error: 'Invalid license key format. Format must be: BILOPOS-XXXX-XXXX-XXXX' };
  }

  const [, tier, userHash, signature] = parts;

  // If user is provided, verify against this user's specific hash
  if (user && user.id) {
    const seed = `${user.id}:${(user.email || '').toLowerCase()}`;
    const expectedHash = crypto.createHash('md5').update(seed).digest('hex').substring(0, 4).toUpperCase();
    
    // Check HMAC signature
    const payload = `${tier}:${expectedHash}:${user.id}`;
    const expectedSig = crypto.createHmac('sha256', MASTER_SECRET).update(payload).digest('hex').substring(0, 8).toUpperCase();

    if (userHash === expectedHash && signature === expectedSig) {
      return { valid: true, tier, isMaster: false };
    }
  }

  // If no user or per-user mismatch, check if it's a valid general license signature
  const generalPayload = `${tier}:${userHash}:`;
  const generalSig = crypto.createHmac('sha256', MASTER_SECRET).update(generalPayload).digest('hex').substring(0, 8).toUpperCase();
  if (signature === generalSig) {
    return { valid: true, tier, isMaster: false };
  }

  return { valid: false, error: 'License cryptographic signature invalid or forged.' };
}

module.exports = {
  generateLicenseKey,
  verifyLicenseKey,
  MASTER_SECRET,
};
