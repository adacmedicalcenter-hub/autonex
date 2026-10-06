import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const appJsx = `import { useState, useEffect } from 'react'

export default function App() {
  const [activeTab, setActiveTab] = useState('login')
  const [user, setUser] = useState(null)
  const [token, setToken] = useState(null)
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState('')

  const [loginEmail, setLoginEmail] = useState('')
  const [loginPassword, setLoginPassword] = useState('')
  const [regUserType, setRegUserType] = useState('Driver')
  const [regName, setRegName] = useState('')
  const [regEmail, setRegEmail] = useState('')
  const [regPassword, setRegPassword] = useState('')

  const [repairRequests, setRepairRequests] = useState([])
  const [serviceOffers, setServiceOffers] = useState([])
  const [requestTitle, setRequestTitle] = useState('')
  const [requestDesc, setRequestDesc] = useState('')
  const [requestBudget, setRequestBudget] = useState('')
  const [offerName, setOfferName] = useState('')
  const [offerDesc, setOfferDesc] = useState('')
  const [offerRate, setOfferRate] = useState('')
  const [quotePrice, setQuotePrice] = useState('')
  const [quoteTime, setQuoteTime] = useState('')
  const [selectedRequest, setSelectedRequest] = useState(null)

  useEffect(() => {
    if (user?.userType === 'Driver') {
      setActiveTab('driver-dashboard')
    } else if (user?.userType === 'Mechanic') {
      setActiveTab('mechanic-dashboard')
    }
  }, [user])

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
        setUser(data.user)
        setToken(data.token)
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
        body: JSON.stringify({ userType: regUserType, fullName: regName, email: regEmail, password: regPassword })
      })
      const data = await response.json()
      if (response.ok) {
        setMessage('✓ Registration successful! Switch to Login tab.')
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

  const fetchRepairRequests = async () => {
    try {
      const response = await fetch('http://localhost:5000/api/repair-requests')
      const data = await response.json()
      setRepairRequests(data.repairRequests || [])
    } catch (error) {
      console.error('Error fetching repair requests:', error)
    }
  }

  const fetchServiceOffers = async () => {
    try {
      const response = await fetch('http://localhost:5000/api/service-offers')
      const data = await response.json()
      setServiceOffers(data.serviceOffers || [])
    } catch (error) {
      console.error('Error fetching service offers:', error)
    }
  }

  const handlePostRequest = async (e) => {
    e.preventDefault()
    setLoading(true)
    setMessage('')
    try {
      const response = await fetch('http://localhost:5000/api/repair-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': \`Bearer \${token}\` },
        body: JSON.stringify({ title: requestTitle, description: requestDesc, budgetMin: parseFloat(requestBudget) })
      })
      const data = await response.json()
      if (response.ok) {
        setMessage('✓ Repair request posted!')
        setRequestTitle('')
        setRequestDesc('')
        setRequestBudget('')
        fetchRepairRequests()
      } else {
        setMessage('✗ ' + (data.message || 'Failed to post'))
      }
    } catch (error) {
      setMessage('✗ Error: ' + error.message)
    }
    setLoading(false)
  }

  const handlePostOffer = async (e) => {
    e.preventDefault()
    setLoading(true)
    setMessage('')
    try {
      const response = await fetch('http://localhost:5000/api/service-offers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': \`Bearer \${token}\` },
        body: JSON.stringify({ serviceName: offerName, description: offerDesc, hourlyRate: parseFloat(offerRate) })
      })
      const data = await response.json()
      if (response.ok) {
        setMessage('✓ Service offer created!')
        setOfferName('')
        setOfferDesc('')
        setOfferRate('')
        fetchServiceOffers()
      } else {
        setMessage('✗ ' + (data.message || 'Failed'))
      }
    } catch (error) {
      setMessage('✗ Error: ' + error.message)
    }
    setLoading(false)
  }

  const handleSubmitQuote = async (e, requestId) => {
    e.preventDefault()
    setLoading(true)
    setMessage('')
    try {
      const response = await fetch(\`http://localhost:5000/api/repair-requests/\${requestId}/quotes\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': \`Bearer \${token}\` },
        body: JSON.stringify({ quotedPrice: parseFloat(quotePrice), estimatedTime: quoteTime })
      })
      const data = await response.json()
      if (response.ok) {
        setMessage('✓ Quote submitted!')
        setQuotePrice('')
        setQuoteTime('')
        setSelectedRequest(null)
      } else {
        setMessage('✗ ' + (data.message || 'Failed'))
      }
    } catch (error) {
      setMessage('✗ Error: ' + error.message)
    }
    setLoading(false)
  }

  if (!user) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        <header style={{ background: '#2c3e50', color: 'white', padding: '20px', textAlign: 'center' }}>
          <h1>🚗 AutoNex - On-Demand Car Repair</h1>
          <p>Connect with mechanics instantly</p>
        </header>

        <main style={{ flex: 1, padding: '40px 20px', maxWidth: '800px', margin: '0 auto', width: '100%' }}>
          <div style={{ display: 'flex', gap: '10px', marginBottom: '20px' }}>
            <button onClick={() => setActiveTab('login')} style={{ padding: '10px 20px', background: activeTab === 'login' ? '#3498db' : '#ecf0f1', color: activeTab === 'login' ? 'white' : '#2c3e50', border: 'none', borderRadius: '5px', cursor: 'pointer' }}>Login</button>
            <button onClick={() => setActiveTab('register')} style={{ padding: '10px 20px', background: activeTab === 'register' ? '#3498db' : '#ecf0f1', color: activeTab === 'register' ? 'white' : '#2c3e50', border: 'none', borderRadius: '5px', cursor: 'pointer' }}>Register</button>
          </div>

          {message && <div style={{ padding: '12px', marginBottom: '20px', background: message.includes('✓') ? '#d5f4e6' : '#fdeaea', color: message.includes('✓') ? '#27ae60' : '#c0392b', borderRadius: '4px', textAlign: 'center' }}>{message}</div>}

          {activeTab === 'login' && (
            <div style={{ background: 'white', padding: '30px', borderRadius: '8px', boxShadow: '0 2px 4px rgba(0,0,0,0.1)' }}>
              <h2 style={{ marginBottom: '20px', color: '#2c3e50' }}>Login to AutoNex</h2>
              <form onSubmit={handleLogin}>
                <div style={{ marginBottom: '15px' }}>
                  <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold', color: '#2c3e50' }}>Email</label>
                  <input type="email" placeholder="your@email.com" value={loginEmail} onChange={(e) => setLoginEmail(e.target.value)} required style={{ width: '100%', padding: '10px', border: '1px solid #bdc3c7', borderRadius: '4px' }} />
                </div>
                <div style={{ marginBottom: '15px' }}>
                  <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold', color: '#2c3e50' }}>Password</label>
                  <input type="password" placeholder="Your password" value={loginPassword} onChange={(e) => setLoginPassword(e.target.value)} required style={{ width: '100%', padding: '10px', border: '1px solid #bdc3c7', borderRadius: '4px' }} />
                </div>
                <button type="submit" disabled={loading} style={{ width: '100%', padding: '12px', background: '#27ae60', color: 'white', border: 'none', borderRadius: '4px', fontSize: '16px', fontWeight: 'bold', cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.6 : 1 }}>{loading ? 'Logging in...' : 'Login'}</button>
              </form>
            </div>
          )}

          {activeTab === 'register' && (
            <div style={{ background: 'white', padding: '30px', borderRadius: '8px', boxShadow: '0 2px 4px rgba(0,0,0,0.1)' }}>
              <h2 style={{ marginBottom: '20px', color: '#2c3e50' }}>Register for AutoNex</h2>
              <form onSubmit={handleRegister}>
                <div style={{ marginBottom: '15px' }}>
                  <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold', color: '#2c3e50' }}>User Type</label>
                  <select value={regUserType} onChange={(e) => setRegUserType(e.target.value)} style={{ width: '100%', padding: '10px', border: '1px solid #bdc3c7', borderRadius: '4px' }}>
                    <option>Driver</option>
                    <option>Mechanic</option>
                  </select>
                </div>
                <div style={{ marginBottom: '15px' }}>
                  <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold', color: '#2c3e50' }}>Full Name</label>
                  <input type="text" placeholder="Your name" value={regName} onChange={(e) => setRegName(e.target.value)} required style={{ width: '100%', padding: '10px', border: '1px solid #bdc3c7', borderRadius: '4px' }} />
                </div>
                <div style={{ marginBottom: '15px' }}>
                  <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold', color: '#2c3e50' }}>Email</label>
                  <input type="email" placeholder="your@email.com" value={regEmail} onChange={(e) => setRegEmail(e.target.value)} required style={{ width: '100%', padding: '10px', border: '1px solid #bdc3c7', borderRadius: '4px' }} />
                </div>
                <div style={{ marginBottom: '15px' }}>
                  <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold', color: '#2c3e50' }}>Password</label>
                  <input type="password" placeholder="Create a password" value={regPassword} onChange={(e) => setRegPassword(e.target.value)} required style={{ width: '100%', padding: '10px', border: '1px solid #bdc3c7', borderRadius: '4px' }} />
                </div>
                <button type="submit" disabled={loading} style={{ width: '100%', padding: '12px', background: '#3498db', color: 'white', border: 'none', borderRadius: '4px', fontSize: '16px', fontWeight: 'bold', cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.6 : 1 }}>{loading ? 'Registering...' : 'Register'}</button>
              </form>
            </div>
          )}
        </main>

        <footer style={{ background: '#2c3e50', color: 'white', padding: '20px', textAlign: 'center' }}>
          <p>AutoNex © 2024 - Connecting Drivers with Mechanics</p>
        </footer>
      </div>
    )
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: '#f5f5f5' }}>
      <header style={{ background: '#2c3e50', color: 'white', padding: '20px', textAlign: 'center', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 style={{ margin: 0 }}>🚗 AutoNex</h1>
          <p style={{ margin: 0, fontSize: '14px' }}>Welcome, {user.email} ({user.userType})</p>
        </div>
        <button onClick={() => { setUser(null); setToken(null); setActiveTab('login'); }} style={{ padding: '10px 20px', background: '#e74c3c', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>Logout</button>
      </header>

      <main style={{ flex: 1, padding: '20px', maxWidth: '1200px', margin: '0 auto', width: '100%' }}>
        <div style={{ display: 'flex', gap: '10px', marginBottom: '20px', flexWrap: 'wrap' }}>
          {user.userType === 'Driver' ? (
            <>
              <button onClick={() => { setActiveTab('driver-dashboard'); fetchRepairRequests(); }} style={{ padding: '10px 20px', background: activeTab === 'driver-dashboard' ? '#3498db' : '#ecf0f1', color: activeTab === 'driver-dashboard' ? 'white' : '#2c3e50', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>My Requests</button>
              <button onClick={() => { setActiveTab('post-request'); }} style={{ padding: '10px 20px', background: activeTab === 'post-request' ? '#3498db' : '#ecf0f1', color: activeTab === 'post-request' ? 'white' : '#2c3e50', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>Post Request</button>
              <button onClick={() => { setActiveTab('browse-mechanics'); fetchServiceOffers(); }} style={{ padding: '10px 20px', background: activeTab === 'browse-mechanics' ? '#3498db' : '#ecf0f1', color: activeTab === 'browse-mechanics' ? 'white' : '#2c3e50', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>Browse Mechanics</button>
            </>
          ) : (
            <>
              <button onClick={() => { setActiveTab('mechanic-dashboard'); fetchServiceOffers(); }} style={{ padding: '10px 20px', background: activeTab === 'mechanic-dashboard' ? '#3498db' : '#ecf0f1', color: activeTab === 'mechanic-dashboard' ? 'white' : '#2c3e50', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>My Services</button>
              <button onClick={() => { setActiveTab('post-offer'); }} style={{ padding: '10px 20px', background: activeTab === 'post-offer' ? '#3498db' : '#ecf0f1', color: activeTab === 'post-offer' ? 'white' : '#2c3e50', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>Post Service</button>
              <button onClick={() => { setActiveTab('browse-requests'); fetchRepairRequests(); }} style={{ padding: '10px 20px', background: activeTab === 'browse-requests' ? '#3498db' : '#ecf0f1', color: activeTab === 'browse-requests' ? 'white' : '#2c3e50', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>Browse Requests</button>
            </>
          )}
        </div>

        {message && <div style={{ padding: '12px', marginBottom: '20px', background: message.includes('✓') ? '#d5f4e6' : '#fdeaea', color: message.includes('✓') ? '#27ae60' : '#c0392b', borderRadius: '4px', textAlign: 'center' }}>{message}</div>}

        {activeTab === 'driver-dashboard' && (
          <div style={{ background: 'white', padding: '20px', borderRadius: '8px', boxShadow: '0 2px 4px rgba(0,0,0,0.1)' }}>
            <h2>My Repair Requests</h2>
            {repairRequests.filter(r => r.driver_id === user.id).length === 0 ? <p>No requests yet</p> : repairRequests.filter(r => r.driver_id === user.id).map(r => (
              <div key={r.id} style={{ padding: '15px', border: '1px solid #ddd', marginBottom: '10px', borderRadius: '4px' }}>
                <h3>{r.title}</h3>
                <p>{r.description}</p>
                <p><strong>Budget:</strong> \${r.budget_min} - \${r.budget_max}</p>
                <p><strong>Status:</strong> {r.status}</p>
              </div>
            ))}
          </div>
        )}

        {activeTab === 'post-request' && (
          <div style={{ background: 'white', padding: '20px', borderRadius: '8px', boxShadow: '0 2px 4px rgba(0,0,0,0.1)' }}>
            <h2>Post a Repair Request</h2>
            <form onSubmit={handlePostRequest}>
              <input type="text" placeholder="Title (e.g., Engine Repair)" value={requestTitle} onChange={(e) => setRequestTitle(e.target.value)} required style={{ width: '100%', padding: '10px', marginBottom: '10px', border: '1px solid #ddd', borderRadius: '4px' }} />
              <textarea placeholder="Describe your repair need..." value={requestDesc} onChange={(e) => setRequestDesc(e.target.value)} required style={{ width: '100%', padding: '10px', marginBottom: '10px', border: '1px solid #ddd', borderRadius: '4px', height: '100px' }} />
              <input type="number" placeholder="Budget (e.g., 100)" value={requestBudget} onChange={(e) => setRequestBudget(e.target.value)} required style={{ width: '100%', padding: '10px', marginBottom: '10px', border: '1px solid #ddd', borderRadius: '4px' }} />
              <button type="submit" disabled={loading} style={{ width: '100%', padding: '12px', background: '#27ae60', color: 'white', border: 'none', borderRadius: '4px', cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.6 : 1 }}>{loading ? 'Posting...' : 'Post Request'}</button>
            </form>
          </div>
        )}

        {activeTab === 'browse-mechanics' && (
          <div style={{ background: 'white', padding: '20px', borderRadius: '8px', boxShadow: '0 2px 4px rgba(0,0,0,0.1)' }}>
            <h2>Available Mechanics</h2>
            {serviceOffers.length === 0 ? <p>No mechanics available</p> : serviceOffers.map(o => (
              <div key={o.id} style={{ padding: '15px', border: '1px solid #ddd', marginBottom: '10px', borderRadius: '4px' }}>
                <h3>{o.service_name}</h3>
                <p>{o.description}</p>
                <p><strong>Mechanic:</strong> {o.full_name}</p>
                <p><strong>Rate:</strong> \${o.hourly_rate}/hr</p>
              </div>
            ))}
          </div>
        )}

        {activeTab === 'mechanic-dashboard' && (
          <div style={{ background: 'white', padding: '20px', borderRadius: '8px', boxShadow: '0 2px 4px rgba(0,0,0,0.1)' }}>
            <h2>My Services</h2>
            {serviceOffers.filter(s => s.mechanic_id === user.id).length === 0 ? <p>No services posted</p> : serviceOffers.filter(s => s.mechanic_id === user.id).map(s => (
              <div key={s.id} style={{ padding: '15px', border: '1px solid #ddd', marginBottom: '10px', borderRadius: '4px' }}>
                <h3>{s.service_name}</h3>
                <p>{s.description}</p>
                <p><strong>Rate:</strong> \${s.hourly_rate}/hr</p>
              </div>
            ))}
          </div>
        )}

        {activeTab === 'post-offer' && (
          <div style={{ background: 'white', padding: '20px', borderRadius: '8px', boxShadow: '0 2px 4px rgba(0,0,0,0.1)' }}>
            <h2>Post a Service Offer</h2>
            <form onSubmit={handlePostOffer}>
              <input type="text" placeholder="Service (e.g., Engine Repair)" value={offerName} onChange={(e) => setOfferName(e.target.value)} required style={{ width: '100%', padding: '10px', marginBottom: '10px', border: '1px solid #ddd', borderRadius: '4px' }} />
              <textarea placeholder="Describe your service..." value={offerDesc} onChange={(e) => setOfferDesc(e.target.value)} style={{ width: '100%', padding: '10px', marginBottom: '10px', border: '1px solid #ddd', borderRadius: '4px', height: '100px' }} />
              <input type="number" placeholder="Hourly Rate" value={offerRate} onChange={(e) => setOfferRate(e.target.value)} required style={{ width: '100%', padding: '10px', marginBottom: '10px', border: '1px solid #ddd', borderRadius: '4px' }} />
              <button type="submit" disabled={loading} style={{ width: '100%', padding: '12px', background: '#27ae60', color: 'white', border: 'none', borderRadius: '4px', cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.6 : 1 }}>{loading ? 'Posting...' : 'Post Service'}</button>
            </form>
          </div>
        )}

        {activeTab === 'browse-requests' && (
          <div style={{ background: 'white', padding: '20px', borderRadius: '8px', boxShadow: '0 2px 4px rgba(0,0,0,0.1)' }}>
            <h2>Available Repair Requests</h2>
            {repairRequests.length === 0 ? <p>No requests available</p> : repairRequests.map(r => (
              <div key={r.id} style={{ padding: '15px', border: '1px solid #ddd', marginBottom: '10px', borderRadius: '4px' }}>
                <h3>{r.title}</h3>
                <p>{r.description}</p>
                <p><strong>Budget:</strong> \${r.budget_min}</p>
                <p><strong>Posted by:</strong> {r.full_name}</p>
                {selectedRequest === r.id ? (
                  <form onSubmit={(e) => handleSubmitQuote(e, r.id)} style={{ background: '#f9f9f9', padding: '10px', borderRadius: '4px' }}>
                    <input type="number" placeholder="Your Quote Price" value={quotePrice} onChange={(e) => setQuotePrice(e.target.value)} required style={{ width: '100%', padding: '8px', marginBottom: '8px', border: '1px solid #ddd', borderRadius: '4px' }} />
                    <input type="text" placeholder="Estimated Time (e.g., 2 hours)" value={quoteTime} onChange={(e) => setQuoteTime(e.target.value)} required style={{ width: '100%', padding: '8px', marginBottom: '8px', border: '1px solid #ddd', borderRadius: '4px' }} />
                    <button type="submit" disabled={loading} style={{ width: '100%', padding: '8px', background: '#27ae60', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>Submit Quote</button>
                  </form>
                ) : (
                  <button onClick={() => setSelectedRequest(r.id)} style={{ padding: '8px 16px', background: '#3498db', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>Submit Quote</button>
                )}
              </div>
            ))}
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
console.log('✓ Updated App.jsx with marketplace features');