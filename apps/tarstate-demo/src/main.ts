import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { TutorialApp, createTutorialModel } from './demo.js';
import './style.css';

const app = document.querySelector<HTMLElement>('#app');

if (app === null) {
  throw new Error('Missing #app root');
}

const root = createRoot(app);
root.render(createElement('main', { className: 'page' }, createElement('p', { className: 'status' }, 'Loading Tarstate walkthrough...')));

createTutorialModel()
  .then((model) => {
    root.render(createElement(TutorialApp, { model }));
  })
  .catch((error: unknown) => {
    root.render(createElement(
      'main',
      { className: 'page' },
      createElement('section', { className: 'tutorial-card' },
        createElement('h2', null, 'Walkthrough failed'),
        createElement('pre', null, error instanceof Error ? error.message : String(error))
      )
    ));
  });
