import { Rajdhani, IBM_Plex_Mono } from 'next/font/google';
import './globals.css';

const rajdhani = Rajdhani({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-rajdhani',
});

const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-mono',
});

export const metadata = {
  title: 'VITAL',
  description: 'Painel de monitoramento ESP32 — temperatura, umidade e inclinação',
};

export default function RootLayout({ children }) {
  return (
    <html lang="pt-BR">
      <body className={`${rajdhani.variable} ${plexMono.variable}`}>{children}</body>
    </html>
  );
}
