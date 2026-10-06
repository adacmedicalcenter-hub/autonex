import fs from 'fs';
import path from 'path';

const files = {
  'autonex-backend/.env': 'DB_HOST=localhost\nDB_PORT=5432\nDB_NAME=autonex_db\nDB_USER=postgres\nDB_PASSWORD=postgres\nJWT_SECRET=your_super_secret_key\nNODE_ENV=development\nPORT=5000',
  'autonex-backend/src/server.js': 'import express from "express";\nimport dotenv from "dotenv";\n\ndotenv.config();\nconst app = express();\nconst PORT = process.env.PORT || 5000;\n\napp.use(express.json());\napp.get("/health", (req, res) => res.json({status: "OK"}));\napp.listen(PORT, () => console.log("Server running on port " + PORT));',
  'autonex-backend/src/database/db.js': 'import pkg from "pg";\nconst { Pool } = pkg;\nimport dotenv from "dotenv";\n\ndotenv.config();\n\nconst pool = new Pool({\n  host: process.env.DB_HOST,\n  port: process.env.DB_PORT,\n  database: process.env.DB_NAME,\n  user: process.env.DB_USER,\n  password: process.env.DB_PASSWORD,\n});\n\nexport async function initializeDatabase() {\n  try {\n    await pool.query("SELECT NOW()");\n    console.log("Database initialized");\n  } catch (error) {\n    console.error("Database error:", error);\n  }\n}\n\nexport default pool;',
  'autonex-frontend/.env': 'VITE_API_URL=http://localhost:5000',
  'autonex-frontend/package.json': '{"name": "autonex-frontend", "version": "1.0.0", "type": "module", "scripts": {"start": "vite", "build": "vite build"}, "dependencies": {"react": "^18.2.0", "react-dom": "^18.2.0", "axios": "^1.6.2"}, "devDependencies": {"@vitejs/plugin-react": "^4.2.1", "vite": "^5.0.7"}}'
};

for (const [filePath, content] of Object.entries(files)) {
  const fullPath = path.join(process.cwd(), filePath);
  const dir = path.dirname(fullPath);
  
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  
  fs.writeFileSync(fullPath, content);
  console.log('Created: ' + filePath);
}

console.log('Done! All files created!');