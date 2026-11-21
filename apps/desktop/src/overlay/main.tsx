import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../shared/styles.css';
import './overlay.css';
import { Overlay } from './Overlay';
import { startLiveSync } from '../shared/store';

document.documentElement.classList.add('is-overlay');
startLiveSync({ reportFirstPaint: true });
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Overlay />
  </StrictMode>,
);
