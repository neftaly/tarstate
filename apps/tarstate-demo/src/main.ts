import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { ReactExampleSuite, createAutomergeExampleModel } from './demo.js';
import './style.css';

const app = document.querySelector<HTMLElement>('#app');

if (app === null) {
  throw new Error('Missing #app root');
}

const root = createRoot(app);
root.render(createElement('main', { className: 'page' }, createElement('p', { className: 'status' }, 'Loading Tarstate React examples...')));

createAutomergeExampleModel()
  .then((automerge) => {
    root.render(createElement(ReactExampleSuite, { automerge }));
  })
  .catch((error: unknown) => {
    root.render(createElement(
      'main',
      { className: 'page' },
      createElement('section', { className: 'panel' },
        createElement('h2', null, 'Demo failed'),
        createElement('pre', null, error instanceof Error ? error.message : String(error))
      )
    ));
  });
