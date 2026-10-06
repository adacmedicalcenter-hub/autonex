import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const appJsx = `import { useState } from 'react'

export default function App() {
  const [activeTab, setActiveTab] = useState('login')
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState('')

  // Login state
  const [loginEmail, setLoginEmail] = useState('')
  const [loginPassword, setLoginPassword] = useState('')

  // Register state
  const [regUserType, setRegUserType] = useState('Driver')
  const [regName, setRegName] = useState('')
  const [regEmail, setRegEmail] = useState('')
  const [regPassword, setRegPassword] = useState('')

  const handleLogin = async (e) => {
    e.preventDefault()
    setLoading(true)
    setMessage('')

    try {
      const response = await fetch('http://localhost:5000/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: loginEmail, password: loginPassword })
      })

      const data = await response.json()
      if (response.ok) {
        setMessage('✓ Login successful!')
        setLoginEmail('')
        setLoginPassword('')
      } else {
        setMessage('✗ ' + (data.message || 'Login failed'))
      }
    } catch (error) {
      setMessage('✗ Error: ' + error.message)
    }
    setLoading(false)
  }

  const handleRegister = async (e) => {
    e.preventDefault()
    setLoading(true)
    setMessage('')

    try {
      const response = await fetch('http://localhost:5000/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userType: regUserType,
          fullName: regName,
          email: regEmail,
          password: regPassword
        })
      })

      const data = await response.json()
      if (response.ok) {
        setMessage('✓ Registration successful! You can now login.')
        setRegUserType('Driver')
        setRegName('')
        setRegEmail('')
        setRegPassword('')
      } else {
        setMessage('✗ ' + (data.message || 'Registration failed'))
      }
    } catch (error) {
      setMessage('✗ Error: ' + error.message)
    }
    setLoading(false)
  }

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

        {message && (
          <div style={{ padding: '12px', marginBottom: '20px', background: message.includes('✓') ? '#d5f4e6' : '#fdeaea', color: message.includes('✓') ? '#27ae60' : '#c0392b', borderRadius: '4px', textAlign: 'center' }}>
            {message}
          </div>
        )}

        {activeTab === 'login' && (
          <div style={{ background: 'white', padding: '30px', borderRadius: '8px', boxShadow: '0 2px 4px rgba(0,0,0,0.1)' }}>
            <h2 style={{ marginBottom: '20px', color: '#2c3e50' }}>Login to AutoNex</h2>
            <form onSubmit={handleLogin}>
              <div style={{ marginBottom: '15px' }}>
                <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold', color: '#2c3e50' }}>Email</label>
                <input 
                  type="email" 
                  placeholder="your@email.com" 
                  value={loginEmail}
                  onChange={(e) => setLoginEmail(e.target.value)}
                  required
                  style={{ width: '100%', padding: '10px', border: '1px solid #bdc3c7', borderRadius: '4px', fontSize: '14px' }} 
                />
              </div>
              <div style={{ marginBottom: '15px' }}>
                <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold', color: '#2c3e50' }}>Password</label>
                <input 
                  type="password" 
                  placeholder="Your password" 
                  value={loginPassword}
                  onChange={(e) => setLoginPassword(e.target.value)}
                  required
                  style={{ width: '100%', padding: '10px', border: '1px solid #bdc3c7', borderRadius: '4px', fontSize: '14px' }} 
                />
              </div>
              <button 
                type="submit" 
                disabled={loading}
                style={{ width: '100%', padding: '12px', background: '#27ae60', color: 'white', border: 'none', borderRadius: '4px', fontSize: '16px', fontWeight: 'bold', cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.6 : 1 }}
              >
                {loading ? 'Logging in...' : 'Login'}
              </button>
            </form>
          </div>
        )}

        {activeTab === 'register' && (
          <div style={{ background: 'white', padding: '30px', borderRadius: '8px', boxShadow: '0 2px 4px rgba(0,0,0,0.1)' }}>
            <h2 style={{ marginBottom: '20px', color: '#2c3e50' }}>Register for AutoNex</h2>
            <form onSubmit={handleRegister}>
              <div style={{ marginBottom: '15px' }}>
                <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold', color: '#2c3e50' }}>User Type</label>
                <select 
                  value={regUserType}
                  onChange={(e) => setRegUserType(e.target.value)}
                  style={{ width: '100%', padding: '10px', border: '1px solid #bdc3c7', borderRadius: '4px', fontSize: '14px' }}
                >
                  <option>Driver</option>
                  <option>Mechanic</option>
                </select>
              </div>
              <div style={{ marginBottom: '15px' }}>
                <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold', color: '#2c3e50' }}>Full Name</label>
                <input 
                  type="text" 
                  placeholder="Your name" 
                  value={regName}
                  onChange={(e) => setRegName(e.target.value)}
                  required
                  style={{ width: '100%', padding: '10px', border: '1px solid #bdc3c7', borderRadius: '4px', fontSize: '14px' }} 
                />
              </div>
              <div style={{ marginBottom: '15px' }}>
                <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold', color: '#2c3e50' }}>Email</label>
                <input 
                  type="email" 
                  placeholder="your@email.com" 
                  value={regEmail}
                  onChange={(e) => setRegEmail(e.target.value)}
                  required
                  style={{ width: '100%', padding: '10px', border: '1px solid #bdc3c7', borderRadius: '4px', fontSize: '14px' }} 
                />
              </div>
              <div style={{ marginBottom: '15px' }}>
                <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold', color: '#2c3e50' }}>Password</label>
                <input 
                  type="password" 
                  placeholder="Create a password" 
                  value={regPassword}
                  onChange={(e) => setRegPassword(e.target.value)}
                  required
                  style={{ width: '100%', padding: '10px', border: '1px solid #bdc3c7', borderRadius: '4px', fontSize: '14px' }} 
                />
              </div>
              <button 
                type="submit" 
                disabled={loading}
                style={{ width: '100%', padding: '12px', background: '#3498db', color: 'white', border: 'none', borderRadius: '4px', fontSize: '16px', fontWeight: 'bold', cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.6 : 1 }}
              >
                {loading ? 'Registering...' : 'Register'}
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

fs.writeFileSync(path.join(__dirname, 'src', 'App.jsx'), appJsx);
console.log('✓ Updated App.jsx with form handling and API calls');