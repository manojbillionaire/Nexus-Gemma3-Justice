import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import LoginPage from './components/LoginPage';
import AdvocatePortal from './components/AdvocatePortal';
import AgencyHQPortal from './components/AgencyHQPortal';

export default function App() {
  const [user, setUser] = useState<any>(null);

  // Check for existing session (mock)
  useEffect(() => {
    const savedUser = localStorage.getItem('nexus_user');
    if (savedUser) {
      setUser(JSON.parse(savedUser));
    }
  }, []);

  const handleLogin = (userData: any) => {
    setUser(userData);
    localStorage.setItem('nexus_user', JSON.stringify(userData));
  };

  const handleLogout = () => {
    setUser(null);
    localStorage.removeItem('nexus_user');
  };

  if (!user) {
    return <LoginPage onLogin={handleLogin} />;
  }

  return (
    <div className="min-h-screen w-full bg-[#020617] text-white overflow-hidden">
      <AnimatePresence mode="wait">
        {user.role === 'agency' ? (
          <motion.div
            key="agency"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="h-screen w-full"
          >
            <AgencyHQPortal user={user} onLogout={handleLogout} />
          </motion.div>
        ) : (
          <motion.div
            key="advocate"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="h-screen w-full"
          >
            <AdvocatePortal onBack={handleLogout} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
