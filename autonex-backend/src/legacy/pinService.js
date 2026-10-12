/**
 * PIN Service
 * Handles generation, validation, and management of arrival verification PINs
 */

import pool from '../database/db.js';

const PIN_LENGTH = 4;
const PIN_MAX_ATTEMPTS = 3;
const PIN_EXPIRY_MINUTES = 30; // PIN valid for 30 minutes

/**
 * Generate a random 4-digit PIN
 * @returns {string} A 4-digit PIN like "1234"
 */
export function generatePin() {
  const min = 1000;
  const max = 9999;
  return String(Math.floor(Math.random() * (max - min + 1)) + min);
}

/**
 * Create and store a PIN for a journey
 * @param {number} journeyId - The journey ID
 * @param {number} userId - The user ID (driver or mechanic)
 * @param {string} userType - 'driver' or 'mechanic'
 * @returns {Promise<string>} The generated PIN
 */
export async function createJourneyPin(journeyId, userId, userType) {
  try {
    const pin = generatePin();

    // Store PIN in a journey_pins table
    await pool.query(
      `INSERT INTO journey_pins (journey_id, user_id, user_type, pin, expires_at)
       VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP + INTERVAL '${PIN_EXPIRY_MINUTES} minutes')
       ON CONFLICT (journey_id, user_type)
       DO UPDATE SET pin = $4, expires_at = CURRENT_TIMESTAMP + INTERVAL '${PIN_EXPIRY_MINUTES} minutes',
                    attempt_count = 0, status = 'active'`,
      [journeyId, userId, userType, pin]
    );

    console.log(`[PIN Service] Generated PIN for journey ${journeyId} (${userType}): ${pin}`);
    return pin;
  } catch (error) {
    console.error(`[PIN Service] Error creating PIN for journey ${journeyId}:`, error);
    throw error;
  }
}

/**
 * Verify a PIN for a journey
 * @param {number} journeyId - The journey ID
 * @param {string} userType - 'driver' or 'mechanic'
 * @param {string} pin - The PIN to verify
 * @returns {Promise<{isValid: boolean, message: string, attemptsRemaining: number}>}
 */
export async function verifyPin(journeyId, userType, pin) {
  try {
    // Get the PIN record
    const result = await pool.query(
      `SELECT id, pin, attempt_count, expires_at, status
       FROM journey_pins
       WHERE journey_id = $1 AND user_type = $2`,
      [journeyId, userType]
    );

    if (result.rows.length === 0) {
      return {
        isValid: false,
        message: 'No PIN found for this journey',
        attemptsRemaining: 0,
      };
    }

    const pinRecord = result.rows[0];

    // Check if PIN has expired
    if (new Date(pinRecord.expires_at) < new Date()) {
      await pool.query(
        `UPDATE journey_pins
         SET status = 'expired'
         WHERE id = $1`,
        [pinRecord.id]
      );
      return {
        isValid: false,
        message: 'PIN has expired',
        attemptsRemaining: 0,
      };
    }

    // Check if already verified
    if (pinRecord.status === 'verified') {
      return {
        isValid: true,
        message: 'PIN already verified for this journey',
        attemptsRemaining: PIN_MAX_ATTEMPTS - pinRecord.attempt_count,
      };
    }

    // Check attempts
    if (pinRecord.attempt_count >= PIN_MAX_ATTEMPTS) {
      await pool.query(
        `UPDATE journey_pins
         SET status = 'blocked'
         WHERE id = $1`,
        [pinRecord.id]
      );
      return {
        isValid: false,
        message: 'Maximum PIN attempts exceeded',
        attemptsRemaining: 0,
      };
    }

    // Verify PIN
    const isValid = pin === pinRecord.pin;

    if (isValid) {
      // Mark PIN as verified
      await pool.query(
        `UPDATE journey_pins
         SET status = 'verified', verified_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [pinRecord.id]
      );

      console.log(`[PIN Service] PIN verified for journey ${journeyId} (${userType})`);
      return {
        isValid: true,
        message: 'PIN verified successfully',
        attemptsRemaining: PIN_MAX_ATTEMPTS - (pinRecord.attempt_count + 1),
      };
    } else {
      // Increment attempt count
      const newAttemptCount = pinRecord.attempt_count + 1;
      await pool.query(
        `UPDATE journey_pins
         SET attempt_count = $1
         WHERE id = $2`,
        [newAttemptCount, pinRecord.id]
      );

      const attemptsRemaining = PIN_MAX_ATTEMPTS - newAttemptCount;
      console.log(`[PIN Service] Invalid PIN for journey ${journeyId} (${userType}). Attempts remaining: ${attemptsRemaining}`);

      return {
        isValid: false,
        message: `Invalid PIN. ${attemptsRemaining} attempts remaining`,
        attemptsRemaining,
      };
    }
  } catch (error) {
    console.error(`[PIN Service] Error verifying PIN for journey ${journeyId}:`, error);
    throw error;
  }
}

/**
 * Get PIN details for a journey (for admin/debugging purposes only)
 * @param {number} journeyId - The journey ID
 * @returns {Promise<{pin: string, status: string, attemptsRemaining: number}>}
 */
export async function getJourneyPinStatus(journeyId) {
  try {
    const result = await pool.query(
      `SELECT pin, status, attempt_count, expires_at
       FROM journey_pins
       WHERE journey_id = $1`,
      [journeyId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const pinRecord = result.rows[0];
    return {
      pin: pinRecord.pin,
      status: pinRecord.status,
      attemptsRemaining: PIN_MAX_ATTEMPTS - pinRecord.attempt_count,
      expiresAt: pinRecord.expires_at,
    };
  } catch (error) {
    console.error(`[PIN Service] Error getting PIN status for journey ${journeyId}:`, error);
    throw error;
  }
}

/**
 * Cleanup expired PINs (should be run periodically)
 */
export async function cleanupExpiredPins() {
  try {
    const result = await pool.query(
      `DELETE FROM journey_pins
       WHERE expires_at < CURRENT_TIMESTAMP - INTERVAL '1 hour'
       RETURNING id`
    );

    if (result.rows.length > 0) {
      console.log(`[PIN Service] Cleaned up ${result.rows.length} expired PINs`);
    }

    return result.rows;
  } catch (error) {
    console.error('[PIN Service] Error cleaning up expired PINs:', error);
    throw error;
  }
}
