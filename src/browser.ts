import { Inkwell } from './index.js';

declare global {
  interface Window { Inkwell: typeof Inkwell }
}

// Standalone browser entry for engine exports and HTML games without a bundler.
// Loading the script never starts a session or marks the game ready.
if (typeof window !== 'undefined') window.Inkwell = Inkwell;
