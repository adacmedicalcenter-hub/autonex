import express from 'express';
import pool from '../database/db.js';
import { verifyToken } from '../middleware/auth.js';
import Joi from 'joi';

const router = express.Router();

/**
 * Admin Routes
 * - User management and moderation
 * - Fee configuration
 * - Analytics and reporting
 * - Dispute management
 */

// Middleware to verify admin access
async function verifyAdmin(req, res, next) {
  try {
    const { userId } = req;

    // Check if user is admin (for now, check if user_id is in admin list)
    // In production, add admin role to users table
    const result = await pool.query(
      `SELECT is_admin FROM users WHERE id = $1`,
      [userId]
    );

    if (result.rows.length === 0 || !result.rows[0].is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    next();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

// ============= ANALYTICS ENDPOINTS =============

// Get dashboard analytics
router.get('/admin/analytics/dashboard', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const now = new Date();
    const last30Days = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // Total users
    const usersResult = await pool.query('SELECT COUNT(*) as count FROM users');
    const totalUsers = parseInt(usersResult.rows[0].count);

    // Users by type
    const userTypeResult = await pool.query(
      `SELECT user_type, COUNT(*) as count FROM users GROUP BY user_type`
    );
    const usersByType = userTypeResult.rows.reduce((acc, row) => {
      acc[row.user_type] = parseInt(row.count);
      return acc;
    }, {});

    // Total journeys (last 30 days)
    const journeysResult = await pool.query(
      `SELECT COUNT(*) as count FROM journeys WHERE created_at >= $1`,
      [last30Days]
    );
    const totalJourneys = parseInt(journeysResult.rows[0].count);

    // Completed journeys
    const completedResult = await pool.query(
      `SELECT COUNT(*) as count FROM journeys WHERE status = 'completed' AND created_at >= $1`,
      [last30Days]
    );
    const completedJourneys = parseInt(completedResult.rows[0].count);

    // Total revenue (from completed journeys - based on reservations)
    const revenueResult = await pool.query(
      `SELECT SUM(amount) as total FROM reservations
       WHERE status = 'released' AND released_at >= $1`,
      [last30Days]
    );
    const totalRevenue = parseFloat(revenueResult.rows[0].total || 0);

    // Active requests
    const activeRequestsResult = await pool.query(
      `SELECT COUNT(*) as count FROM repair_requests WHERE status = 'open'`
    );
    const activeRequests = parseInt(activeRequestsResult.rows[0].count);

    // Average rating (if ratings table exists)
    let averageRating = 0;
    try {
      const ratingResult = await pool.query(
        `SELECT AVG(rating) as avg FROM ratings WHERE created_at >= $1`,
        [last30Days]
      );
      averageRating = parseFloat(ratingResult.rows[0].avg || 0).toFixed(1);
    } catch (e) {
      // Ratings table might not exist yet
    }

    res.json({
      totalUsers,
      usersByType,
      totalJourneys,
      completedJourneys,
      completionRate: totalJourneys > 0 ? ((completedJourneys / totalJourneys) * 100).toFixed(1) : 0,
      totalRevenue,
      activeRequests,
      averageRating,
      period: 'Last 30 days'
    });
  } catch (error) {
    console.error('[Admin] Analytics error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get journey analytics
router.get('/admin/analytics/journeys', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // Journeys by status
    const statusResult = await pool.query(
      `SELECT status, COUNT(*) as count FROM journeys
       WHERE created_at >= $1 GROUP BY status`,
      [startDate]
    );

    // Journeys over time
    const timeResult = await pool.query(
      `SELECT DATE(created_at) as date, COUNT(*) as count,
              SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed
       FROM journeys WHERE created_at >= $1
       GROUP BY DATE(created_at) ORDER BY date DESC`,
      [startDate]
    );

    // Average journey duration (for completed ones)
    const durationResult = await pool.query(
      `SELECT AVG(EXTRACT(EPOCH FROM (completed_at - created_at))) as avg_seconds
       FROM journeys WHERE status = 'completed' AND completed_at IS NOT NULL
       AND created_at >= $1`,
      [startDate]
    );

    const avgDuration = durationResult.rows[0].avg_seconds
      ? Math.round(durationResult.rows[0].avg_seconds / 60)
      : 0;

    res.json({
      statusDistribution: statusResult.rows,
      timeSeriesData: timeResult.rows,
      averageDurationMinutes: avgDuration,
      period: `Last ${days} days`
    });
  } catch (error) {
    console.error('[Admin] Journey analytics error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get user analytics
router.get('/admin/analytics/users', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // New users over time
    const newUsersResult = await pool.query(
      `SELECT DATE(created_at) as date, user_type, COUNT(*) as count
       FROM users WHERE created_at >= $1
       GROUP BY DATE(created_at), user_type ORDER BY date DESC`,
      [startDate]
    );

    // Top mechanics by journey count
    const topMechanicsResult = await pool.query(
      `SELECT u.id, u.full_name, COUNT(j.id) as journey_count,
              SUM(CASE WHEN j.status = 'completed' THEN 1 ELSE 0 END) as completed_count
       FROM users u LEFT JOIN journeys j ON u.id = j.mechanic_id
       WHERE u.user_type = 'mechanic' AND j.created_at >= $1
       GROUP BY u.id, u.full_name ORDER BY journey_count DESC LIMIT 10`,
      [startDate]
    );

    // User retention
    const retentionResult = await pool.query(
      `SELECT
        COUNT(DISTINCT CASE WHEN users.created_at >= $1 THEN users.id END) as new_users,
        COUNT(DISTINCT CASE WHEN users.created_at < $1 AND
              EXISTS(SELECT 1 FROM journeys WHERE journeys.driver_id = users.id
              OR journeys.mechanic_id = users.id AND journeys.created_at >= $1)
              THEN users.id END) as returning_users
       FROM users`,
      [startDate]
    );

    res.json({
      newUsersOverTime: newUsersResult.rows,
      topMechanics: topMechanicsResult.rows,
      retention: retentionResult.rows[0],
      period: `Last ${days} days`
    });
  } catch (error) {
    console.error('[Admin] User analytics error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============= USER MANAGEMENT =============

// Get all users with filtering
router.get('/admin/users', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { userType, status, search, limit = 50, offset = 0 } = req.query;

    let query = 'SELECT id, full_name, phone_number, user_type, created_at, updated_at FROM users WHERE 1=1';
    const params = [];

    if (userType) {
      query += ` AND user_type = $${params.length + 1}`;
      params.push(userType);
    }

    if (search) {
      query += ` AND (full_name ILIKE $${params.length + 1} OR phone_number ILIKE $${params.length + 1})`;
      params.push(`%${search}%`);
      params.push(`%${search}%`);
    }

    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit);
    params.push(offset);

    const result = await pool.query(query, params);

    // Get total count
    let countQuery = 'SELECT COUNT(*) as count FROM users WHERE 1=1';
    const countParams = [];
    if (userType) {
      countQuery += ` AND user_type = $${countParams.length + 1}`;
      countParams.push(userType);
    }
    if (search) {
      countQuery += ` AND (full_name ILIKE $${countParams.length + 1} OR phone_number ILIKE $${countParams.length + 1})`;
      countParams.push(`%${search}%`);
      countParams.push(`%${search}%`);
    }

    const countResult = await pool.query(countQuery, countParams);
    const total = parseInt(countResult.rows[0].count);

    res.json({
      users: result.rows,
      total,
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  } catch (error) {
    console.error('[Admin] Get users error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get single user details
router.get('/admin/users/:userId', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { userId } = req.params;

    const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];

    // Get user statistics
    let stats = {};
    if (user.user_type === 'mechanic') {
      const mechanicStats = await pool.query(
        `SELECT
          COUNT(j.id) as total_journeys,
          SUM(CASE WHEN j.status = 'completed' THEN 1 ELSE 0 END) as completed_journeys,
          AVG(CASE WHEN r.rating IS NOT NULL THEN r.rating END) as avg_rating
        FROM journeys j
        LEFT JOIN ratings r ON r.journey_id = j.id
        WHERE j.mechanic_id = $1`,
        [userId]
      );
      stats = mechanicStats.rows[0];
    } else if (user.user_type === 'driver') {
      const driverStats = await pool.query(
        `SELECT
          COUNT(rr.id) as total_requests,
          COUNT(j.id) as completed_journeys,
          SUM(CASE WHEN rr.status = 'expired' THEN 1 ELSE 0 END) as expired_requests
        FROM repair_requests rr
        LEFT JOIN journeys j ON j.repair_request_id = rr.id AND j.status = 'completed'
        WHERE rr.driver_id = $1`,
        [userId]
      );
      stats = driverStats.rows[0];
    }

    res.json({
      ...user,
      statistics: stats
    });
  } catch (error) {
    console.error('[Admin] Get user details error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Suspend/unsuspend user
router.post('/admin/users/:userId/suspend', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { reason, duration } = req.body;

    const schema = Joi.object({
      reason: Joi.string().required(),
      duration: Joi.number().positive()
    });
    const { error } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    const suspendUntil = duration ? new Date(Date.now() + duration * 24 * 60 * 60 * 1000) : null;

    const result = await pool.query(
      `UPDATE users SET suspended = true, suspend_reason = $1, suspend_until = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3 RETURNING id, full_name`,
      [reason, suspendUntil, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      message: 'User suspended successfully',
      user: result.rows[0],
      suspendUntil
    });
  } catch (error) {
    console.error('[Admin] Suspend user error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============= FEE CONFIGURATION =============

// Get current fee configuration
router.get('/admin/config/fees', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM admin_config WHERE config_key LIKE 'fee_%' ORDER BY config_key`
    );

    const fees = {};
    result.rows.forEach(row => {
      fees[row.config_key] = parseFloat(row.config_value);
    });

    // Provide defaults if not found
    res.json({
      platformFeePercentage: fees.fee_platform_percentage || 10,
      minimumFeeAmount: fees.fee_minimum_amount || 500,
      maximumFeePercentage: fees.fee_maximum_percentage || 25,
      cancellationFee: fees.fee_cancellation || 1000,
      description: 'Platform fee structure in FCFA'
    });
  } catch (error) {
    console.error('[Admin] Get fees error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update fee configuration
router.post('/admin/config/fees', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { platformFeePercentage, minimumFeeAmount, maximumFeePercentage, cancellationFee } = req.body;

    const schema = Joi.object({
      platformFeePercentage: Joi.number().min(0).max(100),
      minimumFeeAmount: Joi.number().min(0),
      maximumFeePercentage: Joi.number().min(0).max(100),
      cancellationFee: Joi.number().min(0)
    });
    const { error } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const updates = [
        { key: 'fee_platform_percentage', value: platformFeePercentage },
        { key: 'fee_minimum_amount', value: minimumFeeAmount },
        { key: 'fee_maximum_percentage', value: maximumFeePercentage },
        { key: 'fee_cancellation', value: cancellationFee }
      ];

      for (const update of updates) {
        if (update.value !== undefined) {
          await client.query(
            `INSERT INTO admin_config (config_key, config_value, updated_at)
             VALUES ($1, $2, CURRENT_TIMESTAMP)
             ON CONFLICT (config_key) DO UPDATE SET config_value = $2, updated_at = CURRENT_TIMESTAMP`,
            [update.key, update.value.toString()]
          );
        }
      }

      await client.query('COMMIT');

      res.json({
        message: 'Fee configuration updated successfully',
        platformFeePercentage,
        minimumFeeAmount,
        maximumFeePercentage,
        cancellationFee
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('[Admin] Update fees error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============= DISPUTE MANAGEMENT =============

// Get all disputes
router.get('/admin/disputes', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query;

    let query = `SELECT d.*,
                 j.driver_id, j.mechanic_id,
                 d_user.full_name as driver_name,
                 m_user.full_name as mechanic_name
                 FROM disputes d
                 LEFT JOIN journeys j ON d.journey_id = j.id
                 LEFT JOIN users d_user ON j.driver_id = d_user.id
                 LEFT JOIN users m_user ON j.mechanic_id = m_user.id
                 WHERE 1=1`;
    const params = [];

    if (status) {
      query += ` AND d.status = $${params.length + 1}`;
      params.push(status);
    }

    query += ` ORDER BY d.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit);
    params.push(offset);

    const result = await pool.query(query, params);

    // Get total count
    let countQuery = 'SELECT COUNT(*) as count FROM disputes WHERE 1=1';
    const countParams = [];
    if (status) {
      countQuery += ` AND status = $${countParams.length + 1}`;
      countParams.push(status);
    }
    const countResult = await pool.query(countQuery, countParams);

    res.json({
      disputes: result.rows,
      total: parseInt(countResult.rows[0].count),
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  } catch (error) {
    console.error('[Admin] Get disputes error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Resolve dispute
router.post('/admin/disputes/:disputeId/resolve', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { disputeId } = req.params;
    const { resolution, winnerId, refundAmount } = req.body;

    const schema = Joi.object({
      resolution: Joi.string().valid('driver_win', 'mechanic_win', 'split').required(),
      winnerId: Joi.number(),
      refundAmount: Joi.number().positive()
    });
    const { error } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Update dispute
      const result = await client.query(
        `UPDATE disputes SET status = 'resolved', resolution = $1, resolved_by = $2, resolved_at = CURRENT_TIMESTAMP
         WHERE id = $3 RETURNING *`,
        [resolution, req.userId, disputeId]
      );

      if (result.rows.length === 0) {
        throw new Error('Dispute not found');
      }

      // Process refund if needed
      if (refundAmount && winnerId) {
        await client.query(
          `UPDATE wallets SET available = available + $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2`,
          [refundAmount, winnerId]
        );

        await client.query(
          `INSERT INTO wallet_transactions (user_id, transaction_type, amount, description, reference_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [winnerId, 'dispute_resolution', refundAmount, `Dispute resolution: ${resolution}`, disputeId]
        );
      }

      await client.query('COMMIT');

      res.json({
        message: 'Dispute resolved successfully',
        dispute: result.rows[0]
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('[Admin] Resolve dispute error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
