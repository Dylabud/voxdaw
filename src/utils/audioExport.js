import { Mp3Encoder } from '@breezystack/lamejs';

export function exportMP3(audioBuffer) {
  const { numberOfChannels, sampleRate, length } = audioBuffer;
  const isStereo = numberOfChannels >= 2;
  const mp3encoder = new Mp3Encoder(isStereo ? 2 : 1, sampleRate, 128);

  const toInt16 = (floatArr) => {
    const out = new Int16Array(floatArr.length);
    for (let i = 0; i < floatArr.length; i++) {
      const s = Math.max(-1, Math.min(1, floatArr[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return out;
  };

  const leftInt16  = toInt16(audioBuffer.getChannelData(0));
  const rightInt16 = isStereo ? toInt16(audioBuffer.getChannelData(1)) : null;

  const CHUNK = 1152; // one MP3 frame
  const mp3Data = [];

  for (let i = 0; i < length; i += CHUNK) {
    const left = leftInt16.subarray(i, i + CHUNK);
    const buf  = rightInt16
      ? mp3encoder.encodeBuffer(left, rightInt16.subarray(i, i + CHUNK))
      : mp3encoder.encodeBuffer(left);
    if (buf.length > 0) mp3Data.push(buf);
  }

  const flush = mp3encoder.flush();
  if (flush.length > 0) mp3Data.push(flush);

  return new Blob(mp3Data, { type: 'audio/mp3' });
}

export function exportWAV(audioBuffer) {
  const numChannels = audioBuffer.numberOfChannels;
  const sampleRate  = audioBuffer.sampleRate;
  const numSamples  = audioBuffer.length;
  const bytesPerSample = 2; // 16-bit signed PCM

  const dataLength  = numSamples * numChannels * bytesPerSample;
  const buffer      = new ArrayBuffer(44 + dataLength);
  const view        = new DataView(buffer);

  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeStr(0,  'RIFF');
  view.setUint32(4,  36 + dataLength,   true); // file size − 8
  writeStr(8,  'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16,                true); // PCM chunk size
  view.setUint16(20, 1,                 true); // PCM format
  view.setUint16(22, numChannels,       true);
  view.setUint32(24, sampleRate,        true);
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true); // byte rate
  view.setUint16(32, numChannels * bytesPerSample, true);              // block align
  view.setUint16(34, 16,                true); // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, dataLength,        true);

  // Interleave channels and clamp to [-1, 1] before converting to Int16
  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, audioBuffer.getChannelData(ch)[i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
      offset += 2;
    }
  }

  return new Blob([buffer], { type: 'audio/wav' });
}
