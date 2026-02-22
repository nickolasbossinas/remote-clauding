import React, { useEffect, useRef } from 'react';
import { Html5Qrcode } from 'html5-qrcode';

export default function QRScanner({ onScan, onClose }) {
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;
  const scannedRef = useRef(false);

  useEffect(() => {
    const scanner = new Html5Qrcode('qr-reader');

    scanner
      .start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 250, height: 250 } },
        (decodedText) => {
          if (scannedRef.current) return;
          const match = decodedText.match(/#\/pair\/(.+)$/);
          if (match) {
            scannedRef.current = true;
            const token = decodeURIComponent(match[1]);
            scanner.stop().catch(() => {});
            onScanRef.current(token);
          }
        }
      )
      .catch((err) => {
        console.error('[QR] Camera error:', err);
      });

    return () => {
      scanner.stop().catch(() => {});
    };
  }, []);

  return (
    <div className="qr-scanner-overlay">
      <div className="qr-scanner-header">
        <span>Scan QR Code</span>
        <button className="qr-close-btn" onClick={onClose}>Cancel</button>
      </div>
      <div id="qr-reader" />
    </div>
  );
}
