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

app.get('/health', (req, res) => res.json({ status: 'OK' }));

app.post('/api/auth/register', async (req, res) => {
  try {
    const { userType, fullName, email, password } = req.body;
    if (!userType || !fullName || !email || !password) {
      return res.status(400).json({ message: 'All fields required' });
    }
    const exists = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (exists.rows.length > 0) {
      return res.status(400).json({ message: 'Email already registered' });
    }
    const hashed = await bcryptjs.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (user_type, full_name, email, password_hash) VALUES ($1,$2,$3,$4) RETURNING id,email,user_type',
      [userType, fullName, email, hashed]
    );
    res.status(201).json({ message: 'Registration successful', user: result.rows[0] });
  } catch (error) {
    res.status(500).json({ message: 'Registration failed: ' + error.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password required' });
    }
    const result = await pool.query('SELECT id,email,user_type,password_hash FROM users WHERE email=$1', [email]);
    if (result.rows.length === 0) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }
    const user = result.rows[0];
    const match = await bcryptjs.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ message: 'Invalid email or password' });
    const token = jwt.sign({ id: user.id, email: user.email, userType: user.user_type }, process.env.JWT_SECRET, { expiresIn: '24h' });
    res.json({ message: 'Login successful', token, user: { id: user.id, email: user.email, userType: user.user_type } });
  } catch (error) {
    res.status(500).json({ message: 'Login failed: ' + error.message });
  }
});

app.post('/api/repair-requests', verifyToken, async (req, res) => {
  try {
    const { title, description, vehicleType, location, budgetMin, budgetMax } = req.body;
    if (!title || !description) {
      return res.status(400).json({ message: 'Title and description required' });
    }
    const result = await pool.query(
      'INSERT INTO repair_requests (driver_id,title,description,vehicle_type,location,budget_min,budget_max) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [req.user.id, title, description, vehicleType, location, budgetMin, budgetMax]
    );
    res.status(201).json({ message: 'Repair request created', repairRequest: result.rows[0] });
  } catch (error) {
    res.status(500).json({ message: 'Failed to create repair request: ' + error.message });
  }
});

app.get('/api/repair-requests', async (req, res) => {
  try {
    const result = await pool.query('SELECT rr.*,u.full_name FROM repair_requests rr JOIN users u ON rr.driver_id=u.id ORDER BY rr.created_at DESC');
    res.json({ repairRequests: result.rows });
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch repair requests' });
  }
});

app.get('/api/repair-requests/:id', async (req, res) => {
  try {
    const rr = await pool.query('SELECT rr.*,u.full_name FROM repair_requests rr JOIN users u ON rr.driver_id=u.id WHERE rr.id=$1', [req.params.id]);
    if (rr.rows.length === 0) return res.status(404).json({ message: 'Not found' });
    const quotes = await pool.query('SELECT q.*,u.full_name FROM quotes q JOIN users u ON q.mechanic_id=u.id WHERE q.repair_request_id=$1', [req.params.id]);
    res.json({ repairRequest: rr.rows[0], quotes: quotes.rows });
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch' });
  }
});

app.post('/api/service-offers', verifyToken, async (req, res) => {
  try {
    const { serviceName, description, specialization, hourlyRate, location, availability } = req.body;
    if (!serviceName) return res.status(400).json({ message: 'Service name required' });
    const result = await pool.query(
      'INSERT INTO service_offers (mechanic_id,service_name,description,specialization,hourly_rate,location,availability) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [req.user.id, serviceName, description, specialization, hourlyRate, location, availability]
    );
    res.status(201).json({ message: 'Service offer created', serviceOffer: result.rows[0] });
  } catch (error) {
    res.status(500).json({ message: 'Failed: ' + error.message });
  }
});

app.get('/api/service-offers', async (req, res) => {
  try {
    const result = await pool.query('SELECT so.*,u.full_name FROM service_offers so JOIN users u ON so.mechanic_id=u.id ORDER BY so.rating DESC');
    res.json({ serviceOffers: result.rows });
  } catch (error) {
    res.status(500).json({ message: 'Failed' });
  }
});

app.post('/api/repair-requests/:id/quotes', verifyToken, async (req, res) => {
  try {
    const { quotedPrice, estimatedTime, description } = req.body;
    if (!quotedPrice) return res.status(400).json({ message: 'Price required' });
    const result = await pool.query(
      'INSERT INTO quotes (repair_request_id,mechanic_id,quoted_price,estimated_time,description) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [req.params.id, req.user.id, quotedPrice, estimatedTime, description]
    );
    res.status(201).json({ message: 'Quote submitted', quote: result.rows[0] });
  } catch (error) {
    res.status(500).json({ message: 'Failed: ' + error.message });
  }
});

app.patch('/api/quotes/:id/accept', verifyToken, async (req, res) => {
  try {
    const result = await pool.query('UPDATE quotes SET status=$1 WHERE id=$2 RETURNING *', ['accepted', req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ message: 'Not found' });
    res.json({ message: 'Quote accepted', quote: result.rows[0] });
  } catch (error) {
    res.status(500).json({ message: 'Failed: ' + error.message });
  }
});

app.listen(PORT, () => console.log('Server running on port ' + PORT));`;

fs.writeFileSync(path.join(__dirname, 'src', 'server.js'), serverJs);
console.log('✓ Server updated with marketplace endpoints');