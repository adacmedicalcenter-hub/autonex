/**
 * Journey Timeout Service
 * Handles automatic timeout and cancellation of stalled journeys
 */

import pool from '../database/db.js';

// Maximum journey duration: 4 hours (14400 seconds)
const JOURNEY_MAX_DURATION_MINUTES = 240;

// Maximum inactivity: 30 minutes without updates
const JOURNEY_INACTIVITY_TIMEOUT_MINUTES = 30;

/**
 * Check and handle stalled journeys
 * - Journeys running longer than 4 hours
 * - Journeys with no updates for 30 minutes
 */
export async function checkAndTimeoutJourneys() {
  try {
    const maxDurationTime = new Date(Date.now() - JOURNEY_MAX_DURATION_MINUTES * 60 * 1000);
    const inactivityTime = new Date(Date.now() - JOURNEY_INACTIVITY_TIMEOUT_MINUTES * 60 * 1000);

    // Find stalled journeys
    const stalledJourneys = await pool.query(
      `SELECT * FROM journeys
       WHERE status IN ('accepted', 'in_progress', 'waiting_for_mechanic', 'waiting_for_driver')
       AND (
         created_at < $1
         OR (updated_at < $2 AND status NOT IN ('completed', 'cancelled'))
       )`,
      [maxDurationTime, inactivityTime]
    );

    if (stalledJourneys.rows.length > 0) {
      console.log(`[Journey Timeout] Found ${stalledJourneys.rows.length} stalled journeys to process`);

      for (const journey of stalledJourneys.rows) {
        const reason = journey.created_at < maxDurationTime
          ? 'Journey exceeded 4-hour maximum duration'
          : 'Journey inactive for 30 minutes';

        await timeoutJourney(journey.id, reason);
      }
    }

    return stalledJourneys.rows;
  } catch (error) {
    console.error('[Journey Timeout] Error checking journeys:', error);
    throw error;
  }
}

/**
 * Timeout a specific journey
 */
async function timeoutJourney(journeyId, reason) {
  try {
    // Get journey details
    const journeyResult = await pool.query(
      'SELECT * FROM journeys WHERE id = $1',
      [journeyId]
    );

    if (journeyResult.rows.length === 0) return;

    const journey = journeyResult.rows[0];

    // Update journey status to 'timeout'
    await pool.query(
      `UPDATE journeys
       SET status = 'timeout',
           timeout_reason = $1,
           timeout_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [reason, journeyId]
    );

    // Release wallet reservations
    if (journey.repair_request_id) {
      const reservations = await pool.query(
        `SELECT * FROM reservations
         WHERE repair_request_id = $1 AND status = 'reserved'`,
        [journey.repair_request_id]
      );

      for (const reservation of reservations.rows) {
        await pool.query(
          `UPDATE reservations
           SET status = 'released', reason = $1 WHERE id = $2`,
          [reason, reservation.id]
        );

        // Refund to wallet
        await pool.query(
          `UPDATE wallets
           SET available = available + $1,
               reserved = reserved - $1
           WHERE user_id = $2`,
          [reservation.amount, reservation.user_id]
        );

        // Log transaction
        await pool.query(
          `INSERT INTO wallet_transactions
           (user_id, transaction_type, amount, description, reference_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [reservation.user_id, 'reservation_release', reservation.amount,
           'Journey timeout: ' + reason, journey.repair_request_id]
        );
      }
    }

    console.log(`[Journey Timeout] Timed out journey ${journeyId}: ${reason}`);
  } catch (error) {
    console.error(`[Journey Timeout] Error timing out journey ${journeyId}:`, error);
    // Don't throw - continue processing other journeys
  }
}

/**
 * Get journey duration
 */
export function getJourneyDuration(createdAt) {
  const createdTime = new Date(createdAt).getTime();
  const durationMs = Date.now() - createdTime;
  return Math.floor(durationMs / 1000); // seconds
}

/**
 * Get journey inactivity time
 */
export function getJourneyInactivity(updatedAt) {
  const updatedTime = new Date(updatedAt).getTime();
  const inactivityMs = Date.now() - updatedTime;
  return Math.floor(inactivityMs / 1000); // seconds
}

/**
 * Get journey timeout status
 */
