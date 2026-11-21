import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../shared/styles.css';
import '../overlay/overlay.css';
import './dashboard.css';
import { App } from './App';
import { startLiveSync } from '../shared/store';

startLiveSync({ reportFirstPaint: false });
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
