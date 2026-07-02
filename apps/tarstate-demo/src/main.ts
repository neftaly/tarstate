import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { RealEstateApp } from './demo.js';
import './style.css';

const app = document.querySelector<HTMLElement>('#app');

if (app === null) {
  throw new Error('Missing #app root');
}

const root = createRoot(app);
root.render(createElement(RealEstateApp));