export function getTimeoutStatus(journey) {
  const duration = getJourneyDuration(journey.created_at);
  const inactivity = getJourneyInactivity(journey.updated_at);

  const maxDurationSeconds = JOURNEY_MAX_DURATION_MINUTES * 60;
  const inactivityLimitSeconds = JOURNEY_INACTIVITY_TIMEOUT_MINUTES * 60;

  return {
    duration, // seconds
    durationMinutes: Math.floor(duration / 60),
    inactivity, // seconds
    inactivityMinutes: Math.floor(inactivity / 60),
    willTimeoutInSecs: Math.max(
      maxDurationSeconds - duration,
      inactivityLimitSeconds - inactivity
    ),
    isAtRisk: duration > maxDurationSeconds * 0.8 || inactivity > inactivityLimitSeconds * 0.8,
    isTimedOut: duration > maxDurationSeconds || inactivity > inactivityLimitSeconds,
    maxDurationMinutes: JOURNEY_MAX_DURATION_MINUTES,
    inactivityLimitMinutes: JOURNEY_INACTIVITY_TIMEOUT_MINUTES,
  };
}

/**
 * Start the automatic journey timeout checker
 * Runs every 5 minutes
 */
export function startTimeoutChecker(intervalSeconds = 300) {
  console.log(`[Journey Timeout] Starting journey timeout checker (interval: ${intervalSeconds}s)`);

  // Run immediately
  checkAndTimeoutJourneys().catch(err =>
    console.error('[Journey Timeout] Initial check failed:', err)
  );

  // Then run periodically
  const interval = setInterval(() => {
    checkAndTimeoutJourneys().catch(err =>
      console.error('[Journey Timeout] Periodic check failed:', err)
    );
  }, intervalSeconds * 1000);

  return interval;
}

/**
 * Stop the journey timeout checker
 */
export function stopTimeoutChecker(interval) {
  if (interval) {
    clearInterval(interval);
    console.log('[Journey Timeout] Timeout checker stopped');
  }
}

/**
 * Manually cancel a journey (for driver or mechanic initiated cancellation)
 */
export async function cancelJourney(journeyId, userId, reason) {
  try {
    // Get journey details
    const journeyResult = await pool.query(
      'SELECT * FROM journeys WHERE id = $1',
      [journeyId]
    );

    if (journeyResult.rows.length === 0) {
      throw new Error('Journey not found');
    }

    const journey = journeyResult.rows[0];

    // Verify user is part of this journey
    if (journey.driver_id !== userId && journey.mechanic_id !== userId) {
      throw new Error('You are not part of this journey');
    }

    // Don't allow cancellation of completed journeys
    if (journey.status === 'completed') {
      throw new Error('Cannot cancel a completed journey');
    }

    // Update journey status
    const userType = journey.driver_id === userId ? 'driver' : 'mechanic';
    await pool.query(
      `UPDATE journeys
       SET status = 'cancelled',
           cancelled_by = $1,
           cancel_reason = $2,
           cancelled_at = CURRENT_TIMESTAMP
       WHERE id = $3`,
      [userType, reason, journeyId]
    );

    // Release wallet reservations
    if (journey.repair_request_id) {
      const reservations = await pool.query(
        `SELECT * FROM reservations
         WHERE repair_request_id = $1 AND status = 'reserved'`,
        [journey.repair_request_id]
      );

      for (const reservation of reservations.rows) {
        await pool.query(
          `UPDATE reservations
           SET status = 'released', reason = $1 WHERE id = $2`,
          [reason, reservation.id]
        );

        // Refund to wallet
        await pool.query(
          `UPDATE wallets
           SET available = available + $1,
               reserved = reserved - $1
           WHERE user_id = $2`,
          [reservation.amount, reservation.user_id]
        );

        // Log transaction
        await pool.query(
          `INSERT INTO wallet_transactions
           (user_id, transaction_type, amount, description, reference_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [reservation.user_id, 'reservation_release', reservation.amount,
           'Journey cancelled: ' + reason, journey.repair_request_id]
        );
      }
    }

    // Update repair request status back to open if it was accepted
    if (journey.repair_request_id) {
      await pool.query(
        `UPDATE repair_requests
         SET status = 'open'
         WHERE id = $1 AND status IN ('accepted', 'in_progress')`,
        [journey.repair_request_id]
      );
    }

    console.log(`[Journey Timeout] Cancelled journey ${journeyId} by ${userType}: ${reason}`);

    return {
      message: 'Journey cancelled successfully',
      journeyId
    };
  } catch (error) {
    console.error(`[Journey Timeout] Error cancelling journey ${journeyId}:`, error);
    throw error;
  }
}
