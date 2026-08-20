/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,jsx}',
    './components/**/*.{js,jsx}',
  ],
  theme: {
    extend: {
      colors: {
        void: '#0A0A0C',
        panel: '#111113',
        line: '#28282C',
        'line-bright': '#48484E',
        amber: '#FF7A1A',
        'amber-dim': '#7A3D12',
        signal: '#5FB8B0',
        'signal-dim': '#2E5854',
        ink: '#E9E7E2',
        'ink-dim': '#7A7A80',
        alert: '#FF4433',
      },
      fontFamily: {
        display: ['var(--font-rajdhani)', 'sans-serif'],
        mono: ['var(--font-plex-mono)', 'monospace'],
      },
    },
  },
  plugins: [],
};
