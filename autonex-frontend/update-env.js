#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const envPath = path.join(__dirname, '.env');

// Update .env with production backend URL
const envContent = 'VITE_API_URL=https://autonex-production-e581.up.railway.app\n';

try {
  fs.writeFileSync(envPath, envContent, 'utf8');
  console.log('✅ .env file updated successfully!');
  console.log('New VITE_API_URL:', envContent.split('=')[1].trim());
  console.log('\nNext step: Run "npm run build" to build your frontend');
} catch (error) {
  console.error('❌ Error updating .env file:', error.message);
  process.exit(1);
}
