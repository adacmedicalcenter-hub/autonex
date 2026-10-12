import express from 'express';
import pool from '../database/db.js';
import { verifyToken } from '../middleware/auth.js';

const router = express.Router();

/**
 * Wallet API Routes
 * - Get wallet balance
 * - Add credit (top-up)
 * - Get transaction history
 * - Create reservation
 * - Release reservation
 * - Collect fee
 */

// Get user's wallet
router.get('/wallet', verifyToken, async (req, res) => {
  try {
    const { userId } = req;

    const result = await pool.query(
      'SELECT * FROM wallets WHERE user_id = $1',
      [userId]
    );

    if (result.rows.length === 0) {
      // Initialize wallet if doesn't exist
      const initResult = await pool.query(
        'INSERT INTO wallets (user_id, balance, reserved, available) VALUES ($1, 0, 0, 0) RETURNING *',
        [userId]
      );
      return res.json(initResult.rows[0]);
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching wallet:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get transaction history
router.get('/wallet/transactions', verifyToken, async (req, res) => {
  try {
    const { userId } = req;
    const limit = req.query.limit || 50;

    const result = await pool.query(
      `SELECT * FROM wallet_transactions
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [userId, limit]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching transactions:', error);
    res.status(500).json({ error: error.message });
  }
});

// Add credit (test deposit or payment provider callback)
router.post('/wallet/topup', verifyToken, async (req, res) => {
  try {
    const { userId } = req;
    const { amount, source, transactionId } = req.body;

    // Validate amount
    if (!Number.isInteger(amount) || amount <= 0) {
      return res.status(400).json({
        error: 'Amount must be a positive whole number (FCFA)'
      });
    }

    // Begin transaction
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Update wallet balance
      const walletResult = await client.query(
        'UPDATE wallets SET balance = balance + $1 WHERE user_id = $2 RETURNING *',
        [amount, userId]
      );

      // Record transaction
      await client.query(
        `INSERT INTO wallet_transactions
         (user_id, transaction_type, amount, balance_before, balance_after, source, reference_id, status)
         VALUES ($1, 'topup', $2, $3, $4, $5, $6, 'completed')`,
        [userId, amount, walletResult.rows[0].balance - amount, walletResult.rows[0].balance, source, transactionId]
      );

      await client.query('COMMIT');
      res.json({
        message: 'Credit added successfully',
        wallet: walletResult.rows[0],
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error adding credit:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create reservation (reserve funds for a request)
router.post('/wallet/reserve', verifyToken, async (req, res) => {
  try {
    const { userId } = req;
    const { repairRequestId, amount, reservationType } = req.body;

    // Validate amount
    if (!Number.isInteger(amount) || amount <= 0) {
      return res.status(400).json({
        error: 'Amount must be a positive whole number (FCFA)'
      });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Check wallet balance
      const walletResult = await client.query(
        'SELECT available FROM wallets WHERE user_id = $1',
        [userId]
      );

      if (walletResult.rows.length === 0 || walletResult.rows[0].available < amount) {
        return res.status(400).json({
          error: 'Insufficient funds for reservation'
        });
      }

      // Create reservation
      const reservationResult = await client.query(
        `INSERT INTO reservations
         (user_id, repair_request_id, reservation_type, amount, status)
         VALUES ($1, $2, $3, $4, 'reserved')
         RETURNING *`,
        [userId, repairRequestId, reservationType, amount]
      );

      // Update wallet reserved amount
      await client.query(
        'UPDATE wallets SET reserved = reserved + $1 WHERE user_id = $2',
        [amount, userId]
      );

      // Record transaction
      await client.query(
        `INSERT INTO wallet_transactions
         (user_id, transaction_type, amount, source, reference_id, status, description)
         VALUES ($1, 'reservation', $2, 'internal', $3, 'completed', $4)`,
        [userId, -amount, repairRequestId, `Reservation for request ${repairRequestId}`]
      );

      await client.query('COMMIT');
      res.json({
        message: 'Funds reserved successfully',
        reservation: reservationResult.rows[0],
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error creating reservation:', error);
    res.status(500).json({ error: error.message });
  }
});

// Release reservation (cancel request, refund reserved funds)
router.post('/wallet/release', verifyToken, async (req, res) => {
  try {
    const { userId } = req;
    const { reservationId, reason } = req.body;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Get reservation
      const reservationResult = await client.query(
        'SELECT * FROM reservations WHERE id = $1 AND user_id = $2',
        [reservationId, userId]
      );

      if (reservationResult.rows.length === 0) {
        return res.status(404).json({ error: 'Reservation not found' });
      }

      const reservation = reservationResult.rows[0];

      // Update reservation status
      await client.query(
        'UPDATE reservations SET status = $1, released_at = CURRENT_TIMESTAMP, release_reason = $2 WHERE id = $3',
        ['released', reason, reservationId]
      );

      // Update wallet (return to available)
      await client.query(
        'UPDATE wallets SET reserved = reserved - $1 WHERE user_id = $2',
        [reservation.amount, userId]
      );

      // Record transaction
      await client.query(
        `INSERT INTO wallet_transactions
         (user_id, transaction_type, amount, source, reference_id, status, description)
         VALUES ($1, 'reservation_release', $2, 'internal', $3, 'completed', $4)`,
        [userId, reservation.amount, reservationId, `Reservation released - ${reason}`]
      );

      await client.query('COMMIT');
      res.json({
        message: 'Reservation released successfully',
        reservation,
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error releasing reservation:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
