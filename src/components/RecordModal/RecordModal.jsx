import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import styles from './RecordModal.module.css';
import { exportWAV, exportMP3 } from '../../utils/audioExport';

export default function RecordModal({ onClose, isRecording, recordedBlob, audioBuffer, startRecording, stopRecording, clearRecording }) {
  const [elapsed,      setElapsed]      = useState(0);
  const [exportFormat, setExportFormat] = useState('mp3');

  // Drag state — same pattern as AutotuneTerminal / ArpTerminal
  const [pos, setPos]  = useState({ x: 0, y: 0 });
  const isDragging     = useRef(false);
  const dragOffset     = useRef({ x: 0, y: 0 });
  const posRef         = useRef({ x: 0, y: 0 });

  const handleMouseDown = useCallback((e) => {
    e.preventDefault();
    isDragging.current = true;
    dragOffset.current = { x: e.clientX - posRef.current.x, y: e.clientY - posRef.current.y };
  }, []);

  useEffect(() => {
    const onMove = (e) => {
      if (!isDragging.current) return;
      const x = e.clientX - dragOffset.current.x;
      const y = e.clientY - dragOffset.current.y;
      posRef.current = { x, y };
      setPos({ x, y });
    };
    const onUp = () => { isDragging.current = false; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  // Elapsed timer synced to recording state
  const intervalRef = useRef(null);
  useEffect(() => {
    if (isRecording) {
      setElapsed(0);
      intervalRef.current = setInterval(() => setElapsed(s => s + 1), 1000);
    } else {
      clearInterval(intervalRef.current);
    }
    return () => clearInterval(intervalRef.current);
  }, [isRecording]);

  // Blob URL — memoized; revoked on unmount or blob change
  const blobUrl = useMemo(() => recordedBlob ? URL.createObjectURL(recordedBlob) : null, [recordedBlob]);
  useEffect(() => {
    return () => { if (blobUrl) URL.revokeObjectURL(blobUrl); };
  }, [blobUrl]);

  const formatTime = (s) => {
    const m = Math.floor(s / 60).toString().padStart(2, '0');
    return `${m}:${(s % 60).toString().padStart(2, '0')}`;
  };

  const handleExport = () => {
    let url, filename, needsRevoke = false;
    if (exportFormat === 'mp3' && audioBuffer) {
      url = URL.createObjectURL(exportMP3(audioBuffer));
      filename = 'VoxDAW_Take.mp3';
      needsRevoke = true;
    } else if (exportFormat === 'wav' && audioBuffer) {
      url = URL.createObjectURL(exportWAV(audioBuffer));
      filename = 'VoxDAW_Take.wav';
      needsRevoke = true;
    } else {
      url = blobUrl;
      filename = 'VoxDAW_Take.webm';
    }
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    if (needsRevoke) URL.revokeObjectURL(url);
  };

  return (
    <div
      className={styles.terminal}
      style={{ transform: `translate(${pos.x}px, ${pos.y}px)` }}
    >
      <div className={styles.terminalHeader} onMouseDown={handleMouseDown}>
        <span>·· record</span>
        <button className={styles.closeBtn} onMouseDown={e => e.stopPropagation()} onClick={onClose}>✕</button>
      </div>

      {/* View 1 — Idle */}
      {!isRecording && !recordedBlob && (
        <button className={styles.startBtn} onClick={startRecording}>
          [ start recording ]
        </button>
      )}

      {/* View 2 — Recording */}
      {isRecording && (
        <div className={styles.recordingRow}>
          <div className={styles.pulse} />
          <button className={styles.stopBtn} onClick={stopRecording}>
            ● stop
          </button>
          <span className={styles.timer}>{formatTime(elapsed)}</span>
        </div>
      )}

      {/* View 3 — Review */}
      {!isRecording && recordedBlob && (
        <>
          <audio className={styles.audioPreview} controls src={blobUrl} />
          <div className={styles.exportRow}>
            <select
              className={styles.formatSelect}
              value={exportFormat}
              onChange={e => setExportFormat(e.target.value)}
            >
              <option value="mp3">MP3</option>
              <option value="webm">WEBM</option>
              <option value="wav">WAV</option>
            </select>
            <button className={styles.exportBtn} onClick={handleExport}>
              [ export ]
            </button>
          </div>
          <button className={styles.discardBtn} onClick={clearRecording}>
            [ discard ]
          </button>
        </>
      )}
    </div>
  );
}
