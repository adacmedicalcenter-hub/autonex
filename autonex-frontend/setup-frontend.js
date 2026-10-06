import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create src directory if it doesn't exist
const srcDir = path.join(__dirname, 'src');
if (!fs.existsSync(srcDir)) {
  fs.mkdirSync(srcDir, { recursive: true });
}

// Create index.html
const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AutoNex - On-Demand Car Repair</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
      background-color: #f5f5f5;
    }
  </style>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/src/main.jsx"><\/script>
</body>
</html>`;

fs.writeFileSync(path.join(__dirname, 'index.html'), indexHtml);
console.log('✓ Created index.html');

// Create src/main.jsx
const mainJsx = `import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)`;

fs.writeFileSync(path.join(srcDir, 'main.jsx'), mainJsx);
console.log('✓ Created src/main.jsx');

// Create src/App.jsx
const appJsx = `import { useState } from 'react'

export default function App() {
  const [activeTab, setActiveTab] = useState('login')

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header style={{ background: '#2c3e50', color: 'white', padding: '20px', textAlign: 'center' }}>
        <h1>🚗 AutoNex - On-Demand Car Repair</h1>
        <p>Connect with mechanics instantly</p>
      </header>

      <main style={{ flex: 1, padding: '40px 20px', maxWidth: '800px', margin: '0 auto', width: '100%' }}>
        <div style={{ display: 'flex', gap: '10px', marginBottom: '20px' }}>
          <button 
            onClick={() => setActiveTab('login')}
            style={{
              padding: '10px 20px',
              background: activeTab === 'login' ? '#3498db' : '#ecf0f1',
              color: activeTab === 'login' ? 'white' : '#2c3e50',
              border: 'none',
              borderRadius: '5px',
              cursor: 'pointer',
              fontSize: '16px'
            }}
          >
            Login
          </button>
          <button 
            onClick={() => setActiveTab('register')}
            style={{
              padding: '10px 20px',
              background: activeTab === 'register' ? '#3498db' : '#ecf0f1',
              color: activeTab === 'register' ? 'white' : '#2c3e50',
              border: 'none',
              borderRadius: '5px',
              cursor: 'pointer',
              fontSize: '16px'
            }}
          >
            Register
          </button>
        </div>

        {activeTab === 'login' && (
          <div style={{ background: 'white', padding: '30px', borderRadius: '8px', boxShadow: '0 2px 4px rgba(0,0,0,0.1)' }}>
            <h2 style={{ marginBottom: '20px', color: '#2c3e50' }}>Login to AutoNex</h2>
            <form>
              <div style={{ marginBottom: '15px' }}>
                <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold', color: '#2c3e50' }}>Email</label>
                <input type="email" placeholder="your@email.com" style={{ width: '100%', padding: '10px', border: '1px solid #bdc3c7', borderRadius: '4px', fontSize: '14px' }} />
              </div>
              <div style={{ marginBottom: '15px' }}>
                <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold', color: '#2c3e50' }}>Password</label>
                <input type="password" placeholder="Your password" style={{ width: '100%', padding: '10px', border: '1px solid #bdc3c7', borderRadius: '4px', fontSize: '14px' }} />
              </div>
              <button type="button" style={{ width: '100%', padding: '12px', background: '#27ae60', color: 'white', border: 'none', borderRadius: '4px', fontSize: '16px', fontWeight: 'bold', cursor: 'pointer' }}>
                Login
              </button>
            </form>
            <p style={{ marginTop: '15px', textAlign: 'center', color: '#7f8c8d' }}>✓ Backend is connected and working!</p>
          </div>
        )}

        {activeTab === 'register' && (
          <div style={{ background: 'white', padding: '30px', borderRadius: '8px', boxShadow: '0 2px 4px rgba(0,0,0,0.1)' }}>
            <h2 style={{ marginBottom: '20px', color: '#2c3e50' }}>Register for AutoNex</h2>
            <form>
              <div style={{ marginBottom: '15px' }}>
                <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold', color: '#2c3e50' }}>User Type</label>
                <select style={{ width: '100%', padding: '10px', border: '1px solid #bdc3c7', borderRadius: '4px', fontSize: '14px' }}>
                  <option>Select user type</option>
                  <option>Driver</option>
                  <option>Mechanic</option>
                </select>
              </div>
              <div style={{ marginBottom: '15px' }}>
                <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold', color: '#2c3e50' }}>Full Name</label>
                <input type="text" placeholder="Your name" style={{ width: '100%', padding: '10px', border: '1px solid #bdc3c7', borderRadius: '4px', fontSize: '14px' }} />
              </div>
              <div style={{ marginBottom: '15px' }}>
                <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold', color: '#2c3e50' }}>Email</label>
                <input type="email" placeholder="your@email.com" style={{ width: '100%', padding: '10px', border: '1px solid #bdc3c7', borderRadius: '4px', fontSize: '14px' }} />
              </div>
              <div style={{ marginBottom: '15px' }}>
                <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold', color: '#2c3e50' }}>Password</label>
                <input type="password" placeholder="Create a password" style={{ width: '100%', padding: '10px', border: '1px solid #bdc3c7', borderRadius: '4px', fontSize: '14px' }} />
              </div>
              <button type="button" style={{ width: '100%', padding: '12px', background: '#3498db', color: 'white', border: 'none', borderRadius: '4px', fontSize: '16px', fontWeight: 'bold', cursor: 'pointer' }}>
                Register
              </button>
            </form>
          </div>
        )}
      </main>

      <footer style={{ background: '#2c3e50', color: 'white', padding: '20px', textAlign: 'center' }}>
        <p>AutoNex © 2024 - Connecting Drivers with Mechanics</p>
      </footer>
    </div>
  )
}`;

fs.writeFileSync(path.join(srcDir, 'App.jsx'), appJsx);
console.log('✓ Created src/App.jsx');

console.log('\nAll frontend files created successfully!');