import type { Metadata } from 'next';
import { DesignLibrary } from '../../components/landing/DesignLibrary';
export const metadata: Metadata = { title: 'Nuzm | Design library' };
export default function Designs() {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: '#f6f5f1' }}>
        <DesignLibrary />
      </body>
    </html>
  );
}
