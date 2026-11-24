import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Mic, Play, Upload, Activity, Home as HomeIcon, BookOpen, Users } from 'lucide-react';

// --- PURE JS RADIX-2 COOLEY-TUKEY FFT (For Offline Spectrogram) ---
function computeFFT(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) {
      j ^= bit;
    }
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const halfLen = len >> 1;
    const angle = (-2 * Math.PI) / len;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let j = 0; j < halfLen; j++) {
        const uRe = re[i + j];
        const uIm = im[i + j];
        const vRe = re[i + j + halfLen] * curRe - im[i + j + halfLen] * curIm;
        const vIm = re[i + j + halfLen] * curIm + im[i + j + halfLen] * curRe;
        re[i + j] = uRe + vRe;
        im[i + j] = uIm + vIm;
        re[i + j + halfLen] = uRe - vRe;
        im[i + j + halfLen] = uIm - vIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

// Color map for spectrograms (0..1 -> RGB Inferno-style)
function magnitudeToRGB(norm) {
  const v = Math.max(0, Math.min(1, norm));
  let r, g, b;
  if (v < 0.25) {
    const t = v / 0.25;
    r = Math.floor(15 + t * 75);
    g = Math.floor(10 + t * 15);
    b = Math.floor(35 + t * 95);
  } else if (v < 0.5) {
    const t = (v - 0.25) / 0.25;
    r = Math.floor(90 + t * 110);
    g = Math.floor(25 + t * 35);
    b = Math.floor(130 - t * 30);
  } else if (v < 0.75) {
    const t = (v - 0.5) / 0.25;
    r = Math.floor(200 + t * 50);
    g = Math.floor(60 + t * 110);
    b = Math.floor(100 - t * 80);
  } else {
    const t = (v - 0.75) / 0.25;
    r = 255;
    g = Math.floor(170 + t * 85);
    b = Math.floor(20 + t * 180);
  }
  return [r, g, b];
}

// Helper function to export Web Audio API buffer to a downloadable WAV file
function audioBufferToWav(buffer) {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const format = 1; // PCM
  const bitDepth = 16;
  const result = new Float32Array(buffer.length * numChannels);

  if (numChannels === 2) {
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);
    for (let i = 0; i < buffer.length; i++) {
      result[i * 2] = left[i];
      result[i * 2 + 1] = right[i];
    }
  } else {
    result.set(buffer.getChannelData(0));
  }

  const byteRate = (sampleRate * numChannels * bitDepth) / 8;
  const blockAlign = (numChannels * bitDepth) / 8;
  const dataSize = (result.length * bitDepth) / 8;
  const bufferSize = 44 + dataSize;
  const arrayBuffer = new ArrayBuffer(bufferSize);
  const view = new DataView(arrayBuffer);

  const writeString = (v, offset, string) => {
    for (let i = 0; i < string.length; i++) v.setUint8(offset + i, string.charCodeAt(i));
  };

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, format, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < result.length; i++) {
    const s = Math.max(-1, Math.min(1, result[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    offset += 2;
  }

  return new Blob([view], { type: 'audio/wav' });
}

const App = () => {
  const [activeTab, setActiveTab] = useState('overview');

  // --- OFFLINE VOCODER STATE & REFS ---
  const [modulatorFile, setModulatorFile] = useState(null);
  const [carrierFile, setCarrierFile] = useState(null);
  const [offlineOutputUrl, setOfflineOutputUrl] = useState(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [hasSpectrogram, setHasSpectrogram] = useState(false);

  const offlineAudioRef = useRef(null);
  const offlineCanvasRef = useRef(null);
  const offlineSpecImageRef = useRef(null);
  const offlineAnimRef = useRef(null);

  // --- LIVE VOCODER STATE & REFS ---
  const [liveCarrierType, setLiveCarrierType] = useState('sawtooth');
  const [isLiveRunning, setIsLiveRunning] = useState(false);
  const liveCtxRef = useRef(null);
  const liveStreamRef = useRef(null);
  const liveAnalyserRef = useRef(null);
  const liveCanvasRef = useRef(null);
  const liveAnimRef = useRef(null);

  const umichBlue = '#00274C';
  const umichMaize = '#FFCB05';

  const navItems = [
    { id: 'overview', label: 'Overview', icon: <HomeIcon size={18} /> },
    { id: 'methods', label: 'Methods', icon: <BookOpen size={18} /> },
    { id: 'live', label: 'Live Vocoder', icon: <Mic size={18} /> },
    { id: 'offline', label: 'Offline Vocoder', icon: <Play size={18} /> },
    { id: 'contributions', label: 'Contributions', icon: <Users size={18} /> }
  ];

  // --- OFFLINE SPECTROGRAM RENDERING & PLAYHEAD ---
  const buildOfflineSpectrogram = (audioBuffer) => {
    const channelData = audioBuffer.getChannelData(0);
    const sampleRate = audioBuffer.sampleRate;
    const fftSize = 1024;
    const maxFreq = 8000;
    const maxBin = Math.min(fftSize / 2, Math.floor((maxFreq / sampleRate) * fftSize));

    const numFrames = Math.min(700, Math.max(100, Math.floor((channelData.length - fftSize) / 256)));
    const hopSize = Math.max(1, Math.floor((channelData.length - fftSize) / numFrames));

    const hann = new Float32Array(fftSize);
    for (let i = 0; i < fftSize; i++) {
      hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (fftSize - 1)));
    }

    const offscreen = document.createElement('canvas');
    offscreen.width = numFrames;
    offscreen.height = maxBin;
    const offCtx = offscreen.getContext('2d');
    const imgData = offCtx.createImageData(numFrames, maxBin);

    const re = new Float32Array(fftSize);
    const im = new Float32Array(fftSize);

    for (let frame = 0; frame < numFrames; frame++) {
      const start = frame * hopSize;
      for (let i = 0; i < fftSize; i++) {
        re[i] = (channelData[start + i] || 0) * hann[i];
        im[i] = 0;
      }
      computeFFT(re, im);

      for (let bin = 0; bin < maxBin; bin++) {
        const mag = Math.sqrt(re[bin] * re[bin] + im[bin] * im[bin]) / (fftSize / 2);
        const db = 20 * Math.log10(mag + 1e-6);
        const norm = (db + 80) / 70;
        const [r, g, b] = magnitudeToRGB(norm);

        const y = maxBin - 1 - bin;
        const idx = (y * numFrames + frame) * 4;
        imgData.data[idx] = r;
        imgData.data[idx + 1] = g;
        imgData.data[idx + 2] = b;
        imgData.data[idx + 3] = 255;
      }
    }

    offCtx.putImageData(imgData, 0, 0);
    offlineSpecImageRef.current = offscreen;
    setHasSpectrogram(true);
  };

  const drawOfflineFrame = useCallback(() => {
    const canvas = offlineCanvasRef.current;
    const specImg = offlineSpecImageRef.current;
    const audio = offlineAudioRef.current;
    if (!canvas || !specImg) return;

    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(specImg, 0, 0, w, h);

    ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
    ctx.font = '11px monospace';
    ctx.fillText('8 kHz', 6, 14);
    ctx.fillText('4 kHz', 6, h / 2 + 4);
    ctx.fillText('0 Hz', 6, h - 6);

    if (audio && audio.duration > 0) {
      const progress = audio.currentTime / audio.duration;
      const x = Math.max(0, Math.min(w, progress * w));

      ctx.strokeStyle = '#FFCB05';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
  }, []);

  useEffect(() => {
    if (activeTab === 'offline' && hasSpectrogram) {
      drawOfflineFrame();
    }
  }, [activeTab, hasSpectrogram, drawOfflineFrame]);

  const startOfflinePlayheadLoop = () => {
    cancelAnimationFrame(offlineAnimRef.current);
    const loop = () => {
      drawOfflineFrame();
      if (offlineAudioRef.current && !offlineAudioRef.current.paused) {
        offlineAnimRef.current = requestAnimationFrame(loop);
      }
    };
    offlineAnimRef.current = requestAnimationFrame(loop);
  };

  const stopOfflinePlayheadLoop = () => {
    cancelAnimationFrame(offlineAnimRef.current);
    drawOfflineFrame();
  };

  // --- OFFLINE VOCODER DSP IMPLEMENTATION ---
  const processOfflineVocoder = async () => {
    if (!modulatorFile || !carrierFile) {
      alert("Please upload both a modulator (speech) and carrier (synth) file first.");
      return;
    }

    setIsProcessing(true);
    try {
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

      const modArrayBuffer = await modulatorFile.arrayBuffer();
      const carArrayBuffer = await carrierFile.arrayBuffer();
      const modBuffer = await audioCtx.decodeAudioData(modArrayBuffer);
      const carBuffer = await audioCtx.decodeAudioData(carArrayBuffer);

      const duration = Math.min(modBuffer.duration, carBuffer.duration);
      const sampleRate = modBuffer.sampleRate;
      const totalSamples = Math.floor(sampleRate * duration);
      const offlineCtx = new OfflineAudioContext(1, totalSamples, sampleRate);

      const curveLength = 4096;
      const rectCurve = new Float32Array(curveLength);
      const expanderCurve = new Float32Array(curveLength);
      const satCurve = new Float32Array(curveLength);

      for (let i = 0; i < curveLength; i++) {
        const x = (i * 2) / (curveLength - 1) - 1;
        rectCurve[i] = Math.abs(x);
        expanderCurve[i] = x > 0 ? Math.pow(x, 1.6) : 0;
        satCurve[i] = Math.tanh(x * 4.0);
      }

      const numBands = 24;
      const fMin = 100;
      const fMax = Math.min(8000, sampleRate / 2 - 100);
      const qValue = 6.0;

      const modSource = offlineCtx.createBufferSource();
      modSource.buffer = modBuffer;

      const carSource = offlineCtx.createBufferSource();
      carSource.buffer = carBuffer;

      // 1. MODULATOR PRE-EMPHASIS
      const preEmphasis = offlineCtx.createIIRFilter([1, -0.95], [1, 0]);
      modSource.connect(preEmphasis);

      // 2. UNIVERSAL CARRIER CONDITIONING
      const carCompressor = offlineCtx.createDynamicsCompressor();
      carCompressor.threshold.value = -45;
      carCompressor.knee.value = 10;
      carCompressor.ratio.value = 20;
      carCompressor.attack.value = 0.002;
      carCompressor.release.value = 0.08;

      const carMakeup = offlineCtx.createGain();
      carMakeup.gain.value = 12.0;

      const carSaturator = offlineCtx.createWaveShaper();
      carSaturator.curve = satCurve;

      const noiseBuffer = offlineCtx.createBuffer(1, totalSamples, sampleRate);
      const noiseData = noiseBuffer.getChannelData(0);
      for (let i = 0; i < totalSamples; i++) {
        noiseData[i] = Math.random() * 2 - 1;
      }
      const noiseSource = offlineCtx.createBufferSource();
      noiseSource.buffer = noiseBuffer;

      const noiseHPF = offlineCtx.createBiquadFilter();
      noiseHPF.type = 'highpass';
      noiseHPF.frequency.value = 2000;

      const noiseGain = offlineCtx.createGain();
      noiseGain.gain.value = 0.08;

      const conditionedCarrier = offlineCtx.createGain();
      conditionedCarrier.gain.value = 1.0;

      carSource.connect(carCompressor);
      carCompressor.connect(carMakeup);
      carMakeup.connect(carSaturator);
      carSaturator.connect(conditionedCarrier);

      noiseSource.connect(noiseHPF);
      noiseHPF.connect(noiseGain);
      noiseGain.connect(conditionedCarrier);

      // 3. 24-BAND FILTER BANK
      const mainMix = offlineCtx.createGain();
      mainMix.gain.value = 1.0;

      const filterBounds = [];
      for (let i = 0; i <= numBands; i++) {
        filterBounds.push(fMin * Math.pow(fMax / fMin, i / numBands));
      }

      for (let i = 0; i < numBands; i++) {
        const lowFreq = filterBounds[i];
        const highFreq = filterBounds[i + 1];
        const centerFreq = Math.sqrt(lowFreq * highFreq);

        let weight = 1.0 + 1.5 * (1.0 / (1.0 + (centerFreq / 800.0)));
        weight = Math.max(0.8, Math.min(weight, 3.0));

        // -- MODULATOR CHAIN --
        const modFilter1 = offlineCtx.createBiquadFilter();
        modFilter1.type = 'bandpass';
        modFilter1.frequency.value = centerFreq;
        modFilter1.Q.value = qValue;

        const modFilter2 = offlineCtx.createBiquadFilter();
        modFilter2.type = 'bandpass';
        modFilter2.frequency.value = centerFreq;
        modFilter2.Q.value = qValue;

        const rectifier = offlineCtx.createWaveShaper();
        rectifier.curve = rectCurve;

        const lpf1 = offlineCtx.createBiquadFilter();
        lpf1.type = 'lowpass';
        lpf1.frequency.value = 30;

        const lpf2 = offlineCtx.createBiquadFilter();
        lpf2.type = 'lowpass';
        lpf2.frequency.value = 30;

        const expander = offlineCtx.createWaveShaper();
        expander.curve = expanderCurve;

        const envBoost = offlineCtx.createGain();
        envBoost.gain.value = weight * 40.0;

        preEmphasis.connect(modFilter1);
        modFilter1.connect(modFilter2);
        modFilter2.connect(rectifier);
        rectifier.connect(lpf1);
        lpf1.connect(lpf2);
        lpf2.connect(expander);
        expander.connect(envBoost);

        // -- CARRIER CHAIN --
        const carFilter1 = offlineCtx.createBiquadFilter();
        carFilter1.type = 'bandpass';
        carFilter1.frequency.value = centerFreq;
        carFilter1.Q.value = qValue;

        const carFilter2 = offlineCtx.createBiquadFilter();
        carFilter2.type = 'bandpass';
        carFilter2.frequency.value = centerFreq;
        carFilter2.Q.value = qValue;

        const vca = offlineCtx.createGain();
        vca.gain.value = 0;

        conditionedCarrier.connect(carFilter1);
        carFilter1.connect(carFilter2);
        carFilter2.connect(vca);

        // -- MODULATION --
        envBoost.connect(vca.gain);

        if (i % 2 === 1) {
          const inverter = offlineCtx.createGain();
          inverter.gain.value = -1;
          vca.connect(inverter);
          inverter.connect(mainMix);
        } else {
          vca.connect(mainMix);
        }
      }

      // 4. MASTER OUTPUT
      const masterOut = offlineCtx.createDynamicsCompressor();
      masterOut.threshold.value = -12;
      masterOut.ratio.value = 12;
      masterOut.attack.value = 0.005;

      const finalMakeupGain = offlineCtx.createGain();
      finalMakeupGain.gain.value = 25.0;

      mainMix.connect(masterOut);
      masterOut.connect(finalMakeupGain);
      finalMakeupGain.connect(offlineCtx.destination);

      modSource.start(0);
      carSource.start(0);
      noiseSource.start(0);

      const renderedBuffer = await offlineCtx.startRendering();
      const wavBlob = audioBufferToWav(renderedBuffer);
      setOfflineOutputUrl(URL.createObjectURL(wavBlob));

      buildOfflineSpectrogram(renderedBuffer);

    } catch (error) {
      console.error("Error processing offline vocoder:", error);
      alert("Error processing audio. Please ensure valid audio files are uploaded.");
    }
    setIsProcessing(false);
  };

  // --- LIVE REAL-TIME VOCODER IMPLEMENTATION ---
  const stopLiveVocoder = useCallback(() => {
    cancelAnimationFrame(liveAnimRef.current);
    if (liveStreamRef.current) {
      liveStreamRef.current.getTracks().forEach(track => track.stop());
      liveStreamRef.current = null;
    }
    if (liveCtxRef.current) {
      liveCtxRef.current.close();
      liveCtxRef.current = null;
    }
    liveAnalyserRef.current = null;
    setIsLiveRunning(false);
  }, []);

  useEffect(() => {
    if (activeTab !== 'live' && isLiveRunning) {
      stopLiveVocoder();
    }
  }, [activeTab, isLiveRunning, stopLiveVocoder]);

  const startLiveVocoder = async () => {
    if (isLiveRunning) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: true, // Helps eliminate laptop fan & room hiss
          autoGainControl: false
        }
      });
      liveStreamRef.current = stream;

      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      liveCtxRef.current = audioCtx;

      const micSource = audioCtx.createMediaStreamSource(stream);

      // Pre-emphasis on live mic
      const preEmphasis = audioCtx.createIIRFilter([1, -0.95], [1, 0]);
      micSource.connect(preEmphasis);

      // Carrier generator bus & formant shift multiplier
      const carrierBus = audioCtx.createGain();
      carrierBus.gain.value = 0.6;
      let formantShift = 1.0;

      const addOsc = (type, freq, gainVal = 1.0) => {
        const osc = audioCtx.createOscillator();
        osc.type = type;
        osc.frequency.value = freq;
        const g = audioCtx.createGain();
        g.gain.value = gainVal;
        osc.connect(g);
        g.connect(carrierBus);
        osc.start();
      };

      if (liveCarrierType === 'sawtooth') {
        addOsc('sawtooth', 110, 0.6);    // A2
        addOsc('sawtooth', 164.81, 0.5); // E3
      } else if (liveCarrierType === 'chord') {
        // Rich 4-note A Major synth chord (Daft Punk style)
        addOsc('sawtooth', 110, 0.35);    // A2
        addOsc('sawtooth', 164.81, 0.35); // E3
        addOsc('sawtooth', 220, 0.3);     // A3
        addOsc('sawtooth', 277.18, 0.3);  // C#4
      } else if (liveCarrierType === 'chipmunk') {
        // High-pitched bright carrier + 1.55x upward formant shift
        formantShift = 1.55;
        addOsc('sawtooth', 392.0, 0.6);  // G4
        addOsc('sawtooth', 587.33, 0.4); // D5
      } else if (liveCarrierType === 'monster') {
        // Sub-bass carrier + 0.65x downward formant shift
        formantShift = 0.65;
        addOsc('sawtooth', 65.41, 0.6);  // C2
        addOsc('square', 66.0, 0.4);     // Detuned sub-square
      } else if (liveCarrierType === 'noise') {
        const bufSize = audioCtx.sampleRate * 2;
        const noiseBuf = audioCtx.createBuffer(1, bufSize, audioCtx.sampleRate);
        const data = noiseBuf.getChannelData(0);
        for (let i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1;
        const noiseSrc = audioCtx.createBufferSource();
        noiseSrc.buffer = noiseBuf;
        noiseSrc.loop = true;
        noiseSrc.connect(carrierBus);
        noiseSrc.start();
      } else {
        // Robot Drone
        addOsc('square', 82.41, 0.55);   // E2
        addOsc('sawtooth', 83.2, 0.55);  // Detuned saw
      }

      // Rectification curve + Linear Noise-Gate curve
      const curveLength = 2048;
      const rectCurve = new Float32Array(curveLength);
      const gateCurve = new Float32Array(curveLength);
      const gateThreshold = 0.0007; // Mutes idle hiss without crushing normal speech

      for (let i = 0; i < curveLength; i++) {
        const x = (i * 2) / (curveLength - 1) - 1;
        rectCurve[i] = Math.abs(x);
        if (x <= gateThreshold) {
          gateCurve[i] = 0;
        } else {
          // Linear pass-through above threshold (no squaring)
          gateCurve[i] = x - gateThreshold;
        }
      }

      // Real-time 20-band filter bank
      const numBands = 20;
      const fMin = 120;
      const fMax = 7500;
      const qValue = 5.5;
      const mainMix = audioCtx.createGain();
      mainMix.gain.value = 1.0;

      const bounds = [];
      for (let i = 0; i <= numBands; i++) {
        bounds.push(fMin * Math.pow(fMax / fMin, i / numBands));
      }

      const maxSafeFreq = audioCtx.sampleRate / 2 - 200;

      for (let i = 0; i < numBands; i++) {
        const centerFreq = Math.sqrt(bounds[i] * bounds[i + 1]);
        const shiftedCarFreq = Math.max(60, Math.min(maxSafeFreq, centerFreq * formantShift));

        // Modulator band
        const modFilter = audioCtx.createBiquadFilter();
        modFilter.type = 'bandpass';
        modFilter.frequency.value = centerFreq;
        modFilter.Q.value = qValue;

        const rectifier = audioCtx.createWaveShaper();
        rectifier.curve = rectCurve;

        const lpf = audioCtx.createBiquadFilter();
        lpf.type = 'lowpass';
        lpf.frequency.value = 35;

        // Noise gate + quadratic expansion per band
        const gate = audioCtx.createWaveShaper();
        gate.curve = gateCurve;

        const envGain = audioCtx.createGain();
        envGain.gain.value = 30.0; // Compensates for quadratic gate attenuation

        preEmphasis.connect(modFilter);
        modFilter.connect(rectifier);
        rectifier.connect(lpf);
        lpf.connect(gate);
        gate.connect(envGain);

        // Carrier band (with optional formant shift for Chipmunk / Monster)
        const carFilter = audioCtx.createBiquadFilter();
        carFilter.type = 'bandpass';
        carFilter.frequency.value = shiftedCarFreq;
        carFilter.Q.value = qValue;

        const vca = audioCtx.createGain();
        vca.gain.value = 0;

        carrierBus.connect(carFilter);
        carFilter.connect(vca);
        envGain.connect(vca.gain);

        if (i % 2 === 1) {
          const inv = audioCtx.createGain();
          inv.gain.value = -1;
          vca.connect(inv);
          inv.connect(mainMix);
        } else {
          vca.connect(mainMix);
        }
      }

      // Master compressor + Analyser for live scrolling spectrogram
      const compressor = audioCtx.createDynamicsCompressor();
      compressor.threshold.value = -12;
      compressor.ratio.value = 10;

      const outGain = audioCtx.createGain();
      outGain.gain.value = 3.0;

      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.2;
      liveAnalyserRef.current = analyser;

      mainMix.connect(compressor);
      compressor.connect(outGain);
      outGain.connect(analyser);
      analyser.connect(audioCtx.destination);

      setIsLiveRunning(true);

      // Start scrolling spectrogram draw loop
      const freqData = new Uint8Array(analyser.frequencyBinCount);
      const drawLiveSpectrogram = () => {
        const canvas = liveCanvasRef.current;
        if (!canvas || !liveAnalyserRef.current) return;
        const ctx = canvas.getContext('2d');
        const w = canvas.width;
        const h = canvas.height;

        liveAnalyserRef.current.getByteFrequencyData(freqData);

        ctx.drawImage(canvas, 2, 0, w - 2, h, 0, 0, w - 2, h);

        const maxBin = Math.min(freqData.length, Math.floor((8000 / (audioCtx.sampleRate / 2)) * freqData.length));
        for (let y = 0; y < h; y++) {
          const bin = Math.floor(((h - 1 - y) / h) * maxBin);
          const norm = freqData[bin] / 255;
          const [r, g, b] = magnitudeToRGB(norm);
          ctx.fillStyle = `rgb(${r},${g},${b})`;
          ctx.fillRect(w - 2, y, 2, 1);
        }

        liveAnimRef.current = requestAnimationFrame(drawLiveSpectrogram);
      };
      liveAnimRef.current = requestAnimationFrame(drawLiveSpectrogram);

    } catch (err) {
      console.error("Microphone error:", err);
      alert("Could not access microphone. Please allow microphone permissions and try again.");
    }
  };

  return (
    <div style={{ fontFamily: 'Arial, sans-serif', color: '#333', minHeight: '100vh', backgroundColor: '#f8f9fa' }}>
      <header style={{ backgroundColor: umichBlue, color: 'white', padding: '1rem 2rem', boxShadow: '0 4px 6px rgba(0,0,0,0.1)' }}>
        <div style={{ maxWidth: '1200px', margin: '0 auto', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h1 style={{ margin: 0, fontSize: '1.5rem', color: umichMaize }}>EECS 351: Channel Vocoder</h1>
          <nav style={{ display: 'flex', gap: '1rem' }}>
            {navItems.map(item => (
              <button
                key={item.id}
                onClick={() => setActiveTab(item.id)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: activeTab === item.id ? umichMaize : 'white',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  fontSize: '1rem',
                  padding: '0.5rem',
                  borderBottom: activeTab === item.id ? `2px solid ${umichMaize}` : '2px solid transparent'
                }}
              >
                {item.icon} {item.label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <main style={{ maxWidth: '1200px', margin: '2rem auto', padding: '0 2rem' }}>

        {/* PAGE 1: OVERVIEW */}
        {activeTab === 'overview' && (
          <section>
            <h2 style={{ color: umichBlue, borderBottom: `2px solid ${umichMaize}`, paddingBottom: '0.5rem' }}>Project Overview</h2>
            <div style={{ backgroundColor: 'white', padding: '2rem', borderRadius: '8px', boxShadow: '0 2px 4px rgba(0,0,0,0.05)', marginBottom: '2rem' }}>
              <h3 style={{ color: umichBlue, marginTop: 0 }}>The Signal Processing of Speech</h3>
              <p style={{ lineHeight: '1.6', fontSize: '1.1rem' }}>
                From a digital signal processing perspective, human speech can be modeled as a source-filter system. The vocal cords generate a broadband excitation source (the raw sound), which is then passed through the vocal tract. The vocal tract acts as a time-varying acoustic filter, amplifying certain frequencies called <em>formants</em>. It is this dynamic filtering—the spectral envelope—that allows us to distinguish a spoken "ah" from an "ee."
              </p>
              <p style={{ lineHeight: '1.6', fontSize: '1.1rem' }}>
                A <strong>vocoder</strong> (voice encoder) exploits this separation. By analyzing an incoming voice signal, a vocoder isolates the time-varying spectral envelope (the filter) from the original voice source. It then applies this extracted envelope to an entirely new broadband source—known as the carrier signal, such as a synthesizer wave or white noise. The result is the carrier signal being "shaped" to articulate words, producing the robotic or musical vocal effects prevalent in modern audio production.
              </p>

              <h3 style={{ color: umichBlue, marginTop: '2rem' }}>Project Objectives</h3>
              <p style={{ lineHeight: '1.6', fontSize: '1.1rem' }}>
                For our EECS 351 final project, we aimed to build a comprehensive, browser-based DSP application that performs this source-filter manipulation using two distinct methods:
              </p>
              <ul style={{ paddingLeft: '1.5rem', lineHeight: '1.6', fontSize: '1.1rem' }}>
                <li><strong>Time-Domain Analog Emulation:</strong> A 24-channel cascaded filter bank that relies on classical bandpass filtering and time-domain amplitude modulation, designed for offline processing of pre-recorded audio files.</li>
                <li><strong>Live Real-Time Processing:</strong> A low-latency Web Audio API streaming vocoder with real-time carrier synthesis, formant shifting, noise gating, and a scrolling spectrogram display.</li>
              </ul>
            </div>

            <div style={{ backgroundColor: 'white', padding: '2rem', borderRadius: '8px', boxShadow: '0 2px 4px rgba(0,0,0,0.05)' }}>
              <h3 style={{ color: umichBlue, marginTop: 0 }}>How to Use This Application</h3>
              <ul style={{ paddingLeft: '1.5rem', lineHeight: '1.6', fontSize: '1.1rem' }}>
                <li><strong>Live Vocoder:</strong> Navigate to the Live tab. Select a carrier signal or voice effect from the dropdown, click "Start Live Input," allow microphone permissions, and speak (headphones recommended to prevent feedback).</li>
                <li><strong>Offline Vocoder:</strong> Navigate to the Offline tab. Upload a speech file (the modulator) and an instrumental track (the carrier). The system will process the files through our 24-band IIR filter bank and generate an interactive spectrogram synced to playback.</li>
              </ul>
            </div>
          </section>
        )}

        {/* PAGE 2: METHODS */}
        {activeTab === 'methods' && (
          <section>
            <h2 style={{ color: umichBlue, borderBottom: `2px solid ${umichMaize}`, paddingBottom: '0.5rem' }}>DSP Methods & Architecture</h2>

            <div style={{ backgroundColor: '#f1f5f9', padding: '1.5rem', borderRadius: '8px', marginBottom: '2rem' }}>
              <h3 style={{ marginTop: 0, color: umichBlue }}>List of DSP Concepts Applied</h3>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                <div>
                  <strong>Concepts from class:</strong>
                  <ul style={{ marginTop: '0.5rem' }}>
                    <li>Bandpass Filtering (FIR/IIR)</li>
                    <li>Windowing & Frame Overlap</li>
                    <li>Time-Domain Modulation</li>
                    <li>Additive Synthesis and Sampling</li>
                  </ul>
                </div>
                <div>
                  <strong>Concepts applied outside of class:</strong>
                  <ul style={{ marginTop: '0.5rem' }}>
                    <li>Short-Time Fourier Transform (STFT)</li>
                    <li>Audio Envelope Extraction (Rectification & Smoothing)</li>
                  </ul>
                </div>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '2rem' }}>
              <div style={{ backgroundColor: 'white', padding: '2rem', borderRadius: '8px', boxShadow: '0 2px 4px rgba(0,0,0,0.05)' }}>
                <h3 style={{ color: umichBlue, marginTop: 0, fontSize: '1.4rem' }}>Analog (Offline) Filter Bank Design</h3>
                <p>Our offline processing emulates traditional analog circuits by utilizing parallel banks of filters.</p>
                <h4 style={{ color: umichBlue }}>1. Pre-Processing & Pre-Emphasis</h4>
                <p>Both audio signals are converted to mono and resampled to match. To improve the signal-to-noise ratio and clarify high-frequency speech consonants, the modulator (voice) is passed through a high-pass FIR pre-emphasis filter. In the time domain, this is represented by the difference equation:</p>
                <div style={{ backgroundColor: '#f8f9fa', padding: '1rem', borderRadius: '4px', fontFamily: 'monospace', textAlign: 'center', fontSize: '1.1rem', margin: '1rem 0' }}>
                  y[n] = x[n] - 0.95 * x[n-1]
                </div>
                <h4 style={{ color: umichBlue }}>2. Bandpass Filtering</h4>
                <p>The signals are split into 24 distinct frequency bands using 4th-order cascaded Butterworth bandpass filters. These bands are spaced logarithmically to mimic the non-linear sensitivity of human hearing, focusing more resolution on the lower frequencies where speech energy is concentrated.</p>
                <div style={{ margin: '1.5rem 0', textAlign: 'center' }}>
                  <img src={`${process.env.PUBLIC_URL}/BandFrequencies.jpg`} alt="Logarithmically Spaced Filter Bank" style={{ maxWidth: '100%', height: 'auto', borderRadius: '4px', boxShadow: '0 2px 4px rgba(0,0,0,0.1)' }} />
                </div>
                <h4 style={{ color: umichBlue }}>3. Envelope Extraction & Modulation</h4>
                <p>For each band, we extract the "shape" of the speech signal. The signal is first rectified (absolute value), passed through cascaded low-pass filters to capture the amplitude contour, and finally expanded quadratically to suppress background noise.</p>
                <p>Finally, the envelope of each speech band is multiplied by the carrier signal in that exact same frequency band. All modulated bands are then summed together (additive synthesis) to produce the final vocoded track.</p>
                <div style={{ margin: '1.5rem 0', textAlign: 'center' }}>
                  <img src={`${process.env.PUBLIC_URL}/SpeechEnvelope.jpg`} alt="Speech Envelope Extraction" style={{ maxWidth: '100%', height: 'auto', borderRadius: '4px', boxShadow: '0 2px 4px rgba(0,0,0,0.1)' }} />
                </div>
              </div>

              <div style={{ backgroundColor: 'white', padding: '2rem', borderRadius: '8px', boxShadow: '0 2px 4px rgba(0,0,0,0.05)' }}>
                <h3 style={{ color: umichBlue, marginTop: 0, fontSize: '1.4rem' }}>Digital (Live) Real-Time Design</h3>
                <p>Our live real-time vocoder processes streaming microphone audio directly on the browser's dedicated Web Audio rendering thread, pairing a 20-band real-time filter bank with per-band noise gating and FFT-based spectrogram analysis.</p>
                <h4 style={{ color: umichBlue }}>1. Real-Time Carrier Synthesis & Formant Shifting</h4>
                <p>Broadband carrier waveforms (Sawtooth Synth, Synth Chord, Chipmunk, Deep Monster, White Noise, or Robot Drone) are synthesized natively in real time. For Chipmunk and Monster effects, the synthesis filter bank center frequencies are scaled relative to the analysis filter bank to shift vocal formants.</p>
                <h4 style={{ color: umichBlue }}>2. Live Envelope Tracking & Noise Gating</h4>
                <p>Incoming microphone audio is pre-emphasized, split into 20 logarithmic bands, rectified, smoothed with 35 Hz low-pass filters, and passed through a thresholded quadratic noise gate to keep the carrier silent between words.</p>
                <h4 style={{ color: umichBlue }}>3. Real-Time STFT Visualization</h4>
                <p>The summed vocoded output is tapped by a 1024-point Web Audio <code>AnalyserNode</code>, computing windowed FFT magnitude frames at 60 FPS to render a live scrolling spectrogram.</p>
              </div>
            </div>
          </section>
        )}

        {/* PAGE 3: LIVE VOCODER */}
        {activeTab === 'live' && (
          <section>
            <h2 style={{ color: umichBlue, borderBottom: `2px solid ${umichMaize}`, paddingBottom: '0.5rem' }}>Live Real-Time Vocoder</h2>
            <div style={{ backgroundColor: 'white', padding: '2rem', borderRadius: '8px', boxShadow: '0 2px 4px rgba(0,0,0,0.05)', textAlign: 'center' }}>
              <p style={{ marginBottom: '1.5rem', fontSize: '1.1rem' }}>
                Select a carrier signal, click <strong>Start Live Input</strong>, and speak into your microphone. <em>(Use headphones to prevent feedback.)</em>
              </p>
              <div style={{ display: 'flex', justifyContent: 'center', gap: '1rem', marginBottom: '2rem', flexWrap: 'wrap' }}>
                <select
                  value={liveCarrierType}
                  onChange={(e) => setLiveCarrierType(e.target.value)}
                  disabled={isLiveRunning}
                  style={{ padding: '0.75rem', fontSize: '1rem', borderRadius: '4px', border: '1px solid #ccc', minWidth: '280px' }}
                >
                  <option value="sawtooth">Sawtooth Synth (A2 + E3)</option>
                  <option value="chord">Daft Synth Chord (A Major)</option>
                  <option value="chipmunk">Chipmunk Voice (Formant Shift Up)</option>
                  <option value="monster">Deep Monster (Formant Shift Down)</option>
                  <option value="noise">White Noise (Whisper)</option>
                  <option value="robot">Robot Drone (Square + Detuned Saw)</option>
                </select>
                <button
                  onClick={startLiveVocoder}
                  disabled={isLiveRunning}
                  style={{ backgroundColor: isLiveRunning ? '#94a3b8' : '#28a745', color: 'white', border: 'none', padding: '0.75rem 1.5rem', fontSize: '1rem', borderRadius: '4px', cursor: isLiveRunning ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 'bold' }}
                >
                  <Mic size={18} /> {isLiveRunning ? 'Live Active...' : 'Start Live Input'}
                </button>
                <button
                  onClick={stopLiveVocoder}
                  disabled={!isLiveRunning}
                  style={{ backgroundColor: !isLiveRunning ? '#94a3b8' : '#dc3545', color: 'white', border: 'none', padding: '0.75rem 1.5rem', fontSize: '1rem', borderRadius: '4px', cursor: !isLiveRunning ? 'not-allowed' : 'pointer', fontWeight: 'bold' }}
                >
                  Stop
                </button>
              </div>

              <div style={{ position: 'relative', height: '300px', backgroundColor: '#111', borderRadius: '6px', overflow: 'hidden', border: `2px solid ${umichBlue}` }}>
                <canvas
                  ref={liveCanvasRef}
                  width={900}
                  height={300}
                  style={{ width: '100%', height: '100%', display: 'block' }}
                />

                {/* Stationary Y-Axis Frequency Labels */}
                <div style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  bottom: 0,
                  width: '54px',
                  backgroundColor: 'rgba(0, 0, 0, 0.55)',
                  borderRight: '1px solid rgba(255, 255, 255, 0.2)',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                  padding: '6px 6px',
                  color: '#fff',
                  fontSize: '11px',
                  fontFamily: 'monospace',
                  textAlign: 'right',
                  pointerEvents: 'none',
                  boxSizing: 'border-box'
                }}>
                  <span>8 kHz</span>
                  <span>6 kHz</span>
                  <span>4 kHz</span>
                  <span>2 kHz</span>
                  <span>0 Hz</span>
                </div>

                {!isLiveRunning && (
                  <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', pointerEvents: 'none' }}>
                    <Activity size={48} color={umichMaize} />
                    <p style={{ color: umichMaize, marginTop: '1rem', fontFamily: 'monospace' }}>Awaiting Live Audio Stream...</p>
                  </div>
                )}
              </div>
            </div>
          </section>
        )}

        {/* PAGE 4: OFFLINE VOCODER */}
        {activeTab === 'offline' && (
          <section>
            <h2 style={{ color: umichBlue, borderBottom: `2px solid ${umichMaize}`, paddingBottom: '0.5rem' }}>Offline File Processing</h2>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2rem', marginTop: '1.5rem' }}>

              <div style={{ backgroundColor: 'white', padding: '1.5rem', borderRadius: '8px', boxShadow: '0 2px 4px rgba(0,0,0,0.05)' }}>
                <h3 style={{ marginTop: 0, color: umichBlue }}>Audio Inputs</h3>
                <div style={{ marginBottom: '1.5rem' }}>
                  <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '0.5rem' }}>1. Modulator (Speech) File</label>
                  <input type="file" accept="audio/*" onChange={(e) => setModulatorFile(e.target.files[0])} style={{ width: '100%', padding: '0.5rem', border: '1px solid #ddd', borderRadius: '4px' }} />
                </div>
                <div style={{ marginBottom: '1.5rem' }}>
                  <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '0.5rem' }}>2. Carrier (Synth/Music) File</label>
                  <input type="file" accept="audio/*" onChange={(e) => setCarrierFile(e.target.files[0])} style={{ width: '100%', padding: '0.5rem', border: '1px solid #ddd', borderRadius: '4px' }} />
                </div>
                <button
                  onClick={processOfflineVocoder}
                  disabled={isProcessing}
                  style={{ backgroundColor: isProcessing ? '#999' : umichBlue, color: isProcessing ? '#fff' : umichMaize, border: 'none', padding: '1rem 1.5rem', fontSize: '1.1rem', width: '100%', borderRadius: '4px', cursor: isProcessing ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', fontWeight: 'bold' }}
                >
                  <Upload size={20} /> {isProcessing ? 'Processing DSP Math...' : 'Process Offline Vocoder'}
                </button>
              </div>

              <div style={{ backgroundColor: 'white', padding: '1.5rem', borderRadius: '8px', boxShadow: '0 2px 4px rgba(0,0,0,0.05)', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                <div>
                  <h3 style={{ margin: '0 0 1rem 0', color: umichBlue }}>Vocoded Audio Output</h3>
                  <p style={{ color: '#555', lineHeight: '1.5', marginBottom: '1.5rem' }}>
                    Once processed, press play below to hear the vocoded output and watch the synchronized playhead track across the spectrogram.
                  </p>
                </div>
                <audio
                  ref={offlineAudioRef}
                  controls
                  src={offlineOutputUrl}
                  onPlay={startOfflinePlayheadLoop}
                  onPause={stopOfflinePlayheadLoop}
                  onEnded={stopOfflinePlayheadLoop}
                  onSeeked={drawOfflineFrame}
                  style={{ width: '100%' }}
                >
                  Your browser does not support the audio element.
                </audio>
              </div>
            </div>

            {/* FULL-WIDTH OFFLINE SPECTROGRAM PANEL */}
            <div style={{ backgroundColor: 'white', padding: '1.5rem', borderRadius: '8px', boxShadow: '0 2px 4px rgba(0,0,0,0.05)', marginTop: '2rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                <h3 style={{ margin: 0, color: umichBlue }}>Vocoded Output Spectrogram (0 – 8 kHz)</h3>
                {hasSpectrogram && <span style={{ fontSize: '0.9rem', color: '#666' }}>Yellow bar tracks live playback position</span>}
              </div>
              <div style={{ position: 'relative', height: '260px', backgroundColor: '#111', borderRadius: '6px', overflow: 'hidden', border: '1px solid #ddd' }}>
                <canvas
                  ref={offlineCanvasRef}
                  width={1000}
                  height={260}
                  style={{ width: '100%', height: '100%', display: 'block' }}
                />
                {!hasSpectrogram && (
                  <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', backgroundColor: '#f8f9fa' }}>
                    <Activity size={40} color="#94a3b8" />
                    <p style={{ color: '#64748b', marginTop: '0.5rem' }}>Upload files and click Process to generate the vocoded spectrogram.</p>
                  </div>
                )}
              </div>
            </div>
          </section>
        )}

        {/* PAGE 5: CONTRIBUTIONS */}
        {activeTab === 'contributions' && (
          <section>
            <h2 style={{ color: umichBlue, borderBottom: `2px solid ${umichMaize}`, paddingBottom: '0.5rem' }}>Team Contributions & References</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginTop: '1.5rem' }}>

              <div style={{ backgroundColor: 'white', padding: '1.5rem', borderRadius: '8px', borderLeft: `5px solid ${umichBlue}` }}>
                <h3 style={{ margin: '0 0 0.5rem 0', color: umichBlue }}>Michael Wu (mikewoo)</h3>
                <p style={{ margin: 0 }}>Led the DSP filter bank implementation, algorithm latency benchmarking, and formulated the real-time buffer processing architecture.</p>
              </div>

              <div style={{ backgroundColor: 'white', padding: '1.5rem', borderRadius: '8px', borderLeft: `5px solid ${umichMaize}` }}>
                <h3 style={{ margin: '0 0 0.5rem 0', color: umichBlue }}>Alexander Lukas (ajlukas)</h3>
                <p style={{ margin: 0 }}>Developed the React UI framework, integrated the dynamic spectrogram visualizations, and handled the Web Audio API stream routing.</p>
              </div>

              <div style={{ backgroundColor: 'white', padding: '1.5rem', borderRadius: '8px', borderLeft: `5px solid ${umichBlue}` }}>
                <h3 style={{ margin: '0 0 0.5rem 0', color: umichBlue }}>Daniel Abraham (abdaniel)</h3>
                <p style={{ margin: 0 }}>Managed the offline file processing logic, envelope extraction optimizations, and drafted the DSP documentation on the Methods page.</p>
              </div>
            </div>

            <div style={{ backgroundColor: 'white', padding: '2rem', borderRadius: '8px', boxShadow: '0 2px 4px rgba(0,0,0,0.05)', marginTop: '2rem' }}>
              <h3 style={{ color: umichBlue, marginTop: 0 }}>References & Sources</h3>
              <ol style={{ paddingLeft: '1.5rem', margin: 0, lineHeight: '1.6' }}>
                <li>Smith, J.O. "Short-Time Fourier Transform." <em>Spectral Audio Signal Processing</em>, W3K Publishing.</li>
                <li>Bell Laboratories Record. "The Vocoder." 1939. Background on transmission bandwidth preservation and SIGSALY.</li>
                <li>MDN Web Docs. <em>Web Audio API</em>. Mozilla Foundation. <a href="https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API" target="_blank" rel="noreferrer" style={{ color: umichBlue }}>https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API</a></li>
              </ol>
            </div>
          </section>
        )}
      </main>
    </div>
  );
};

export default App;