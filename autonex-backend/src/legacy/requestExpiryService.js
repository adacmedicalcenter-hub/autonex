/**
 * Request Expiry Service
 * Handles automatic expiration of repair requests after 45 minutes
 */

import pool from '../database/db.js';

const REQUEST_EXPIRY_MINUTES = 45;

/**
 * Check and expire old repair requests
 * Runs periodically to mark requests as 'expired' if they haven't been accepted
 */
export async function checkAndExpireRequests() {
  try {
    const expiryTime = new Date(Date.now() - REQUEST_EXPIRY_MINUTES * 60 * 1000);

    // Update requests that are still 'open' and were created more than 45 minutes ago
    const result = await pool.query(
      `UPDATE repair_requests
       SET status = 'expired'
       WHERE status = 'open'
       AND created_at < $1
       AND status != 'expired'
       RETURNING id, driver_id, title, created_at`,
      [expiryTime]
    );

    if (result.rows.length > 0) {
      console.log(`[Request Expiry] Expired ${result.rows.length} requests:`,
        result.rows.map(r => `ID: ${r.id}, Driver: ${r.driver_id}, Title: "${r.title}"`).join('; ')
      );

      // Release any wallet reservations for expired requests
      for (const request of result.rows) {
        await releaseReservationsForExpiredRequest(request.id);
      }
    }

    return result.rows;
  } catch (error) {
    console.error('[Request Expiry] Error checking requests:', error);
    throw error;
  }
}

/**
 * Release wallet reservations for an expired request
 */
async function releaseReservationsForExpiredRequest(repairRequestId) {
  try {
    // Find any active reservations for this request
    const reservations = await pool.query(
      `SELECT id, user_id, amount FROM reservations
       WHERE repair_request_id = $1
       AND status = 'reserved'`,
      [repairRequestId]
    );

    for (const reservation of reservations.rows) {
      // Release the reservation
      await pool.query(
        `UPDATE reservations
         SET status = 'released',
             released_at = CURRENT_TIMESTAMP,
             reason = 'Request expired'
         WHERE id = $1`,
        [reservation.id]
      );

      // Update wallet to reflect released funds
      await pool.query(
        `UPDATE wallets
         SET available = available + $1,
             reserved = reserved - $1
         WHERE user_id = $2`,
        [reservation.amount, reservation.user_id]
      );

      // Log the transaction
      await pool.query(
        `INSERT INTO wallet_transactions
         (user_id, transaction_type, amount, description, reference_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [reservation.user_id, 'reservation_release', reservation.amount,
         'Request expired - funds released', repairRequestId]
      );

      console.log(`[Request Expiry] Released reservation ${reservation.id} for user ${reservation.user_id}, amount: ${reservation.amount}`);
    }
  } catch (error) {
    console.error(`[Request Expiry] Error releasing reservations for request ${repairRequestId}:`, error);
    // Don't throw - continue processing other requests
  }
}

/**
 * Get time remaining for a request (in seconds)
 */
export function getTimeRemaining(createdAt) {
  const createdTime = new Date(createdAt).getTime();
  const expiryTime = createdTime + REQUEST_EXPIRY_MINUTES * 60 * 1000;
  const timeRemaining = Math.max(0, Math.floor((expiryTime - Date.now()) / 1000));
  return timeRemaining;
}

/**
 * Check if a request is expired
 */
export function isRequestExpired(createdAt) {
  return getTimeRemaining(createdAt) <= 0;
}

/**
 * Get request expiry status object
 */
export function getExpiryStatus(request) {
  const timeRemaining = getTimeRemaining(request.created_at);
  const isExpired = timeRemaining <= 0;

  return {
    timeRemaining, // seconds
    isExpired,
    expiresAt: new Date(new Date(request.created_at).getTime() + REQUEST_EXPIRY_MINUTES * 60 * 1000),
    minutesRemaining: Math.ceil(timeRemaining / 60),
  };
}

/**
 * Start the automatic expiry checker
 * Runs every 60 seconds
 */
export function startExpiryChecker(intervalSeconds = 60) {
  console.log(`[Request Expiry] Starting request expiry checker (interval: ${intervalSeconds}s)`);

  // Run immediately
  checkAndExpireRequests().catch(err =>
    console.error('[Request Expiry] Initial check failed:', err)
  );

  // Then run periodically
  const interval = setInterval(() => {
    checkAndExpireRequests().catch(err =>
      console.error('[Request Expiry] Periodic check failed:', err)
    );
  }, intervalSeconds * 1000);

  return interval;
}

/**
 * Stop the automatic expiry checker
 */
export function stopExpiryChecker(interval) {
  if (interval) {
    clearInterval(interval);
    console.log('[Request Expiry] Expiry checker stopped');
  }
}
