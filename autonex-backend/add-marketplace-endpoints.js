import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const serverJs = `import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import bcryptjs from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pool from './database/db.js';

dotenv.config();
const app = express();
const PORT = process.env.PORT || 5000;

app.use(express.json());
app.use(cors());

// Middleware to verify JWT token
const verifyToken = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'No token provided' });
  
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    res.status(401).json({ message: 'Invalid token' });
  }
};

// ========== AUTH ENDPOINTS ==========
app.get('/health', (req, res) => {
  res.json({ status: 'OK' });
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { userType, fullName, email, password } = req.body;

    if (!userType || !fullName || !email || !password) {
      return res.status(400).json({ message: 'All fields are required' });
    }

    const userExists = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (userExists.rows.length > 0) {
      return res.status(400).json({ message: 'Email already registered' });
    }

    const hashedPassword = await bcryptjs.hash(password, 10);

    const result = await pool.query(
      'INSERT INTO users (user_type, full_name, email, password_hash) VALUES ($1, $2, $3, $4) RETURNING id, email, user_type',
      [userType, fullName, email, hashedPassword]
    );

    const user = result.rows[0];
    res.status(201).json({
      message: 'Registration successful',
      user: { id: user.id, email: user.email, userType: user.user_type }
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ message: 'Registration failed: ' + error.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required' });
    }

    const result = await pool.query('SELECT id, email, user_type, password_hash FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    const user = result.rows[0];

    const passwordMatch = await bcryptjs.compare(password, user.password_hash);
    if (!passwordMatch) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, userType: user.user_type },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      message: 'Login successful',
      token,
      user: { id: user.id, email: user.email, userType: user.user_type }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'Login failed: ' + error.message });
  }
});

// ========== REPAIR REQUEST ENDPOINTS ==========
// Driver: Create a repair request
app.post('/api/repair-requests', verifyToken, async (req, res) => {
  try {
    const { title, description, vehicleType, location, budgetMin, budgetMax } = req.body;
    
    if (!title || !description) {
      return res.status(400).json({ message: 'Title and description are required' });
    }

    const result = await pool.query(
      'INSERT INTO repair_requests (driver_id, title, description, vehicle_type, location, budget_min, budget_max) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
      [req.user.id, title, description, vehicleType, location, budgetMin, budgetMax]
    );

    res.status(201).json({
      message: 'Repair request created successfully',
      repairRequest: result.rows[0]
    });
  } catch (error) {
    console.error('Error creating repair request:', error);
    res.status(500).json({ message: 'Failed to create repair request: ' + error.message });
  }
});

// Get all repair requests
app.get('/api/repair-requests', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT rr.*, u.full_name, u.email FROM repair_requests rr JOIN users u ON rr.driver_id = u.id ORDER BY rr.created_at DESC'
    );
    res.json({ repairRequests: result.rows });
  } catch (error) {
    console.error('Error fetching repair requests:', error);
    res.status(500).json({ message: 'Failed to fetch repair requests' });
  }
});

// Get single repair request with quotes
app.get('/api/repair-requests/:id', async (req, res) => {
  try {
    const repairResult = await pool.query(
      'SELECT rr.*, u.full_name, u.email FROM repair_requests rr JOIN users u ON rr.driver_id = u.id WHERE rr.id = $1',
      [req.params.id]
    );

    if (repairResult.rows.length === 0) {
      return res.status(404).json({ message: 'Repair request not found' });
    }

    const quotesResult = await pool.query(
      'SELECT q.*, u.full_name, u.email FROM quotes q JOIN users u ON q.mechanic_id = u.id WHERE q.repair_request_id = $1 ORDER BY q.created_at DESC',
      [req.params.id]
    );

    res.json({
      repairRequest: repairResult.rows[0],
      quotes: quotesResult.rows
    });
  } catch (error) {
    console.error('Error fetching repair request:', error);
    res.status(500).json({ message: 'Failed to fetch repair request' });
  }
});

// ========== SERVICE