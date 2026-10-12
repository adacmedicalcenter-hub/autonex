import express from 'express';
import pool from '../database/db.js';
import { verifyToken } from '../middleware/auth.js';
import { getTimeoutStatus } from '../services/journeyTimeoutService.js';
import { createJourneyPin, verifyPin } from '../services/pinService.js';
import { reserveFee, collectFees, releaseFee, getFeeConfig } from '../services/feeService.js';

const router = express.Router();

const ARRIVAL_RADIUS_METERS = 50; // Configurable
const ACCURACY_THRESHOLD_METERS = 30; // Configurable
const DWELL_TIME_SECONDS = 10; // Configurable
const PIN_MAX_ATTEMPTS = 3;
const PIN_EXPIRY_MINUTES = 15;

/**
 * Journey API Routes
 * - Create journey (driver accepts mechanic)
 * - Get active journeys
 * - Report location (GPS tracking)
 * - Verify arrival (with GPS + PIN)
 * - Collect fees
 * - Complete or cancel journey
 */

// Create journey (when driver selects a mechanic)
router.post('/journeys', verifyToken, async (req, res) => {
  try {
    const { userId, userType } = req;
    const { repairRequestId, driverId, mechanicId } = req.body;

    if (userType !== 'driver') {
      return res.status(403).json({ error: 'Only drivers can create journeys' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Get fee configuration
      const feeConfig = await getFeeConfig();

      // Reserve driver connection fee
      const feeReservation = await reserveFee(
        driverId,
        repairRequestId,
        'connection_fee_driver',
        feeConfig.driverFee,
        client
      );

      if (!feeReservation.success) {
        await client.query('ROLLBACK');
        return res.status(402).json({
          error: 'Fee reservation failed',
          details: feeReservation.error,
          required: feeReservation.required,
          available: feeReservation.available
        });
      }

      // Create journey
      const journeyResult = await client.query(
        `INSERT INTO journeys (repair_request_id, driver_id, mechanic_id, status)
         VALUES ($1, $2, $3, 'active')
         RETURNING *`,
        [repairRequestId, driverId, mechanicId]
      );

      const journey = journeyResult.rows[0];

      // Update repair request status
      await client.query(
        'UPDATE repair_requests SET status = $1 WHERE id = $2',
        ['accepted', repairRequestId]
      );

      await client.query('COMMIT');

      // Generate PINs for both driver and mechanic (outside of transaction)
      // Do this after committing so journey exists in DB
      try {
        await createJourneyPin(journey.id, driverId, 'driver');
        await createJourneyPin(journey.id, mechanicId, 'mechanic');
        console.log(`[Journeys] Generated arrival PINs for journey ${journey.id}`);
      } catch (pinError) {
        console.error(`[Journeys] Error generating PINs for journey ${journey.id}:`, pinError);
        // Don't fail the journey creation if PIN generation fails
        // PINs can be generated later
      }

      res.json({
        message: 'Journey created successfully',
        journey,
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error creating journey:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get active journeys for user
router.get('/journeys/active', verifyToken, async (req, res) => {
  try {
    const { userId, userType } = req;

    let query = '';
    let params = [userId];

    if (userType === 'driver') {
      query = `SELECT j.*, u.full_name as mechanic_name
               FROM journeys j
               JOIN users u ON j.mechanic_id = u.id
               WHERE j.driver_id = $1 AND j.status = 'active'`;
    } else {
      query = `SELECT j.*, u.full_name as driver_name
               FROM journeys j
               JOIN users u ON j.driver_id = u.id
               WHERE j.mechanic_id = $1 AND j.status = 'active'`;
    }

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching journeys:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get single journey with timeout status
router.get('/journeys/:journeyId', verifyToken, async (req, res) => {
  try {
    const { journeyId } = req.params;

    const result = await pool.query(
      `SELECT j.*,
              d.full_name as driver_name,
              m.full_name as mechanic_name
       FROM journeys j
       JOIN users d ON j.driver_id = d.id
       JOIN users m ON j.mechanic_id = m.id
       WHERE j.id = $1`,
      [journeyId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Journey not found' });
    }

    const journey = result.rows[0];
    const timeoutStatus = getTimeoutStatus(journey);

    res.json({
      ...journey,
      timeout: timeoutStatus
    });
  } catch (error) {
    console.error('Error fetching journey:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get arrival PIN for current user in a journey
router.get('/journeys/:journeyId/pin', verifyToken, async (req, res) => {
  try {
    const { journeyId } = req.params;
    const { userId, userType } = req;

    // Verify user is part of this journey
    const journeyResult = await pool.query(
      'SELECT driver_id, mechanic_id FROM journeys WHERE id = $1',
      [journeyId]
    );

    if (journeyResult.rows.length === 0) {
      return res.status(404).json({ error: 'Journey not found' });
    }

    const journey = journeyResult.rows[0];
    const isDriver = userType === 'driver' && userId === journey.driver_id;
    const isMechanic = userType === 'mechanic' && userId === journey.mechanic_id;

    if (!isDriver && !isMechanic) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    // Get PIN for this user
    const pinResult = await pool.query(
      `SELECT pin, status, attempt_count, expires_at
       FROM journey_pins
       WHERE journey_id = $1 AND user_type = $2`,
      [journeyId, userType]
    );

    if (pinResult.rows.length === 0) {
      return res.status(404).json({ error: 'PIN not found. Please wait for PIN generation.' });
    }

    const pinRecord = pinResult.rows[0];

    // Check if PIN has expired
    if (new Date(pinRecord.expires_at) < new Date()) {
      return res.status(410).json({ error: 'PIN has expired' });
    }

    // Return PIN and status
    res.json({
      pin: pinRecord.pin,
      status: pinRecord.status,
      attemptsRemaining: 3 - pinRecord.attempt_count,
      expiresAt: pinRecord.expires_at,
    });
  } catch (error) {
    console.error('Error fetching PIN:', error);
    res.status(500).json({ error: error.message });
  }
});

// Report location for tracking
router.post('/journeys/:journeyId/location', verifyToken, async (req, res) => {
  try {
    const { userId } = req;
    const { journeyId } = req.params;
    const { latitude, longitude, accuracy, altitude, heading, speed } = req.body;

    // Store location
    await pool.query(
      `INSERT INTO location_tracking
       (user_id, journey_id, latitude, longitude, accuracy, altitude, heading, speed)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [userId, journeyId, latitude, longitude, accuracy, altitude, heading, speed]
    );

    res.json({ message: 'Location recorded' });
  } catch (error) {
    console.error('Error recording location:', error);
    res.status(500).json({ error: error.message });
  }
});

// Verify arrival (with GPS coordinates and PIN)
router.post('/journeys/:journeyId/verify-arrival', verifyToken, async (req, res) => {
  try {
    const { userId, userType } = req;
    const { journeyId } = req.params;
    const { latitude, longitude, accuracy, pin } = req.body;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Get journey
      const journeyResult = await client.query(
        'SELECT * FROM journeys WHERE id = $1',
        [journeyId]
      );

      if (journeyResult.rows.length === 0) {
        return res.status(404).json({ error: 'Journey not found' });
      }

      const journey = journeyResult.rows[0];

      // Determine if driver or mechanic
      const isDriver = userType === 'driver' && userId === journey.driver_id;
      const isMechanic = userType === 'mechanic' && userId === journey.mechanic_id;

      if (!isDriver && !isMechanic) {
        return res.status(403).json({ error: 'Unauthorized' });
      }

      // Get repair request for destination
      const requestResult = await client.query(
        'SELECT latitude, longitude FROM repair_requests WHERE id = $1',
        [journey.repair_request_id]
      );

      const destination = requestResult.rows[0];

      // Calculate distance
      const distance = calculateDistance(
        latitude, longitude,
        destination.latitude, destination.longitude
      );

      // Check if within arrival radius
      const isWithinRadius = distance <= ARRIVAL_RADIUS_METERS;
      const accuracyAcceptable = accuracy <= ACCURACY_THRESHOLD_METERS;

      // Check if within arrival radius
      if (!isWithinRadius || !accuracyAcceptable) {
        // Store failed verification attempt
        await client.query(
          `INSERT INTO arrival_verifications
           (journey_id, user_id, user_type, attempt_number, latitude, longitude,
            accuracy, distance_from_destination, is_within_radius, arrival_pin, pin_correct, status)
           VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [journeyId, userId, userType, latitude, longitude, accuracy, distance,
           isWithinRadius, pin, false, 'failed']
        );

        await client.query('COMMIT');
        return res.json({
          verified: false,
          reason: isWithinRadius ? 'accuracy_insufficient' : 'not_within_radius',
          distance: Math.round(distance),
          accuracy: Math.round(accuracy),
          requiredRadius: ARRIVAL_RADIUS_METERS,
          accuracyThreshold: ACCURACY_THRESHOLD_METERS,
        });
      }

      // PIN verification with real PIN service
      const pinVerification = await verifyPin(journeyId, userType, pin);

      // Store verification attempt
      await client.query(
        `INSERT INTO arrival_verifications
         (journey_id, user_id, user_type, attempt_number, latitude, longitude,
          accuracy, distance_from_destination, is_within_radius, arrival_pin, pin_correct, status)
         VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [journeyId, userId, userType, latitude, longitude, accuracy, distance,
         isWithinRadius, pin, pinVerification.isValid,
         pinVerification.isValid ? 'verified' : 'failed']
      );

      // If PIN is not valid, return early
      if (!pinVerification.isValid) {
        await client.query('COMMIT');
        return res.json({
          verified: false,
          reason: 'invalid_pin',
          message: pinVerification.message,
          attemptsRemaining: pinVerification.attemptsRemaining,
        });
      }

      // Update journey with arrival info
      const arrivalColumn = isDriver ? 'driver_arrival' : 'mechanic_arrival';
      await client.query(
        `UPDATE journeys
         SET ${arrivalColumn}_latitude = $1,
             ${arrivalColumn}_longitude = $2,
             ${arrivalColumn}_time = CURRENT_TIMESTAMP,
             ${arrivalColumn}_pin = $3
         WHERE id = $4`,
        [latitude, longitude, pin, journeyId]
      );

      // Check if both have arrived
      const updatedJourney = await client.query(
        'SELECT * FROM journeys WHERE id = $1',
        [journeyId]
      );

      const journeyData = updatedJourney.rows[0];
      let feeCollectionResult = null;

      if (journeyData.driver_arrival_time && journeyData.mechanic_arrival_time) {
        await client.query(
          'UPDATE journeys SET status = $1 WHERE id = $2',
          ['both_arrived', journeyId]
        );

        // Collect fees when both have arrived and verified
        feeCollectionResult = await collectFees(journeyId, journey.driver_id, journey.mechanic_id, client);

        if (!feeCollectionResult.success) {
          console.error('Error collecting fees:', feeCollectionResult.error);
          // Don't fail the arrival verification if fees can't be collected yet
          // Fees can be collected later when both conditions are met
        } else {
          console.log(`[Journeys] Fees collected for journey ${journeyId}:`, feeCollectionResult);
        }
      }

      await client.query('COMMIT');

      res.json({
        verified: true,
        message: 'Arrival verified successfully',
        distance: Math.round(distance),
        accuracy: Math.round(accuracy),
        feesCollected: feeCollectionResult?.success || false,
        feeDetails: feeCollectionResult?.success ? {
          driverFee: feeCollectionResult.driverFeeCollected,
          mechanicFee: feeCollectionResult.mechanicFeeCollected,
          total: feeCollectionResult.totalCollected
        } : null
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error verifying arrival:', error);
    res.status(500).json({ error: error.message });
  }
});

// Complete journey
router.post('/journeys/:journeyId/complete', verifyToken, async (req, res) => {
  try {
    const { userId, userType } = req;
    const { journeyId } = req.params;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Get journey
      const journeyResult = await pool.query(
        'SELECT * FROM journeys WHERE id = $1',
        [journeyId]
      );

      if (journeyResult.rows.length === 0) {
        return res.status(404).json({ error: 'Journey not found' });
      }

      const journey = journeyResult.rows[0];

      // Update journey status
      await client.query(
        'UPDATE journeys SET status = $1, completed_at = CURRENT_TIMESTAMP WHERE id = $2',
        ['completed', journeyId]
      );

      // Update repair request
      await client.query(
        'UPDATE repair_requests SET status = $1 WHERE id = $2',
        ['completed', journey.repair_request_id]
      );

      await client.query('COMMIT');

      res.json({
        message: 'Journey completed successfully',
        journey,
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error completing journey:', error);
    res.status(500).json({ error: error.message });
  }
});

// Cancel journey
router.post('/journeys/:journeyId/cancel', verifyToken, async (req, res) => {
  try {
    const { userId, userType } = req;
    const { journeyId } = req.params;
    const { reason } = req.body;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Get journey
      const journeyResult = await client.query(
        'SELECT * FROM journeys WHERE id = $1',
        [journeyId]
      );

      if (journeyResult.rows.length === 0) {
        return res.status(404).json({ error: 'Journey not found' });
      }

      const journey = journeyResult.rows[0];

      // Update journey
      await client.query(
        `UPDATE journeys
         SET status = $1, cancelled_at = CURRENT_TIMESTAMP, cancelled_by = $2, cancellation_reason = $3
         WHERE id = $4`,
        ['cancelled', userType, reason, journeyId]
      );

      // Update repair request
      await client.query(
        'UPDATE repair_requests SET status = $1 WHERE id = $2',
        ['cancelled', journey.repair_request_id]
      );

      // Release fee reservations
      const reservations = await client.query(
        'SELECT id FROM reservations WHERE repair_request_id = $1 AND status = $2',
        [journey.repair_request_id, 'reserved']
      );

      for (const reservation of reservations.rows) {
        await releaseFee(reservation.id, `Journey cancelled by ${userType}: ${reason}`, client);
      }

      await client.query('COMMIT');

      res.json({
        message: 'Journey cancelled successfully',
        journey,
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error cancelling journey:', error);
    res.status(500).json({ error: error.message });
  }
});

// Helper: Calculate distance between two coordinates
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // Earth radius in meters
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;

  const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
            Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

export default router;
