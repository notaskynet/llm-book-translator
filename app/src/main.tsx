import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './i18n';
import './index.css';
import { App } from './App';

async function boot() {
  // `?mock=1` serves the LLM API from msw so the UI can be exercised without a real key.
  if (import.meta.env.DEV && new URLSearchParams(location.search).has('mock')) {
    const { worker } = await import('./mocks/browser');
    await worker.start({ onUnhandledFrame: 'bypass' });
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
void boot();
