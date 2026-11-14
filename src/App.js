import React, { useState } from 'react';
import { Mic, Play, Upload, Activity, Home as HomeIcon, BookOpen, Users, BarChart, ClipboardList } from 'lucide-react';

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
  const [activeTab, setActiveTab] = useState('progress');
  
  // Offline Vocoder State
  const [modulatorFile, setModulatorFile] = useState(null);
  const [carrierFile, setCarrierFile] = useState(null);
  const [offlineOutputUrl, setOfflineOutputUrl] = useState(null);
  const [isProcessing, setIsProcessing] = useState(false);

  const umichBlue = '#00274C';
  const umichMaize = '#FFCB05';

  const navItems = [
    { id: 'progress', label: 'Progress Report', icon: <ClipboardList size={18} /> },
    { id: 'overview', label: 'Overview', icon: <HomeIcon size={18} /> },
    { id: 'methods', label: 'Methods', icon: <BookOpen size={18} /> },
    { id: 'live', label: 'Live Vocoder', icon: <Mic size={18} /> },
    { id: 'offline', label: 'Offline Vocoder', icon: <Play size={18} /> },
    { id: 'contributions', label: 'Contributions', icon: <Users size={18} /> }
  ];

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
      const offlineCtx = new OfflineAudioContext(1, sampleRate * duration, sampleRate);

      // Rectification Curve (Absolute Value)
      const curveLength = 4096;
      const rectCurve = new Float32Array(curveLength);
      // Expander Curve (x^2 function)
      const expanderCurve = new Float32Array(curveLength);
      
      for (let i = 0; i < curveLength; i++) {
        const x = (i * 2) / (curveLength - 1) - 1;
        rectCurve[i] = Math.abs(x);
        expanderCurve[i] = x > 0 ? (x * x) : 0; 
      }

      const numBands = 24; 
      const fMin = 100;
      const fMax = Math.min(8000, sampleRate / 2 - 100);
      const qValue = 6.0; 

      const modSource = offlineCtx.createBufferSource();
      modSource.buffer = modBuffer;

      const carSource = offlineCtx.createBufferSource();
      carSource.buffer = carBuffer;

      // Clean speech pre-emphasis
      const preEmphasis = offlineCtx.createIIRFilter([1, -0.95], [1, 0]);
      modSource.connect(preEmphasis);

      const mainMix = offlineCtx.createGain();
      mainMix.gain.value = 1.0;

      const filterBounds = [];
      for (let i = 0; i <= numBands; i++) {
        filterBounds.push(fMin * Math.pow(fMax / fMin, i / numBands));
      }

      for (let i = 0; i < numBands; i++) {
        const lowFreq = filterBounds[i];
        const highFreq = filterBounds[i+1];
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
        envBoost.gain.value = weight * 50.0; 

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
        
        const carDrive = offlineCtx.createGain();
        carDrive.gain.value = 12.0;

        const vca = offlineCtx.createGain();
        vca.gain.value = 0; 

        carSource.connect(carDrive);
        carDrive.connect(carFilter1);
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

      // --- MASTER OUTPUT ---
      const masterOut = offlineCtx.createDynamicsCompressor();
      masterOut.threshold.value = -12;
      masterOut.ratio.value = 12;
      masterOut.attack.value = 0.005;

      const finalMakeupGain = offlineCtx.createGain();
      finalMakeupGain.gain.value = 40.0; 

      mainMix.connect(masterOut);
      masterOut.connect(finalMakeupGain);
      finalMakeupGain.connect(offlineCtx.destination);

      modSource.start(0);
      carSource.start(0);

      const renderedBuffer = await offlineCtx.startRendering();
      const wavBlob = audioBufferToWav(renderedBuffer);
      setOfflineOutputUrl(URL.createObjectURL(wavBlob));

    } catch (error) {
      console.error("Error processing offline vocoder:", error);
      alert("Error processing audio. Please ensure valid audio files are uploaded.");
    }
    setIsProcessing(false);
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
        
        {/* PAGE 0: PROGRESS REPORT */}
        {activeTab === 'progress' && (
          <section>
            <h2 style={{ color: umichBlue, borderBottom: `2px solid ${umichMaize}`, paddingBottom: '0.5rem' }}>Project Progress Report</h2>
            
            {/* 1) Data & Overview */}
            <div style={{ backgroundColor: 'white', padding: '2rem', borderRadius: '8px', boxShadow: '0 2px 4px rgba(0,0,0,0.05)', marginBottom: '2rem' }}>
              <h3 style={{ color: umichBlue, marginTop: 0 }}>1. Data & Overview</h3>
              <p style={{ lineHeight: '1.6', fontSize: '1.1rem' }}>
                Our project is a real time Voice Changer and Synthesizer system that processes real human speech data. The speech file is the modulator, and the synthetic broadband signals are the carrier. The main problem with this project is decoupling the voice's raw pitch from its spectral envelope. This is important since it's the filtering of the speech data that forms vowel and consonant sounds. To solve this problem, we are implementing a Phase Vocoder to shift the pitch of the speech data without affecting time, and a Digital Channel Vocoder for extracting and modulating the spectral envelope.
              </p>
            </div>

            {/* 2) Three Plots */}
            <div style={{ backgroundColor: 'white', padding: '2rem', borderRadius: '8px', boxShadow: '0 2px 4px rgba(0,0,0,0.05)', marginBottom: '2rem' }}>
              <h3 style={{ color: umichBlue, marginTop: 0 }}>2. Data Visualizations & Plots</h3>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '2rem', marginTop: '1.5rem' }}>
                
                {/* Plot 1 */}
                <div style={{ border: '1px solid #eee', padding: '1.5rem', borderRadius: '8px' }}>
                  <h4 style={{ color: umichBlue, marginTop: 0 }}>Plot 1: Raw vs. Pre-Emphasized Speech</h4>
                  <div style={{ backgroundColor: '#f1f5f9', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '1rem', border: '1px dashed #cbd5e1' }}>
                    <img src="/Plot1.jpg" alt="Raw vs. Pre-Emphasized Speech" style={{ maxWidth: '100%', height: 'auto', borderRadius: '4px' }} />
                  </div>
                  <p style={{ lineHeight: '1.6' }}><strong>Description:</strong> The first plot shows the raw recorded speech data in the time domain compared to the same signal after passing through a high pass filter. This first filter boosts the higher frequencies from the raw data in order to compensate for the natural tone and volume changes in human voices. This is to ensure the high frequency vowel and consonant sounds remain intelligible during the vocoding process. </p>
                </div>

                {/* Plot 2*/}
                <div style={{ border: '1px solid #eee', padding: '1.5rem', borderRadius: '8px' }}>
                  <h4 style={{ color: umichBlue, marginTop: 0 }}>Plot 2: Spectral Envelope (FFT Spectrogram)</h4>
                  <div style={{ backgroundColor: '#f1f5f9', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '1rem', border: '1px dashed #cbd5e1' }}>
                    <img src="/Plot2.jpg" alt="Spectral Envelope FFT Spectrogram" style={{ maxWidth: '100%', height: 'auto', borderRadius: '4px' }} />
                  </div>
                  <p style={{ lineHeight: '1.6' }}><strong>Description:</strong> The second plot is a Fast Fourier Transform (FFT) magnitude spectrum of a single window from the speech data. The point of this plot is to visualize the extracted spectral envelope. This shows the peaks of the signal that characterize the vocal data at a specific moment in time. </p>
                </div>

                {/* Plot 3*/}
                <div style={{ border: '1px solid #eee', padding: '1.5rem', borderRadius: '8px' }}>
                  <h4 style={{ color: umichBlue, marginTop: 0 }}>Plot 3: Modulated Output Waveform</h4>
                  <div style={{ backgroundColor: '#f1f5f9', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '1rem', border: '1px dashed #cbd5e1' }}>
                    <img src="/Plot3.jpg" alt="Modulated Output Waveform" style={{ maxWidth: '100%', height: 'auto', borderRadius: '4px' }} />
                  </div>
                  <p style={{ lineHeight: '1.6' }}><strong>Description:</strong> The third plot is the final time domain waveform produced by our algorithm. This plot shows the synthetic carrier signal after it has been modulated across the frequency bands by the speech envelope from plot 2. </p>
                </div>

              </div>
            </div>

            {/* 3) Progress and Challenges */}
            <div style={{ backgroundColor: 'white', padding: '2rem', borderRadius: '8px', boxShadow: '0 2px 4px rgba(0,0,0,0.05)', marginBottom: '2rem' }}>
              <h3 style={{ color: umichBlue, marginTop: 0 }}>3. Current Progress & Challenges</h3>
              <p style={{ lineHeight: '1.6', fontSize: '1.1rem' }}>
                To date, we have completed our initial proof-of-concept vocoder in MATLAB, validating both our 16-band logarithmic filter bank and Short-Time Fourier Transform (STFT) spectral envelope extraction algorithms on pre-recorded audio, while simultaneously building our React front-end web application for live microphone routing, offline file uploads, and visual analysis. Our first major challenge was realizing that our MATLAB prototype could not run natively inside a browser without requiring users to have the MATLAB desktop client open or relying on an external backend server. To allow anyone to run the vocoder directly on our website with zero external software, we pivoted to porting our DSP pipeline into client-side JavaScript using the Web Audio API.
              </p>
            </div>

            {/* 4) Plan for Next 3 Weeks */}
            <div style={{ backgroundColor: 'white', padding: '2rem', borderRadius: '8px', boxShadow: '0 2px 4px rgba(0,0,0,0.05)', marginBottom: '2rem' }}>
              <h3 style={{ color: umichBlue, marginTop: 0 }}>4. Three-Week Action Plan</h3>
              <ul style={{ paddingLeft: '1.5rem', lineHeight: '1.6', fontSize: '1.1rem' }}>
                <li style={{ marginBottom: '0.5rem' }}><strong>Task 1:</strong> Collect the various human speech and the synthetic carrier data.</li>
                <li style={{ marginBottom: '0.5rem' }}><strong>Task 2:</strong> Optimize STFT overlap-add buffering for the live Web Audio stream to ensure smooth, low-latency playback.</li>
                <li style={{ marginBottom: '0.5rem' }}><strong>Task 3:</strong> Finalize UI for the website and connect the live spectrogram visualizations to the Web Audio analyzer.</li>
              </ul>
            </div>

            {/* 5) One Thing Learned */}
            <div style={{ backgroundColor: 'white', padding: '2rem', borderRadius: '8px', boxShadow: '0 2px 4px rgba(0,0,0,0.05)' }}>
              <h3 style={{ color: umichBlue, marginTop: 0 }}>5. Key Learning: DSP with JavaScript</h3>
              <p style={{ lineHeight: '1.6', fontSize: '1.1rem' }}>
                One new thing we have learned is how DSP works with JavaScript. Prior to our pivot, we had anticipated that we would do our entire project in MATLAB, as the MATLAB signal processing toolbox is very comprehensive and should have had everything that we needed for the project. However, upon realizing we would have to pivot away from MATLAB, we shifted our focus to a JavaScript based approach. Through this transition, we learned how the browser's built in Web Audio API handles real-time digital signal processing by routing audio through modular processing nodes on a dedicated audio rendering thread separate from the main user interface. Specifically, we discovered that JavaScript uses floating-point arrays to pass raw audio buffers between nodes, allowing us to implement custom bandpass filters for our offline filter bank and perform low-latency buffering for our live STFT vocoder directly in the browser without limiting page responsiveness.
              </p>
            </div>
          </section>
        )}

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
                <li><strong>Frequency-Domain Live Processing:</strong> A highly optimized, low-latency overlap-add architecture utilizing the Short-Time Fourier Transform (STFT) to vocode live microphone input in real-time.</li>
              </ul>
            </div>

            <div style={{ backgroundColor: 'white', padding: '2rem', borderRadius: '8px', boxShadow: '0 2px 4px rgba(0,0,0,0.05)' }}>
              <h3 style={{ color: umichBlue, marginTop: 0 }}>How to Use This Application</h3>
              <ul style={{ paddingLeft: '1.5rem', lineHeight: '1.6', fontSize: '1.1rem' }}>
                <li><strong>Live Vocoder:</strong> Navigate to the Live tab. Select a carrier signal from the dropdown. Click "Start," allow microphone permissions, and speak. The system will buffer your audio, compute the STFT to extract your spectral envelope, and dynamically modulate the carrier in real-time.</li>
                <li><strong>Offline Vocoder:</strong> Navigate to the Offline tab. Upload a speech file (the modulator) and an instrumental track (the carrier). The system will process the files through our IIR filter bank, providing high-fidelity vocoded output alongside spectrum analysis visualizations.</li>
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
                  <img src="/BandFrequencies.jpg" alt="Logarithmically Spaced Filter Bank" style={{ maxWidth: '100%', height: 'auto', borderRadius: '4px', boxShadow: '0 2px 4px rgba(0,0,0,0.1)' }} />
                </div>
                <h4 style={{ color: umichBlue }}>3. Envelope Extraction & Modulation</h4>
                <p>For each band, we extract the "shape" of the speech signal. The signal is first rectified (absolute value), passed through cascaded low-pass filters to capture the amplitude contour, and finally expanded quadratically to suppress background noise.</p>
                <p>Finally, the envelope of each speech band is multiplied by the carrier signal in that exact same frequency band. All modulated bands are then summed together (additive synthesis) to produce the final vocoded track.</p>
                <div style={{ margin: '1.5rem 0', textAlign: 'center' }}>
                  <img src="/SpeechEnvelope.jpg" alt="Speech Envelope Extraction" style={{ maxWidth: '100%', height: 'auto', borderRadius: '4px', boxShadow: '0 2px 4px rgba(0,0,0,0.1)' }} />
                </div>
              </div>

              <div style={{ backgroundColor: 'white', padding: '2rem', borderRadius: '8px', boxShadow: '0 2px 4px rgba(0,0,0,0.05)' }}>
                <h3 style={{ color: umichBlue, marginTop: 0, fontSize: '1.4rem' }}>Digital (Live) STFT Design</h3>
                <p>Because running massive cascaded filter banks is computationally expensive and introduces phase delays, our live real-time vocoder uses frequency-domain multiplication via the Short-Time Fourier Transform (STFT).</p>
                <h4 style={{ color: umichBlue }}>1. Windowing and Buffering</h4>
                <p>The continuous live microphone signal is segmented into buffers of 1024 samples. To prevent spectral leakage and edge artifacts, each frame is multiplied by a Hann window before processing.</p>
                <h4 style={{ color: umichBlue }}>2. Spectral Envelope Extraction & Modulation</h4>
                <p>We compute the Fast Fourier Transform (FFT) of the windowed speech frame. By taking the magnitude spectrum of this FFT and smoothing it (e.g., via a Gaussian filter or moving average), we approximate the spectral envelope of the user's voice for that exact moment in time.</p>
                <p>The carrier signal (also windowed and transformed via FFT) is then multiplied by this speech envelope in the frequency domain. This efficiently maps the vocal resonances onto the synthesizer tone.</p>
                <h4 style={{ color: umichBlue }}>3. Overlap-Add Reconstruction</h4>
                <p>To convert back to audio, we compute the Inverse Fast Fourier Transform (IFFT). Because we use windowed frames, we must overlap the output buffers (typically by 50%, or 512 samples) and add them together to reconstruct a continuous, artifact-free output signal.</p>
                <div style={{ height: '250px', backgroundColor: '#e2e8f0', borderRadius: '4px', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '1.5rem 0', flexDirection: 'column' }}>
                  <Activity size={32} color="#94a3b8" />
                  <span style={{ color: '#64748b', marginTop: '0.5rem' }}>[ Live STFT Spectrogram Output will render here ]</span>
                </div>
              </div>
            </div>
          </section>
        )}

        {/* PAGE 3: LIVE VOCODER */}
        {activeTab === 'live' && (
          <section>
            <h2 style={{ color: umichBlue, borderBottom: `2px solid ${umichMaize}`, paddingBottom: '0.5rem' }}>Live Real-Time Vocoder</h2>
            <div style={{ backgroundColor: 'white', padding: '2rem', borderRadius: '8px', boxShadow: '0 2px 4px rgba(0,0,0,0.05)', textAlign: 'center' }}>
              <p style={{ marginBottom: '2rem', fontSize: '1.1rem' }}>Select a carrier signal, click Start, and speak into your microphone.</p>
              <div style={{ display: 'flex', justifyContent: 'center', gap: '1rem', marginBottom: '2rem' }}>
                <select style={{ padding: '0.75rem', fontSize: '1rem', borderRadius: '4px', border: '1px solid #ccc', minWidth: '250px' }}>
                  <option>Select Carrier Signal...</option>
                  <option>Sawtooth Synth</option>
                  <option>White Noise</option>
                  <option>Robot Drone</option>
                </select>
                <button style={{ backgroundColor: '#28a745', color: 'white', border: 'none', padding: '0.75rem 1.5rem', fontSize: '1rem', borderRadius: '4px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <Mic size={18} /> Start Live Input
                </button>
                <button style={{ backgroundColor: '#dc3545', color: 'white', border: 'none', padding: '0.75rem 1.5rem', fontSize: '1rem', borderRadius: '4px', cursor: 'pointer' }}>
                  Stop
                </button>
              </div>
              
              <div style={{ height: '300px', backgroundColor: '#222', borderRadius: '4px', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column' }}>
                <Activity size={48} color="#00ff00" />
                <p style={{ color: '#00ff00', marginTop: '1rem', fontFamily: 'monospace' }}>Awaiting Audio Stream...</p>
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

              <div style={{ backgroundColor: 'white', padding: '1.5rem', borderRadius: '8px', boxShadow: '0 2px 4px rgba(0,0,0,0.05)' }}>
                <h3 style={{ margin: '0 0 1rem 0', color: umichBlue }}>Output & Analysis</h3>
                <div style={{ height: '200px', backgroundColor: '#f8f9fa', borderRadius: '4px', border: '1px solid #ddd', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '1rem', flexDirection: 'column' }}>
                  {offlineOutputUrl ? (
                    <Activity size={48} color={umichBlue} />
                  ) : (
                    <p style={{ color: '#666' }}>Upload files and click Process to generate analysis.</p>
                  )}
                </div>
                <audio controls src={offlineOutputUrl} style={{ width: '100%' }}>
                  Your browser does not support the audio element.
                </audio>
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
                <li>MDN Web Docs. <em>Web Audio API</em>. Mozilla Foundation. <a href="https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API" target="_blank" rel="noreferrer" style={{color: umichBlue}}>https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API</a></li>
              </ol>
            </div>
          </section>
        )}
      </main>
    </div>
  );
};

export default App;