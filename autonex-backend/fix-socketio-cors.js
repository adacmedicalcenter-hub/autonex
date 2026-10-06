#!/usr/bin/env node

/**
 * Fix Socket.IO CORS to accept Netlify frontend
 * Run this in your autonex-backend directory to update CORS configuration
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const serverPath = path.join(__dirname, 'src', 'server.js');

try {
  // Read the current server.js
  let serverCode = fs.readFileSync(serverPath, 'utf8');

  // Find and replace the hardcoded Socket.IO CORS configuration
  const oldCors = `const io = new Server(httpServer, {
  cors: {
    origin: 'http://localhost:5173',
    methods: ['GET', 'POST']
  }
});`;

  const newCors = `const io = new Server(httpServer, {
  cors: {
    origin: '*', // Accept all origins (better for production: whitelist specific Netlify domain)
    methods: ['GET', 'POST']
  }
});`;

  if (serverCode.includes(oldCors)) {
    serverCode = serverCode.replace(oldCors, newCors);
    fs.writeFileSync(serverPath, serverCode, 'utf8');
    console.log('✅ Socket.IO CORS updated successfully!');
    console.log('\n📝 Changes made:');
    console.log('   - Socket.IO now accepts requests from all origins');
    console.log('   - Real-time chat will work from your Netlify frontend');
    console.log('\n📢 IMPORTANT: After making this change, you MUST redeploy to Railway:');
    console.log('   1. Commit the changes: git add -A && git commit -m "Fix: Update Socket.IO CORS for Netlify"');
    console.log('   2. Push to main: git push origin main');
    console.log('   3. Railway will auto-deploy your changes (watch the Railway dashboard)');
    console.log('   4. After deployment completes, your chat will work from Netlify!');
  } else {
    console.error('❌ Could not find the Socket.IO CORS configuration to update.');
    console.error('Make sure you\'re running this from the autonex-backend directory.');
    process.exit(1);
  }
} catch (error) {
  console.error('❌ Error:', error.message);
  process.exit(1);
}
