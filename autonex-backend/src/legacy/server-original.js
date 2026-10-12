import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { createServer } from 'http';
import { Server } from 'socket.io';
import pool from './database/db.js';
import bcryptjs from 'bcryptjs';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import Joi from 'joi';
import walletRouter from './routes/wallet.js';
import journeysRouter from './routes/journeys.js';
import adminRouter from './routes/admin.js';
import { verifyToken } from './middleware/auth.js';
import {
  startExpiryChecker,
  getExpiryStatus,
  getTimeRemaining
} from './services/requestExpiryService.js';
import {
  startTimeoutChecker,
  getTimeoutStatus,
  cancelJourney as cancelJourneyService
} from './services/journeyTimeoutService.js';
import { cleanupExpiredPins } from './services/pinService.js';
import { reserveFee, releaseFee, getFeeConfig } from './services/feeService.js';

dotenv.config();

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

app.use(cors());
app.use(helmet());
app.use(express.json());

// Register routers
app.use('/api', walletRouter);
app.use('/api', journeysRouter);
app.use('/api', adminRouter);

app.post('/api/auth/register', async (req, res) => {
  try {
    const { user_type, full_name, phone_number, password } = req.body;
    const schema = Joi.object({
      user_type: Joi.string().valid('driver', 'mechanic').required(),
      full_name: Joi.string().min(3).required(),
      phone_number: Joi.string().required(),
      password: Joi.string().min(6).required()
    });
    const { error } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    const hashedPassword = await bcryptjs.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (user_type, full_name, phone_number, password_hash) VALUES ($1, $2, $3, $4) RETURNING id, user_type, phone_number',
      [user_type, full_name, phone_number, hashedPassword]
    );
    res.json({ message: 'User registered successfully', user: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { phone_number, password } = req.body;
    const result = await pool.query('SELECT * FROM users WHERE phone_number = $1', [phone_number]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];
    const isMatch = await bcryptjs.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { userId: user.id, userType: user.user_type },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );
    res.json({ token, userId: user.id, userType: user.user_type, fullName: user.full_name });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/repair-requests', verifyToken, async (req, res) => {
  try {
    if (req.userType !== 'driver') {
      return res.status(403).json({ error: 'Only drivers can create repair requests' });
    }
    const { title, description, vehicle_type, location, budget_min, budget_max } = req.body;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Create repair request
      const result = await client.query(
        'INSERT INTO repair_requests (driver_id, title, description, vehicle_type, location, budget_min, budget_max, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *',
        [req.userId, title, description, vehicle_type, location, budget_min, budget_max, 'open']
      );

      const request = result.rows[0];

      // Reserve driver connection fee
      const feeConfig = await getFeeConfig();
      const feeReservation = await reserveFee(
        req.userId,
        request.id,
        'connection_fee_driver',
        feeConfig.driverFee,
        client
      );

      if (!feeReservation.success) {
        await client.query('ROLLBACK');
        return res.status(402).json({
          error: 'Cannot create repair request - fee reservation failed',
          details: feeReservation.error,
          required: feeReservation.required,
          available: feeReservation.available
        });
      }

      await client.query('COMMIT');

      const expiryStatus = getExpiryStatus(request);

      res.json({
        ...request,
        expiry: expiryStatus,
        feeReserved: true,
        feeAmount: feeConfig.driverFee,
        message: 'Repair request created and connection fee reserved'
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/repair-requests', async (req, res) => {
  try {
    const { includeExpired, driverId } = req.query;

    let query = 'SELECT rr.*, u.full_name as driver_name FROM repair_requests rr JOIN users u ON rr.driver_id = u.id';
    const params = [];

    // Default: only show active (non-expired) requests
    if (!includeExpired) {
      query += ' WHERE rr.status != $1';
      params.push('expired');
    }

    // Optional: filter by driver
    if (driverId) {
      if (includeExpired) {
        query += ` WHERE rr.driver_id = $${params.length + 1}`;
      } else {
        query += ` AND rr.driver_id = $${params.length + 1}`;
      }
      params.push(driverId);
    }

    query += ' ORDER BY rr.created_at DESC';

    const result = await pool.query(query, params);

    // Add expiry information to each request
    const requestsWithExpiry = result.rows.map(request => ({
      ...request,
      expiry: getExpiryStatus(request)
    }));

    res.json(requestsWithExpiry);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/repair-requests/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'SELECT rr.*, u.full_name as driver_name FROM repair_requests rr JOIN users u ON rr.driver_id = u.id WHERE rr.id = $1',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Repair request not found' });
    }

    const request = result.rows[0];
    const expiryStatus = getExpiryStatus(request);

    res.json({
      ...request,
      expiry: expiryStatus
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/repair-requests/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;

    // Get the request to verify ownership
    const requestResult = await pool.query(
      'SELECT * FROM repair_requests WHERE id = $1',
      [id]
    );

    if (requestResult.rows.length === 0) {
      return res.status(404).json({ error: 'Repair request not found' });
    }

    const request = requestResult.rows[0];

    // Verify ownership - only driver can cancel their own request
    if (request.driver_id !== req.userId) {
      return res.status(403).json({ error: 'You can only cancel your own repair requests' });
    }

    // Don't allow cancellation of completed or in-progress requests
    if (request.status === 'completed' || request.status === 'in_progress' || request.status === 'expired') {
      return res.status(400).json({ error: `Cannot cancel a ${request.status} request` });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Update status to cancelled
      const updateResult = await client.query(
        'UPDATE repair_requests SET status = $1 WHERE id = $2 RETURNING *',
        ['cancelled', id]
      );

      // Release any fee reservations
      const reservations = await client.query(
        'SELECT id FROM reservations WHERE repair_request_id = $1 AND status = $2',
        [id, 'reserved']
      );

      for (const reservation of reservations.rows) {
        await releaseFee(reservation.id, 'Repair request cancelled by driver', client);
      }

      await client.query('COMMIT');

      res.json({
        message: 'Repair request cancelled successfully',
        request: updateResult.rows[0]
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/service-offers', verifyToken, async (req, res) => {
  try {
    if (req.userType !== 'mechanic') {
      return res.status(403).json({ error: 'Only mechanics can offer services' });
    }
    const { service_name, description, specialization, hourly_rate, location, phone_number, availability } = req.body;
    const result = await pool.query(
      'INSERT INTO service_offers (mechanic_id, service_name, description, specialization, hourly_rate, location, phone_number, availability) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *',
      [req.userId, service_name, description, specialization, hourly_rate, location, phone_number, availability]
    );
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/service-offers', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT so.*, u.full_name as mechanic_name FROM service_offers so JOIN users u ON so.mechanic_id = u.id ORDER BY so.created_at DESC'
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.patch('/api/service-offers/:id', verifyToken, async (req, res) => {
  try {
    console.log('Update request - User ID:', req.userId, 'Service ID:', req.params.id);
    console.log('Update data:', req.body);

    if (req.userType !== 'mechanic') {
      return res.status(403).json({ error: 'Only mechanics can edit services' });
    }
    const { id } = req.params;
    const { service_name, description, specialization, hourly_rate, location, phone_number, availability } = req.body;

    // Verify ownership
    const serviceCheck = await pool.query('SELECT mechanic_id FROM service_offers WHERE id = $1', [id]);
    if (serviceCheck.rows.length === 0 || serviceCheck.rows[0].mechanic_id !== req.userId) {
      return res.status(403).json({ error: 'You can only edit your own services' });
    }

    // Try update with phone_number first
    let result;
    try {
      result = await pool.query(
        'UPDATE service_offers SET service_name = $1, description = $2, specialization = $3, hourly_rate = $4, location = $5, phone_number = $6, availability = $7 WHERE id = $8 RETURNING *',
        [service_name, description, specialization, hourly_rate, location, phone_number, availability, id]
      );
    } catch (phoneError) {
      // If phone_number column doesn't exist, try without it
      console.log('Phone number update failed, trying without phone_number:', phoneError.message);
      result = await pool.query(
        'UPDATE service_offers SET service_name = $1, description = $2, specialization = $3, hourly_rate = $4, location = $5, availability = $6 WHERE id = $7 RETURNING *',
        [service_name, description, specialization, hourly_rate, location, availability, id]
      );
    }

    console.log('Update successful:', result.rows[0]);
    res.json(result.rows[0]);
  } catch (error) {
    console.log('Update error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/service-offers/:id', verifyToken, async (req, res) => {
  try {
    console.log('Delete request - User ID:', req.userId, 'User Type:', req.userType, 'Service ID:', req.params.id);

    if (req.userType !== 'mechanic') {
      console.log('User is not a mechanic');
      return res.status(403).json({ error: 'Only mechanics can delete services' });
    }
    const { id } = req.params;

    // Verify ownership
    const serviceCheck = await pool.query('SELECT mechanic_id FROM service_offers WHERE id = $1', [id]);
    console.log('Service check result:', serviceCheck.rows);

    if (serviceCheck.rows.length === 0 || serviceCheck.rows[0].mechanic_id !== req.userId) {
      console.log('Service not found or user does not own this service');
      return res.status(403).json({ error: 'You can only delete your own services' });
    }

    const deleteResult = await pool.query('DELETE FROM service_offers WHERE id = $1', [id]);
    console.log('Delete successful, rows affected:', deleteResult.rowCount);
    res.json({ message: 'Service deleted successfully' });
  } catch (error) {
    console.log('Delete error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/repair-requests/:id/quotes', verifyToken, async (req, res) => {
  try {
    if (req.userType !== 'mechanic') {
      return res.status(403).json({ error: 'Only mechanics can submit quotes' });
    }
    const { id } = req.params;
    const { quoted_price, estimated_time, description } = req.body;
    const result = await pool.query(
      'INSERT INTO quotes (repair_request_id, mechanic_id, quoted_price, estimated_time, description, status) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [id, req.userId, quoted_price, estimated_time, description, 'pending']
    );
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.patch('/api/quotes/:id/accept', verifyToken, async (req, res) => {
  try {
    if (req.userType !== 'driver') {
      return res.status(403).json({ error: 'Only drivers can accept quotes' });
    }
    const { id } = req.params;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Get quote details
      const quoteResult = await client.query(
        'SELECT * FROM quotes WHERE id = $1',
        [id]
      );

      if (quoteResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Quote not found' });
      }

      const quote = quoteResult.rows[0];
      const mechanicId = quote.mechanic_id;
      const repairRequestId = quote.repair_request_id;

      // Reserve mechanic connection fee
      const feeConfig = await getFeeConfig();
      const feeReservation = await reserveFee(
        mechanicId,
        repairRequestId,
        'connection_fee_mechanic',
        feeConfig.mechanicFee,
        client
      );

      if (!feeReservation.success) {
        await client.query('ROLLBACK');
        return res.status(402).json({
          error: 'Cannot accept quote - mechanic fee reservation failed',
          details: feeReservation.error,
          required: feeReservation.required,
          available: feeReservation.available
        });
      }

      // Update quote status
      const updateResult = await client.query(
        'UPDATE quotes SET status = $1 WHERE id = $2 RETURNING *',
        ['accepted', id]
      );

      await client.query('COMMIT');

      res.json({
        ...updateResult.rows[0],
        mechanicFeeReserved: true,
        mechanicFeeAmount: feeConfig.mechanicFee,
        message: 'Quote accepted and mechanic connection fee reserved'
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/conversations', verifyToken, async (req, res) => {
  try {
    const { other_user_id, repair_request_id } = req.body;
    const existingConversation = await pool.query(
      'SELECT * FROM conversations WHERE (driver_id = $1 AND mechanic_id = $2) OR (driver_id = $2 AND mechanic_id = $1)',
      [req.userId, other_user_id]
    );
    if (existingConversation.rows.length > 0) {
      return res.json(existingConversation.rows[0]);
    }
    const newConversation = await pool.query(
      'INSERT INTO conversations (driver_id, mechanic_id, repair_request_id) VALUES ($1, $2, $3) RETURNING *',
      [req.userId, other_user_id, repair_request_id]
    );
    res.json(newConversation.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/conversations', verifyToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT c.*, u1.full_name as driver_name, u2.full_name as mechanic_name FROM conversations c JOIN users u1 ON c.driver_id = u1.id JOIN users u2 ON c.mechanic_id = u2.id WHERE c.driver_id = $1 OR c.mechanic_id = $1 ORDER BY c.updated_at DESC',
      [req.userId]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/conversations/:id/messages', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'SELECT m.*, u.full_name as sender_name FROM messages m JOIN users u ON m.sender_id = u.id WHERE m.conversation_id = $1 ORDER BY m.created_at ASC',
      [id]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const connectedUsers = new Map();
const userSockets = new Map();

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('user_login', (data) => {
    const { userId } = data;
    connectedUsers.set(userId, socket.id);
    userSockets.set(socket.id, userId);
  });

  socket.on('join_conversation', (data) => {
    const { conversationId } = data;
    socket.join('conversation_' + conversationId);
  });

  socket.on('send_message', async (data) => {
    try {
      const { conversationId, senderId, senderType, messageText } = data;
      const result = await pool.query(
        'INSERT INTO messages (conversation_id, sender_id, sender_type, message_text) VALUES ($1, $2, $3, $4) RETURNING *',
        [conversationId, senderId, senderType, messageText]
      );
      await pool.query(
        'UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = $1',
        [conversationId]
      );

      // Get sender details for complete message object
      const senderResult = await pool.query('SELECT full_name FROM users WHERE id = $1', [senderId]);
      const senderName = senderResult.rows[0]?.full_name || 'Unknown User';

      const message = result.rows[0];
      io.to('conversation_' + conversationId).emit('receive_message', {
        id: message.id,
        conversation_id: message.conversation_id,
        sender_id: message.sender_id,
        sender_type: message.sender_type,
        message_text: message.message_text,
        created_at: message.created_at,
        sender_name: senderName
      });
    } catch (error) {
      socket.emit('message_error', { error: error.message });
    }
  });

  socket.on('disconnect', () => {
    const userId = userSockets.get(socket.id);
    if (userId) {
      connectedUsers.delete(userId);
      userSockets.delete(socket.id);
    }
  });
});

const PORT = process.env.PORT || 5000;
let expiryCheckerInterval;
let timeoutCheckerInterval;
let pinCleanupInterval;

httpServer.listen(PORT, () => {
  console.log('Server running on port ' + PORT);

  // Start the request expiry checker (runs every 60 seconds)
  expiryCheckerInterval = startExpiryChecker(60);

  // Start the journey timeout checker (runs every 5 minutes)
  timeoutCheckerInterval = startTimeoutChecker(300);

  // Start the PIN cleanup checker (runs every 30 minutes)
  console.log('[PIN Cleanup] Starting PIN cleanup checker (interval: 1800s)');
  pinCleanupInterval = setInterval(() => {
    cleanupExpiredPins().catch(err =>
      console.error('[PIN Cleanup] Periodic cleanup failed:', err)
    );
  }, 1800 * 1000); // 30 minutes

  // Run cleanup immediately on startup
  cleanupExpiredPins().catch(err =>
    console.error('[PIN Cleanup] Initial cleanup failed:', err)
  );
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  if (expiryCheckerInterval) {
    clearInterval(expiryCheckerInterval);
  }
  if (timeoutCheckerInterval) {
    clearInterval(timeoutCheckerInterval);
  }
  if (pinCleanupInterval) {
    clearInterval(pinCleanupInterval);
  }
  httpServer.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully...');
  if (expiryCheckerInterval) {
    clearInterval(expiryCheckerInterval);
  }
  if (timeoutCheckerInterval) {
    clearInterval(timeoutCheckerInterval);
  }
  if (pinCleanupInterval) {
    clearInterval(pinCleanupInterval);
  }
  httpServer.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

export default io;
