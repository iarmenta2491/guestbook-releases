import React from 'react';
import { AppProvider, useApp } from './context/AppContext';
import AttractScreen from './screens/AttractScreen';
import RecordScreen from './screens/RecordScreen';
import ReviewScreen from './screens/ReviewScreen';
import ShareScreen from './screens/ShareScreen';
import ThankYouScreen from './screens/ThankYouScreen';
import AdminPanel from './screens/AdminPanel';
import './styles/global.css';

function AppRouter() {
  const { screen, glamMode } = useApp();

  return (
    <div className="app bg-gradient-dark">
      <AttractScreen  active={screen === 'attract'} />
      <RecordScreen   active={screen === 'record'} glamMode={glamMode} />
      <ReviewScreen   active={screen === 'review'} />
      <ShareScreen    active={screen === 'share'} />
      <ThankYouScreen active={screen === 'thankyou'} />
      <AdminPanel     active={screen === 'admin'} />
    </div>
  );
}

export default function App() {
  return (
    <AppProvider>
      <AppRouter />
    </AppProvider>
  );
}
