import React, { useState, useEffect, useRef } from 'react';
import io from 'socket.io-client';
import './App.css';

export default function App() {
  const [authState, setAuthState] = useState('welcome');
  const [userType, setUserType] = useState(null);
  const [userId, setUserId] = useState(null);
  const [fullName, setFullName] = useState('');
  const [token, setToken] = useState(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  // Marketplace state
  const [activeTab, setActiveTab] = useState('my-requests');
  const [myRequests, setMyRequests] = useState([]);
  const [allRequests, setAllRequests] = useState([]);
  const [myServices, setMyServices] = useState([]);
  const [allServices, setAllServices] = useState([]);

  // Chat state
  const [conversations, setConversations] = useState([]);
  const [selectedConversation, setSelectedConversation] = useState(null);
  const [messages, setMessages] = useState([]);
  const [messageInput, setMessageInput] = useState('');
  const socketRef = useRef(null);

  // Form state
  const [phoneNumber, setPhoneNumber] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [savedPhones, setSavedPhones] = useState([]);
  const [showPhoneSuggestions, setShowPhoneSuggestions] = useState(false);
  const [fullNameInput, setFullNameInput] = useState('');
  const [requestTitle, setRequestTitle] = useState('');
  const [requestDesc, setRequestDesc] = useState('');
  const [vehicleType, setVehicleType] = useState('');
  const [location, setLocation] = useState('');
  const [budgetMin, setBudgetMin] = useState('');
  const [budgetMax, setBudgetMax] = useState('');
  const [serviceName, setServiceName] = useState('');
  const [serviceDesc, setServiceDesc] = useState('');
  const [specialization, setSpecialization] = useState('');
  const [hourlyRate, setHourlyRate] = useState('');
  const [quotePrice, setQuotePrice] = useState('');
  const [estimatedTime, setEstimatedTime] = useState('');
  const [quoteDesc, setQuoteDesc] = useState('');
  const [selectedRequest, setSelectedRequest] = useState(null);
  const [editingServiceId, setEditingServiceId] = useState(null);
  const [editServiceName, setEditServiceName] = useState('');
  const [editServiceDesc, setEditServiceDesc] = useState('');
  const [editSpecialization, setEditSpecialization] = useState('');
  const [editHourlyRate, setEditHourlyRate] = useState('');
  const [editLocation, setEditLocation] = useState('');
  const [servicePhoneNumber, setServicePhoneNumber] = useState('');
  const [editServicePhoneNumber, setEditServicePhoneNumber] = useState('');

  const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000';

  // Check for saved login on app load
  useEffect(() => {
    // Load saved phone numbers
    const phones = localStorage.getItem('autonex_saved_phones');
    if (phones) {
      try {
        setSavedPhones(JSON.parse(phones));
      } catch (error) {
        console.error('Error loading saved phones:', error);
      }
    }

    const savedUser = localStorage.getItem('autonex_user');
    if (savedUser) {
      try {
        const user = JSON.parse(savedUser);
        setToken(user.token);
        setUserId(user.userId);
        setUserType(user.userType);
        setFullName(user.fullName);
        setAuthState('dashboard');
        setPhoneNumber(user.phoneNumber);
        setRememberMe(true);
        loadConversations(user.token, user.userId);
      } catch (error) {
        console.error('Error loading saved user:', error);
        localStorage.removeItem('autonex_user');
      }
    }
  }, []);

  useEffect(() => {
    if (token && userId) {
      socketRef.current = io(API_URL);
      socketRef.current.emit('user_login', { userId });

      socketRef.current.on('receive_message', (message) => {
        setMessages(prev => [...prev, message]);
      });

      // Load services and requests on app load
      loadAllServices();
      loadAllRequests();

      return () => {
        socketRef.current?.disconnect();
      };
    }
  }, [token, userId]);

  // Auto-populate phone number when mechanic opens post-service tab
  useEffect(() => {
    if (activeTab === 'post-service' && userType === 'mechanic' && phoneNumber && !servicePhoneNumber) {
      setServicePhoneNumber(phoneNumber);
    }
  }, [activeTab, userType, phoneNumber, servicePhoneNumber]);

  const handleRegister = async () => {
    setErrorMsg('');
    setSuccessMsg('');
    if (!fullNameInput || !phoneNumber || !password) {
      setErrorMsg('Please fill in all fields');
      return;
    }
    try {
      const response = await fetch(`${API_URL}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_type: userType,
          full_name: fullNameInput,
          phone_number: phoneNumber,
          password
        })
      });
      const data = await response.json();
      if (response.ok) {
        setSuccessMsg('Registration successful! Please log in.');
        setAuthState('login');
        setPhoneNumber('');
        setPassword('');
        setFullNameInput('');
      } else {
        setErrorMsg(data.error || 'Registration failed');
      }
    } catch (error) {
      setErrorMsg('Registration failed: ' + error.message);
    }
  };

  const handleLogin = async () => {
    setErrorMsg('');
    setSuccessMsg('');
    if (!phoneNumber || !password) {
      setErrorMsg('Please fill in all fields');
      return;
    }
    try {
      const response = await fetch(`${API_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone_number: phoneNumber, password })
      });
      const data = await response.json();
      if (response.ok) {
        setToken(data.token);
        setUserId(data.userId);
        setUserType(data.userType);
        setFullName(data.fullName);
        setAuthState('dashboard');
        setSuccessMsg('Login successful!');

        // Save phone to saved phones list
        setSavedPhones(prev => {
          const updated = prev.includes(phoneNumber) ? prev : [phoneNumber, ...prev].slice(0, 5);
          localStorage.setItem('autonex_saved_phones', JSON.stringify(updated));
          return updated;
        });

        // Save login details if "Remember me" is checked
        if (rememberMe) {
          localStorage.setItem('autonex_user', JSON.stringify({
            token: data.token,
            userId: data.userId,
            userType: data.userType,
            fullName: data.fullName,
            phoneNumber: phoneNumber
          }));
        } else {
          localStorage.removeItem('autonex_user');
        }

        loadConversations(data.token, data.userId);
        if (data.userType === 'driver') {
          setActiveTab('my-requests');
        } else {
          setActiveTab('my-services');
        }
      } else {
        setErrorMsg(data.error || 'Login failed');
      }
    } catch (error) {
      setErrorMsg('Login failed: ' + error.message);
    }
  };

  const loadConversations = async (authToken, uid) => {
    try {
      const response = await fetch(`${API_URL}/api/conversations`, {
        headers: { 'Authorization': `Bearer ${authToken}` }
      });
      if (response.ok) {
        const data = await response.json();
        setConversations(data);
      }
    } catch (error) {
      console.error('Error loading conversations:', error);
    }
  };

  const handlePostRequest = async () => {
    setErrorMsg('');
    if (!requestTitle || !requestDesc || !vehicleType || !location) {
      setErrorMsg('Please fill in all fields');
      return;
    }
    try {
      const response = await fetch(`${API_URL}/api/repair-requests`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          title: requestTitle,
          description: requestDesc,
          vehicle_type: vehicleType,
          location,
          budget_min: 0,
          budget_max: 0
        })
      });
      if (response.ok) {
        setSuccessMsg('Request posted successfully!');
        setRequestTitle('');
        setRequestDesc('');
        setVehicleType('');
        setLocation('');
        loadAllRequests();
      } else {
        setErrorMsg('Failed to post request');
      }
    } catch (error) {
      setErrorMsg('Error: ' + error.message);
    }
  };

  const loadAllRequests = async () => {
    try {
      const response = await fetch(`${API_URL}/api/repair-requests`);
      if (response.ok) {
        const data = await response.json();
        setAllRequests(data);
      }
    } catch (error) {
      console.error('Error loading requests:', error);
    }
  };

  const handlePostService = async () => {
    setErrorMsg('');
    if (!serviceName || !serviceDesc || !specialization || !hourlyRate || !location || !servicePhoneNumber) {
      setErrorMsg('Please fill in all fields');
      return;
    }
    try {
      const response = await fetch(`${API_URL}/api/service-offers`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          service_name: serviceName,
          description: serviceDesc,
          specialization,
          hourly_rate: parseFloat(hourlyRate),
          location,
          phone_number: servicePhoneNumber,
          availability: 'Available'
        })
      });
      if (response.ok) {
        setSuccessMsg('Service posted successfully!');
        setServiceName('');
        setServiceDesc('');
        setSpecialization('');
        setHourlyRate('');
        setServicePhoneNumber('');
        setLocation('');
        loadAllServices();
      } else {
        setErrorMsg('Failed to post service');
      }
    } catch (error) {
      setErrorMsg('Error: ' + error.message);
    }
  };

  const loadAllServices = async () => {
    try {
      const response = await fetch(`${API_URL}/api/service-offers`);
      if (response.ok) {
        const data = await response.json();
        setAllServices(data);
      }
    } catch (error) {
      console.error('Error loading services:', error);
    }
  };

  const startEditService = (service) => {
    setEditingServiceId(service.id);
    setEditServiceName(service.service_name);
    setEditServiceDesc(service.description);
    setEditSpecialization(service.specialization);
    setEditHourlyRate(service.hourly_rate);
    setEditServicePhoneNumber(service.phone_number);
    setEditLocation(service.location);
  };

  const handleEditService = async () => {
    setErrorMsg('');
    if (!editServiceName || !editServiceDesc || !editSpecialization || !editHourlyRate || !editLocation || !editServicePhoneNumber) {
      setErrorMsg('Please fill in all fields');
      return;
    }
    try {
      const response = await fetch(`${API_URL}/api/service-offers/${editingServiceId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          service_name: editServiceName,
          description: editServiceDesc,
          specialization: editSpecialization,
          hourly_rate: parseFloat(editHourlyRate),
          location: editLocation,
          phone_number: editServicePhoneNumber,
          availability: 'Available'
        })
      });
      if (response.ok) {
        setSuccessMsg('Service updated successfully!');
        setEditingServiceId(null);
        loadAllServices();
      } else {
        setErrorMsg('Failed to update service');
      }
    } catch (error) {
      setErrorMsg('Error: ' + error.message);
    }
  };

  const handleDeleteService = async (serviceId) => {
    if (window.confirm('Are you sure you want to delete this service?')) {
      setErrorMsg('');
      try {
        const response = await fetch(`${API_URL}/api/service-offers/${serviceId}`, {
          method: 'DELETE',
          headers: {
            'Authorization': `Bearer ${token}`
          }
        });
        const data = await response.json();
        if (response.ok) {
          setSuccessMsg('Service deleted successfully!');
          loadAllServices();
        } else {
          setErrorMsg(data.error || 'Failed to delete service');
        }
      } catch (error) {
        setErrorMsg('Error: ' + error.message);
      }
    }
  };

  const handleSubmitQuote = async (requestId) => {
    setErrorMsg('');
    if (!quotePrice || !estimatedTime || !quoteDesc) {
      setErrorMsg('Please fill in all quote fields');
      return;
    }
    try {
      const response = await fetch(`${API_URL}/api/repair-requests/${requestId}/quotes`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          quoted_price: parseFloat(quotePrice),
          estimated_time: estimatedTime,
          description: quoteDesc
        })
      });
      if (response.ok) {
        setSuccessMsg('Quote submitted successfully!');
        setQuotePrice('');
        setEstimatedTime('');
        setQuoteDesc('');
        setSelectedRequest(null);
      } else {
        setErrorMsg('Failed to submit quote');
      }
    } catch (error) {
      setErrorMsg('Error: ' + error.message);
    }
  };

  const startConversation = async (otherId, requestId) => {
    try {
      const response = await fetch(`${API_URL}/api/conversations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          other_user_id: otherId,
          repair_request_id: requestId
        })
      });
      if (response.ok) {
        const conversation = await response.json();
        setSelectedConversation(conversation.id);
        setActiveTab('messages');
        socketRef.current?.emit('join_conversation', { conversationId: conversation.id });
        loadMessages(conversation.id);
        loadConversations(token, userId);
      }
    } catch (error) {
      setErrorMsg('Error starting conversation: ' + error.message);
    }
  };

  const loadMessages = async (conversationId) => {
    try {
      const response = await fetch(`${API_URL}/api/conversations/${conversationId}/messages`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (response.ok) {
        const data = await response.json();
        setMessages(data);
      }
    } catch (error) {
      console.error('Error loading messages:', error);
    }
  };

  const handleSendMessage = () => {
    if (!messageInput.trim() || !selectedConversation) return;

    socketRef.current?.emit('send_message', {
      conversationId: selectedConversation,
      senderId: userId,
      senderType: userType,
      messageText: messageInput
    });

    setMessageInput('');
  };

  const removeSavedPhone = (phoneToRemove) => {
    const updated = savedPhones.filter(p => p !== phoneToRemove);
    setSavedPhones(updated);
    localStorage.setItem('autonex_saved_phones', JSON.stringify(updated));
  };

  const handleLogout = () => {
    setToken(null);
    setUserId(null);
    setUserType(null);
    setFullName('');
    setAuthState('welcome');
    setConversations([]);
    setMessages([]);
    setSelectedConversation(null);
    setPhoneNumber('');
    setPassword('');
    setRememberMe(false);
    localStorage.removeItem('autonex_user');
    socketRef.current?.disconnect();
  };

  // Welcome screen
  if (authState === 'welcome') {
    return (
      <div style={{ maxWidth: '500px', margin: '50px auto', padding: '20px', textAlign: 'center' }}>
        <h1>🚗 AutoNex</h1>
        <p>On-Demand Car Repairs Marketplace</p>
        <button
          onClick={() => { setUserType('driver'); setAuthState('register'); }}
          style={{ margin: '10px', padding: '10px 20px', fontSize: '16px', backgroundColor: '#007bff', color: 'white', border: 'none', borderRadius: '5px', cursor: 'pointer' }}
        >
          Register as Driver
        </button>
        <button
          onClick={() => { setUserType('mechanic'); setAuthState('register'); }}
          style={{ margin: '10px', padding: '10px 20px', fontSize: '16px', backgroundColor: '#28a745', color: 'white', border: 'none', borderRadius: '5px', cursor: 'pointer' }}
        >
          Register as Mechanic
        </button>
      </div>
    );
  }

  // Register screen
  if (authState === 'register') {
    return (
      <div style={{ maxWidth: '500px', margin: '50px auto', padding: '20px', border: '1px solid #ccc', borderRadius: '10px' }}>
        <h2>Register as {userType === 'driver' ? 'Driver' : 'Mechanic'}</h2>
        {errorMsg && <p style={{ color: 'red' }}>{errorMsg}</p>}
        {successMsg && <p style={{ color: 'green' }}>{successMsg}</p>}
        <input
          type="text"
          placeholder="Full Name"
          value={fullNameInput}
          onChange={(e) => setFullNameInput(e.target.value)}
          onKeyPress={(e) => e.key === 'Enter' && handleRegister()}
          style={{ width: '100%', margin: '10px 0', padding: '10px', fontSize: '16px', borderRadius: '5px', border: '1px solid #ddd', boxSizing: 'border-box' }}
        />
        <input
          type="tel"
          placeholder="Phone Number"
          value={phoneNumber}
          onChange={(e) => setPhoneNumber(e.target.value)}
          onKeyPress={(e) => e.key === 'Enter' && handleRegister()}
          style={{ width: '100%', margin: '10px 0', padding: '10px', fontSize: '16px', borderRadius: '5px', border: '1px solid #ddd', boxSizing: 'border-box' }}
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyPress={(e) => e.key === 'Enter' && handleRegister()}
          style={{ width: '100%', margin: '10px 0', padding: '10px', fontSize: '16px', borderRadius: '5px', border: '1px solid #ddd', boxSizing: 'border-box' }}
        />
        <button
          onClick={handleRegister}
          style={{ width: '100%', margin: '10px 0', padding: '10px', fontSize: '16px', backgroundColor: userType === 'driver' ? '#007bff' : '#28a745', color: 'white', border: 'none', borderRadius: '5px', cursor: 'pointer' }}
        >
          Register
        </button>
        <button
          onClick={() => { setAuthState('login'); }}
          style={{ width: '100%', margin: '10px 0', padding: '10px', fontSize: '16px', backgroundColor: '#6c757d', color: 'white', border: 'none', borderRadius: '5px', cursor: 'pointer' }}
        >
          Go to Login
        </button>
      </div>
    );
  }

  // Login screen
  if (authState === 'login') {
    return (
      <div style={{ maxWidth: '500px', margin: '50px auto', padding: '20px', border: '1px solid #ccc', borderRadius: '10px' }}>
        <h2>Login</h2>
        {errorMsg && <p style={{ color: 'red' }}>{errorMsg}</p>}
        {successMsg && <p style={{ color: 'green' }}>{successMsg}</p>}
        <div style={{ position: 'relative' }}>
          <input
            type="tel"
            placeholder="Phone Number"
            value={phoneNumber}
            onChange={(e) => {
              setPhoneNumber(e.target.value);
              setShowPhoneSuggestions(true);
            }}
            onFocus={() => setShowPhoneSuggestions(true)}
            onBlur={() => setTimeout(() => setShowPhoneSuggestions(false), 200)}
            onKeyPress={(e) => e.key === 'Enter' && handleLogin()}
            style={{ width: '100%', margin: '10px 0', padding: '10px', fontSize: '16px', borderRadius: '5px', border: '1px solid #ddd', boxSizing: 'border-box' }}
          />
          {showPhoneSuggestions && savedPhones.length > 0 && (
            <div style={{ position: 'absolute', top: '100%', left: '0', right: '0', backgroundColor: 'white', border: '1px solid #ddd', borderTop: 'none', borderRadius: '0 0 5px 5px', maxHeight: '200px', overflowY: 'auto', zIndex: '10' }}>
              {savedPhones.map((savedPhone, idx) => (
                <div
                  key={idx}
                  style={{
                    padding: '12px 10px',
                    borderBottom: idx < savedPhones.length - 1 ? '1px solid #eee' : 'none',
                    cursor: 'pointer',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    fontSize: '14px'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#f0f0f0'}
                  onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'white'}
                  onClick={() => {
                    setPhoneNumber(savedPhone);
                    setShowPhoneSuggestions(false);
                  }}
                >
                  <span style={{ display: 'flex', alignItems: 'center' }}>📱 {savedPhone}</span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      removeSavedPhone(savedPhone);
                    }}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: '#999',
                      cursor: 'pointer',
                      fontSize: '16px',
                      padding: '0 5px'
                    }}
                    title="Remove this phone"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyPress={(e) => e.key === 'Enter' && handleLogin()}
          style={{ width: '100%', margin: '10px 0', padding: '10px', fontSize: '16px', borderRadius: '5px', border: '1px solid #ddd', boxSizing: 'border-box' }}
        />
        <div style={{ margin: '10px 0', display: 'flex', alignItems: 'center' }}>
          <input
            type="checkbox"
            id="rememberMe"
            checked={rememberMe}
            onChange={(e) => setRememberMe(e.target.checked)}
            style={{ marginRight: '8px', cursor: 'pointer' }}
          />
          <label htmlFor="rememberMe" style={{ cursor: 'pointer', fontSize: '14px' }}>
            Remember me for next time
          </label>
        </div>
        <button
          onClick={handleLogin}
          style={{ width: '100%', margin: '10px 0', padding: '10px', fontSize: '16px', backgroundColor: '#007bff', color: 'white', border: 'none', borderRadius: '5px', cursor: 'pointer' }}
        >
          Login
        </button>
        <button
          onClick={() => { setAuthState('welcome'); }}
          style={{ width: '100%', margin: '10px 0', padding: '10px', fontSize: '16px', backgroundColor: '#6c757d', color: 'white', border: 'none', borderRadius: '5px', cursor: 'pointer' }}
        >
          Back
        </button>
      </div>
    );
  }

  // Dashboard screen
  return (
    <div style={{ padding: '20px', fontFamily: 'Arial, sans-serif' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', borderBottom: '2px solid #007bff', paddingBottom: '10px' }}>
        <h1>🚗 AutoNex - {userType === 'driver' ? 'Driver' : 'Mechanic'} Dashboard</h1>
        <div>
          <span style={{ marginRight: '20px' }}>Welcome, {fullName}</span>
          <button
            onClick={handleLogout}
            style={{ padding: '8px 15px', backgroundColor: '#dc3545', color: 'white', border: 'none', borderRadius: '5px', cursor: 'pointer' }}
          >
            Logout
          </button>
        </div>
      </div>

      {errorMsg && <p style={{ color: 'red', padding: '10px', backgroundColor: '#f8d7da', borderRadius: '5px' }}>{errorMsg}</p>}
      {successMsg && <p style={{ color: 'green', padding: '10px', backgroundColor: '#d4edda', borderRadius: '5px' }}>{successMsg}</p>}

      <div style={{ display: 'flex', gap: '20px' }}>
        <div style={{ flex: userType === 'driver' ? '1' : '1' }}>
          <div style={{ display: 'flex', gap: '10px', marginBottom: '20px', borderBottom: '1px solid #ddd', paddingBottom: '10px' }}>
            {userType === 'driver' ? (
              <>
                <button onClick={() => setActiveTab('my-requests')} style={{ padding: '10px 15px', backgroundColor: activeTab === 'my-requests' ? '#007bff' : '#e9ecef', color: activeTab === 'my-requests' ? 'white' : 'black', border: 'none', borderRadius: '5px', cursor: 'pointer' }}>My Requests</button>
                <button onClick={() => setActiveTab('post-request')} style={{ padding: '10px 15px', backgroundColor: activeTab === 'post-request' ? '#007bff' : '#e9ecef', color: activeTab === 'post-request' ? 'white' : 'black', border: 'none', borderRadius: '5px', cursor: 'pointer' }}>Post Request</button>
                <button onClick={() => { setActiveTab('browse-mechanics'); loadAllServices(); }} style={{ padding: '10px 15px', backgroundColor: activeTab === 'browse-mechanics' ? '#007bff' : '#e9ecef', color: activeTab === 'browse-mechanics' ? 'white' : 'black', border: 'none', borderRadius: '5px', cursor: 'pointer' }}>Browse Mechanics</button>
              </>
            ) : (
              <>
                <button onClick={() => setActiveTab('my-services')} style={{ padding: '10px 15px', backgroundColor: activeTab === 'my-services' ? '#28a745' : '#e9ecef', color: activeTab === 'my-services' ? 'white' : 'black', border: 'none', borderRadius: '5px', cursor: 'pointer' }}>My Services</button>
                <button onClick={() => setActiveTab('post-service')} style={{ padding: '10px 15px', backgroundColor: activeTab === 'post-service' ? '#28a745' : '#e9ecef', color: activeTab === 'post-service' ? 'white' : 'black', border: 'none', borderRadius: '5px', cursor: 'pointer' }}>Post Service</button>
                <button onClick={() => { setActiveTab('browse-requests'); loadAllRequests(); }} style={{ padding: '10px 15px', backgroundColor: activeTab === 'browse-requests' ? '#28a745' : '#e9ecef', color: activeTab === 'browse-requests' ? 'white' : 'black', border: 'none', borderRadius: '5px', cursor: 'pointer' }}>Browse Requests</button>
              </>
            )}
            <button onClick={() => setActiveTab('messages')} style={{ padding: '10px 15px', backgroundColor: activeTab === 'messages' ? '#ffc107' : '#e9ecef', color: activeTab === 'messages' ? 'black' : 'black', border: 'none', borderRadius: '5px', cursor: 'pointer' }}>💬 Messages</button>
          </div>

          {/* Driver tabs */}
          {userType === 'driver' && activeTab === 'my-requests' && (
            <div>
              <h3>My Repair Requests</h3>
              {allRequests.filter(r => r.driver_id === userId).map(request => (
                <div key={request.id} style={{ padding: '15px', margin: '10px 0', border: '1px solid #ddd', borderRadius: '5px', backgroundColor: '#f9f9f9' }}>
                  <h4>{request.title}</h4>
                  <p><strong>Vehicle:</strong> {request.vehicle_type}</p>
                  <p><strong>Location:</strong> {request.location}</p>
                  <p><strong>Status:</strong> {request.status}</p>
                </div>
              ))}
            </div>
          )}

          {userType === 'driver' && activeTab === 'post-request' && (
            <div>
              <h3>Post a Repair Request</h3>
              <input type="text" placeholder="Service Title" value={requestTitle} onChange={(e) => setRequestTitle(e.target.value)} style={{ width: '100%', margin: '10px 0', padding: '10px', fontSize: '14px', borderRadius: '5px', border: '1px solid #ddd', boxSizing: 'border-box' }} />
              <textarea placeholder="Describe your issue" value={requestDesc} onChange={(e) => setRequestDesc(e.target.value)} style={{ width: '100%', margin: '10px 0', padding: '10px', fontSize: '14px', borderRadius: '5px', border: '1px solid #ddd', minHeight: '100px', boxSizing: 'border-box' }}></textarea>
              <input type="text" placeholder="Vehicle Type" value={vehicleType} onChange={(e) => setVehicleType(e.target.value)} style={{ width: '100%', margin: '10px 0', padding: '10px', fontSize: '14px', borderRadius: '5px', border: '1px solid #ddd', boxSizing: 'border-box' }} />
              <input type="text" placeholder="Location" value={location} onChange={(e) => setLocation(e.target.value)} style={{ width: '100%', margin: '10px 0', padding: '10px', fontSize: '14px', borderRadius: '5px', border: '1px solid #ddd', boxSizing: 'border-box' }} />
              <button onClick={handlePostRequest} style={{ width: '100%', margin: '10px 0', padding: '10px', fontSize: '16px', backgroundColor: '#007bff', color: 'white', border: 'none', borderRadius: '5px', cursor: 'pointer' }}>Post Request</button>
            </div>
          )}

          {userType === 'driver' && activeTab === 'browse-mechanics' && (
            <div>
              <h3>Browse Mechanics</h3>
              {allServices.map(service => (
                <div key={service.id} style={{ padding: '15px', margin: '10px 0', border: '1px solid #ddd', borderRadius: '5px', backgroundColor: '#f9f9f9' }}>
                  <h4>{service.service_name}</h4>
                  <p><strong>Mechanic:</strong> {service.mechanic_name}</p>
                  <p><strong>Specialization:</strong> {service.specialization}</p>
                  <p><strong>Rate:</strong> ${service.hourly_rate}/hour</p>
                  <p><strong>Location:</strong> {service.location}</p>
                  {service.phone_number ? <p><strong>Phone:</strong> {service.phone_number}</p> : null}
                  <button onClick={() => startConversation(service.mechanic_id, null)} style={{ padding: '8px 15px', backgroundColor: '#28a745', color: 'white', border: 'none', borderRadius: '5px', cursor: 'pointer' }}>Message Mechanic</button>
                </div>
              ))}
            </div>
          )}

          {/* Mechanic tabs */}
          {userType === 'mechanic' && activeTab === 'my-services' && !editingServiceId && (
            <div>
              <h3>My Services</h3>
              {allServices.filter(s => s.mechanic_id === userId).length === 0 ? (
                <p>No services posted yet.</p>
              ) : (
                allServices.filter(s => s.mechanic_id === userId).map(service => (
                  <div key={service.id} style={{ padding: '15px', margin: '10px 0', border: '1px solid #ddd', borderRadius: '5px', backgroundColor: '#f9f9f9' }}>
                    <h4>{service.service_name}</h4>
                    <p><strong>Description:</strong> {service.description}</p>
                    <p><strong>Specialization:</strong> {service.specialization}</p>
                    <p><strong>Rate:</strong> ${service.hourly_rate}/hour</p>
                    <p><strong>Location:</strong> {service.location}</p>
                    {service.phone_number ? <p><strong>Phone:</strong> {service.phone_number}</p> : null}
                    <div style={{ marginTop: '10px' }}>
                      <button onClick={() => startEditService(service)} style={{ padding: '8px 15px', backgroundColor: '#ffc107', color: 'black', border: 'none', borderRadius: '5px', cursor: 'pointer', marginRight: '10px' }}>Edit</button>
                      <button onClick={() => handleDeleteService(service.id)} style={{ padding: '8px 15px', backgroundColor: '#dc3545', color: 'white', border: 'none', borderRadius: '5px', cursor: 'pointer' }}>Delete</button>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {userType === 'mechanic' && activeTab === 'my-services' && editingServiceId && (
            <div>
              <h3>Edit Service</h3>
              <input type="text" placeholder="Service Name" value={editServiceName} onChange={(e) => setEditServiceName(e.target.value)} style={{ width: '100%', margin: '10px 0', padding: '10px', fontSize: '14px', borderRadius: '5px', border: '1px solid #ddd', boxSizing: 'border-box' }} />
              <textarea placeholder="Describe your service" value={editServiceDesc} onChange={(e) => setEditServiceDesc(e.target.value)} style={{ width: '100%', margin: '10px 0', padding: '10px', fontSize: '14px', borderRadius: '5px', border: '1px solid #ddd', minHeight: '100px', boxSizing: 'border-box' }}></textarea>
              <input type="text" placeholder="Specialization" value={editSpecialization} onChange={(e) => setEditSpecialization(e.target.value)} style={{ width: '100%', margin: '10px 0', padding: '10px', fontSize: '14px', borderRadius: '5px', border: '1px solid #ddd', boxSizing: 'border-box' }} />
              <input type="text" placeholder="Location" value={editLocation} onChange={(e) => setEditLocation(e.target.value)} style={{ width: '100%', margin: '10px 0', padding: '10px', fontSize: '14px', borderRadius: '5px', border: '1px solid #ddd', boxSizing: 'border-box' }} />
              <input type="number" placeholder="Hourly Rate" value={editHourlyRate} onChange={(e) => setEditHourlyRate(e.target.value)} style={{ width: '100%', margin: '10px 0', padding: '10px', fontSize: '14px', borderRadius: '5px', border: '1px solid #ddd', boxSizing: 'border-box' }} />
              <input type="tel" placeholder="Phone Number" value={editServicePhoneNumber} onChange={(e) => setEditServicePhoneNumber(e.target.value)} style={{ width: '100%', margin: '10px 0', padding: '10px', fontSize: '14px', borderRadius: '5px', border: '1px solid #ddd', boxSizing: 'border-box' }} />
              <button onClick={handleEditService} style={{ width: '100%', margin: '10px 0', padding: '10px', fontSize: '16px', backgroundColor: '#28a745', color: 'white', border: 'none', borderRadius: '5px', cursor: 'pointer' }}>Save Changes</button>
              <button onClick={() => setEditingServiceId(null)} style={{ width: '100%', margin: '10px 0', padding: '10px', fontSize: '16px', backgroundColor: '#6c757d', color: 'white', border: 'none', borderRadius: '5px', cursor: 'pointer' }}>Cancel</button>
            </div>
          )}

          {userType === 'mechanic' && activeTab === 'post-service' && (
            <div>
              <h3>Post a Service</h3>
              <input type="text" placeholder="Service Name" value={serviceName} onChange={(e) => setServiceName(e.target.value)} style={{ width: '100%', margin: '10px 0', padding: '10px', fontSize: '14px', borderRadius: '5px', border: '1px solid #ddd', boxSizing: 'border-box' }} />
              <textarea placeholder="Describe your service" value={serviceDesc} onChange={(e) => setServiceDesc(e.target.value)} style={{ width: '100%', margin: '10px 0', padding: '10px', fontSize: '14px', borderRadius: '5px', border: '1px solid #ddd', minHeight: '100px', boxSizing: 'border-box' }}></textarea>
              <input type="text" placeholder="Specialization" value={specialization} onChange={(e) => setSpecialization(e.target.value)} style={{ width: '100%', margin: '10px 0', padding: '10px', fontSize: '14px', borderRadius: '5px', border: '1px solid #ddd', boxSizing: 'border-box' }} />
              <input type="text" placeholder="Location" value={location} onChange={(e) => setLocation(e.target.value)} style={{ width: '100%', margin: '10px 0', padding: '10px', fontSize: '14px', borderRadius: '5px', border: '1px solid #ddd', boxSizing: 'border-box' }} />
              <input type="number" placeholder="Hourly Rate" value={hourlyRate} onChange={(e) => setHourlyRate(e.target.value)} style={{ width: '100%', margin: '10px 0', padding: '10px', fontSize: '14px', borderRadius: '5px', border: '1px solid #ddd', boxSizing: 'border-box' }} />
              <input type="tel" placeholder="Phone Number" value={servicePhoneNumber} onChange={(e) => setServicePhoneNumber(e.target.value)} style={{ width: '100%', margin: '10px 0', padding: '10px', fontSize: '14px', borderRadius: '5px', border: '1px solid #ddd', boxSizing: 'border-box' }} />
              <button onClick={handlePostService} style={{ width: '100%', margin: '10px 0', padding: '10px', fontSize: '16px', backgroundColor: '#28a745', color: 'white', border: 'none', borderRadius: '5px', cursor: 'pointer' }}>Post Service</button>
            </div>
          )}

          {userType === 'mechanic' && activeTab === 'browse-requests' && (
            <div>
              <h3>Browse Repair Requests</h3>
              {allRequests.map(request => (
                <div key={request.id} style={{ padding: '15px', margin: '10px 0', border: '1px solid #ddd', borderRadius: '5px', backgroundColor: '#f9f9f9' }}>
                  <h4>{request.title}</h4>
                  <p><strong>Driver:</strong> {request.driver_name}</p>
                  <p><strong>Vehicle:</strong> {request.vehicle_type}</p>
                  <p><strong>Location:</strong> {request.location}</p>
                  <p>{request.description}</p>
                  <button onClick={() => { setSelectedRequest(request.id); setActiveTab('submit-quote'); }} style={{ padding: '8px 15px', backgroundColor: '#ffc107', color: 'black', border: 'none', borderRadius: '5px', cursor: 'pointer', marginRight: '10px' }}>Submit Quote</button>
                  <button onClick={() => startConversation(request.driver_id, request.id)} style={{ padding: '8px 15px', backgroundColor: '#17a2b8', color: 'white', border: 'none', borderRadius: '5px', cursor: 'pointer' }}>Message Driver</button>
                </div>
              ))}
            </div>
          )}

          {userType === 'mechanic' && activeTab === 'submit-quote' && selectedRequest && (
            <div>
              <h3>Submit Quote</h3>
              <input type="number" placeholder="Quote Price" value={quotePrice} onChange={(e) => setQuotePrice(e.target.value)} style={{ width: '100%', margin: '10px 0', padding: '10px', fontSize: '14px', borderRadius: '5px', border: '1px solid #ddd', boxSizing: 'border-box' }} />
              <input type="text" placeholder="Estimated Time (e.g., 2 hours)" value={estimatedTime} onChange={(e) => setEstimatedTime(e.target.value)} style={{ width: '100%', margin: '10px 0', padding: '10px', fontSize: '14px', borderRadius: '5px', border: '1px solid #ddd', boxSizing: 'border-box' }} />
              <textarea placeholder="Quote description" value={quoteDesc} onChange={(e) => setQuoteDesc(e.target.value)} style={{ width: '100%', margin: '10px 0', padding: '10px', fontSize: '14px', borderRadius: '5px', border: '1px solid #ddd', minHeight: '100px', boxSizing: 'border-box' }}></textarea>
              <button onClick={() => handleSubmitQuote(selectedRequest)} style={{ width: '100%', margin: '10px 0', padding: '10px', fontSize: '16px', backgroundColor: '#28a745', color: 'white', border: 'none', borderRadius: '5px', cursor: 'pointer' }}>Submit Quote</button>
              <button onClick={() => { setSelectedRequest(null); setActiveTab('browse-requests'); }} style={{ width: '100%', margin: '10px 0', padding: '10px', fontSize: '16px', backgroundColor: '#6c757d', color: 'white', border: 'none', borderRadius: '5px', cursor: 'pointer' }}>Cancel</button>
            </div>
          )}

          {/* Chat interface */}
          {activeTab === 'messages' && (
            <div>
              <h3>💬 Messages</h3>
              {!selectedConversation ? (
                <div>
                  {conversations.length === 0 ? (
                    <p>No conversations yet. Start chatting with {userType === 'driver' ? 'mechanics' : 'drivers'}!</p>
                  ) : (
                    <div>
                      {conversations.map(conversation => (
                        <div
                          key={conversation.id}
                          onClick={() => { setSelectedConversation(conversation.id); loadMessages(conversation.id); socketRef.current?.emit('join_conversation', { conversationId: conversation.id }); }}
                          style={{ padding: '12px', margin: '8px 0', border: '1px solid #ddd', borderRadius: '5px', backgroundColor: '#f0f0f0', cursor: 'pointer' }}
                        >
                          <p><strong>{userType === 'driver' ? conversation.mechanic_name : conversation.driver_name}</strong></p>
                          <p style={{ fontSize: '14px', color: '#666' }}>Last updated: {new Date(conversation.updated_at).toLocaleString()}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <div>
                  <button onClick={() => setSelectedConversation(null)} style={{ padding: '8px 15px', backgroundColor: '#6c757d', color: 'white', border: 'none', borderRadius: '5px', cursor: 'pointer', marginBottom: '10px' }}>Back to Conversations</button>
                  <div style={{ border: '1px solid #ddd', borderRadius: '5px', padding: '10px', height: '400px', overflow: 'auto', backgroundColor: '#f9f9f9', marginBottom: '10px' }}>
                    {messages.map((msg, idx) => (
                      <div key={idx} style={{ margin: '8px 0', padding: '8px', backgroundColor: msg.sender_id === userId ? '#d4edda' : '#e3f2fd', borderRadius: '5px', textAlign: msg.sender_id === userId ? 'right' : 'left' }}>
                        <p style={{ margin: '0', fontSize: '12px', fontWeight: 'bold' }}>{msg.sender_name}</p>
                        <p style={{ margin: '4px 0' }}>{msg.message_text}</p>
                        <p style={{ margin: '0', fontSize: '11px', color: '#666' }}>{new Date(msg.created_at).toLocaleTimeString()}</p>
                      </div>
                    ))}
                  </div>
                  <div style={{ display: 'flex', gap: '10px' }}>
                    <input
                      type="text"
                      placeholder="Type your message..."
                      value={messageInput}
                      onChange={(e) => setMessageInput(e.target.value)}
                      onKeyPress={(e) => e.key === 'Enter' && handleSendMessage()}
                      style={{ flex: 1, padding: '10px', fontSize: '14px', borderRadius: '5px', border: '1px solid #ddd', boxSizing: 'border-box' }}
                    />
                    <button onClick={handleSendMessage} style={{ padding: '10px 15px', backgroundColor: '#007bff', color: 'white', border: 'none', borderRadius: '5px', cursor: 'pointer' }}>Send</button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
