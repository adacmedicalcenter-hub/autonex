import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const serverPath = path.join(__dirname, 'src', 'server.js');
let content = fs.readFileSync(serverPath, 'utf8');

// Fix the import path
content = content.replace("import pool from './src/database/db.js';", "import pool from './database/db.js';");

fs.writeFileSync(serverPath, content);
console.log('✓ Fixed server.js import path');