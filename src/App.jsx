import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const PHASES = [
  {
    id: 'setup',
    title: '1. Body Setup',
    subtitle: 'Get your body organized before you sing',
    description:
      'Stand tall, release your jaw, keep your neck easy, and inhale quietly without lifting your shoulders.',
    type: 'checklist',
    checklist: [
      'Feet under hips',
      'Jaw unclenched',
      'Neck relaxed',
      'Shoulders stay down on inhale',
      'Chest relaxed, not puffed up'
    ],
    successHint: 'The goal is grounded, not rigid.'
  },
  {
    id: 'breath',
    title: '2. Breath Control',
    subtitle: 'Train smooth airflow with a hiss',
    description:
      'Take a quiet inhale, then hiss on “ssss” for 8–12 seconds. Even airflow matters more than power.',
    type: 'breath',
    targetSeconds: 8,
    successHint: 'Low pressure and consistency beat force.'
  },
  {
    id: 'warmup',
    title: '3. Gentle Warmup',
    subtitle: 'Use hums or lip trills before bigger singing',
    description:
      'Warm up lightly. The app listens for a stable pitch and low effort, not for loudness.',
    type: 'freePitch',
    successHint: 'Warmups should feel simple and easy.'
  },
  {
    id: 'pitch',
    title: '4. Pitch Match',
    subtitle: 'Land on a note and hold it cleanly',
    description:
      'Match the target note softly and hold it within about ±20 cents. Start light, not loud.',
    type: 'targetPitch',
    targets: [
      { note: 'A3', freq: 220.0 },
      { note: 'C4', freq: 261.63 },
      { note: 'E4', freq: 329.63 },
      { note: 'G4', freq: 392.0 }
    ],
    successHint: 'Clean and repeatable matters more than dramatic.'
  },
  {
    id: 'phrase',
    title: '5. Phrase Practice',
    subtitle: 'Work one short line instead of blasting a full song',
    description:
      'Speak the phrase, sing it on one vowel, then add the real words without adding extra force.',
    type: 'phrase',
    phrase: 'We grow off-screen, out of sight',
    successHint: 'One phrase repeated carefully is real practice.'
  }
];

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function freqToMidi(freq) {
  return 69 + 12 * Math.log2(freq / 440);
}

function getIdealFreqFromMidi(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function freqToNote(freq) {
  if (!freq || !isFinite(freq) || freq <= 0) return null;
  const midi = Math.round(freqToMidi(freq));
  const name = NOTE_NAMES[midi % 12];
  const octave = Math.floor(midi / 12) - 1;
  return `${name}${octave}`;
}

function centsOffFromFreq(freq, targetFreq) {
  if (!freq || !targetFreq) return null;
  return 1200 * Math.log2(freq / targetFreq);
}

function centsFromNearest(freq) {
  if (!freq || !isFinite(freq) || freq <= 0) return null;
  const midi = Math.round(freqToMidi(freq));
  const nearestFreq = getIdealFreqFromMidi(midi);
  return 1200 * Math.log2(freq / nearestFreq);
}

function autoCorrelate(buffer, sampleRate) {
  const size = buffer.length;
  let rms = 0;
  for (let i = 0; i < size; i += 1) {
    const value = buffer[i];
    rms += value * value;
  }
  rms = Math.sqrt(rms / size);
  if (rms < 0.01) return -1;

  let r1 = 0;
  let r2 = size - 1;
  const threshold = 0.2;

  for (let i = 0; i < size / 2; i += 1) {
    if (Math.abs(buffer[i]) < threshold) {
      r1 = i;
      break;
    }
  }

  for (let i = 1; i < size / 2; i += 1) {
    if (Math.abs(buffer[size - i]) < threshold) {
      r2 = size - i;
      break;
    }
  }

  const trimmed = buffer.slice(r1, r2);
  const correlations = new Array(trimmed.length).fill(0);

  for (let lag = 0; lag < trimmed.length; lag += 1) {
    for (let i = 0; i < trimmed.length - lag; i += 1) {
      correlations[lag] += trimmed[i] * trimmed[i + lag];
    }
  }

  let d = 0;
  while (d + 1 < correlations.length && correlations[d] > correlations[d + 1]) d += 1;

  let maxValue = -1;
  let maxIndex = -1;
  for (let i = d; i < correlations.length; i += 1) {
    if (correlations[i] > maxValue) {
      maxValue = correlations[i];
      maxIndex = i;
    }
  }

  if (maxIndex <= 0) return -1;

  const x1 = correlations[maxIndex - 1] ?? correlations[maxIndex];
  const x2 = correlations[maxIndex];
  const x3 = correlations[maxIndex + 1] ?? correlations[maxIndex];
  const a = (x1 + x3 - 2 * x2) / 2;
  const b = (x3 - x1) / 2;
  const shift = a ? -b / (2 * a) : 0;
  const period = maxIndex + shift;

  if (!period || !isFinite(period)) return -1;
  return sampleRate / period;
}

function App() {
  const [micEnabled, setMicEnabled] = useState(false);
  const [error, setError] = useState('');
  const [currentFreq, setCurrentFreq] = useState(null);
  const [volume, setVolume] = useState(0);
  const [phaseIndex, setPhaseIndex] = useState(0);
  const [targetIndex, setTargetIndex] = useState(0);
  const [checklistDone, setChecklistDone] = useState({});
  const [breathSeconds, setBreathSeconds] = useState(0);
  const [holdSeconds, setHoldSeconds] = useState(0);
  const [sessionSeconds, setSessionSeconds] = useState(0);
  const [analysisText, setAnalysisText] = useState('Mic off. Start the session when you are ready.');

  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const streamRef = useRef(null);
  const rafRef = useRef(null);
  const timerRef = useRef(null);
  const breathWindowRef = useRef([]);
  const pitchWindowRef = useRef([]);
  const breathHoldRef = useRef(0);
  const pitchHoldRef = useRef(0);

  const phase = PHASES[phaseIndex];
  const target = phase.type === 'targetPitch' ? phase.targets[targetIndex] : null;
  const currentNote = useMemo(() => freqToNote(currentFreq), [currentFreq]);
  const nearestCents = useMemo(() => centsFromNearest(currentFreq), [currentFreq]);
  const targetCents = useMemo(() => {
    if (!currentFreq || !target?.freq) return null;
    return centsOffFromFreq(currentFreq, target.freq);
  }, [currentFreq, target]);

  const breathStability = useMemo(() => {
    const items = breathWindowRef.current;
    if (!items.length) return 0;
    const mean = items.reduce((sum, value) => sum + value, 0) / items.length;
    const variance = items.reduce((sum, value) => sum + (value - mean) ** 2, 0) / items.length;
    const std = Math.sqrt(variance);
    return clamp(Math.round((1 - std / Math.max(mean, 0.001)) * 100), 0, 100);
  }, [volume, sessionSeconds]);

  const pitchStability = useMemo(() => {
    const items = pitchWindowRef.current;
    if (items.length < 4) return 0;
    const mean = items.reduce((sum, value) => sum + value, 0) / items.length;
    const variance = items.reduce((sum, value) => sum + (value - mean) ** 2, 0) / items.length;
    const std = Math.sqrt(variance);
    return clamp(Math.round(100 - std), 0, 100);
  }, [currentFreq, sessionSeconds]);

  const checklistComplete = useMemo(() => {
    if (phase.type !== 'checklist') return false;
    return phase.checklist.every((item) => checklistDone[item]);
  }, [phase, checklistDone]);

  const resetLiveMetrics = useCallback(() => {
    breathWindowRef.current = [];
    pitchWindowRef.current = [];
    breathHoldRef.current = 0;
    pitchHoldRef.current = 0;
    setBreathSeconds(0);
    setHoldSeconds(0);
  }, []);

  const stopMic = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (timerRef.current) clearInterval(timerRef.current);
    streamRef.current?.getTracks()?.forEach((track) => track.stop());
    audioContextRef.current?.close?.();

    rafRef.current = null;
    timerRef.current = null;
    streamRef.current = null;
    analyserRef.current = null;
    audioContextRef.current = null;

    setMicEnabled(false);
    setCurrentFreq(null);
    setVolume(0);
  }, []);

  const coachMessage = useCallback(
    ({ rms, detectedFreq }) => {
      if (!micEnabled) return 'Mic off. Start the session when you are ready.';

      if (phase.type === 'checklist') {
        return checklistComplete
          ? 'Good. Your body setup is organized. Move into breath work next.'
          : 'Do not rush. Release the jaw, neck, and shoulders first.';
      }

      if (phase.type === 'breath') {
        if (rms < 0.012) return 'Give me a real hiss. Quiet is good, but I still need enough signal to track it.';
        if (breathStability > 80) return 'That airflow is steady. Keep the pressure low and hold it.';
        if (breathStability > 60) return 'Better. Smooth it out even more. Less pulsing, less collapse.';
        return 'The air is wobbling. Use less force and think even release.';
      }

      if (phase.type === 'freePitch') {
        if (!detectedFreq) return 'Hum lightly or do a lip trill. I am listening for an easy stable pitch.';
        if (pitchStability > 80) return 'Nice. The pitch is settling quickly and staying organized.';
        if (volume > 0.12) return 'You are pushing too hard for a warmup. Reduce effort.';
        return 'The pitch is there, but it is wobbling. Keep the sound simpler.';
      }

      if (phase.type === 'targetPitch') {
        if (!detectedFreq) return `Match ${target.note} softly. Start lighter than you think.`;
        if (Math.abs(targetCents ?? 999) <= 20) return `Locked in. Hold ${target.note} right there.`;
        if ((targetCents ?? 0) > 20) return `You are sharp by about ${Math.round(targetCents)} cents. Ease lower.`;
        return `You are flat by about ${Math.abs(Math.round(targetCents ?? 0))} cents. Aim a little higher without shoving air.`;
      }

      if (phase.type === 'phrase') {
        if (!detectedFreq) return 'Speak the line first, then sing it on one vowel before you use the words.';
        if (volume > 0.14) return 'Too much push. Clean beats dramatic right now.';
        if (pitchStability > 80) return 'Good. Keep that same ease when you add the words.';
        return 'Work smaller. One phrase, one vowel, one correction at a time.';
      }

      return 'Stay relaxed and keep going.';
    },
    [micEnabled, phase, checklistComplete, breathStability, pitchStability, volume, target, targetCents]
  );

  const analyze = useCallback(() => {
    const analyser = analyserRef.current;
    const audioContext = audioContextRef.current;
    if (!analyser || !audioContext) return;

    const buffer = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(buffer);

    let rms = 0;
    for (let i = 0; i < buffer.length; i += 1) {
      rms += buffer[i] * buffer[i];
    }
    rms = Math.sqrt(rms / buffer.length);
    setVolume(rms);

    const rawFreq = autoCorrelate(buffer, audioContext.sampleRate);
    const validFreq = rawFreq > 60 && rawFreq < 1200 ? rawFreq : null;
    setCurrentFreq(validFreq);

    if (phase.type === 'breath') {
      if (rms > 0.012) {
        breathHoldRef.current += 1 / 60;
        setBreathSeconds(breathHoldRef.current);
        breathWindowRef.current = [...breathWindowRef.current.slice(-119), rms];
      } else {
        breathHoldRef.current = 0;
        setBreathSeconds(0);
        breathWindowRef.current = [];
      }
    }

    if (validFreq) {
      pitchWindowRef.current = [...pitchWindowRef.current.slice(-119), Math.abs(centsFromNearest(validFreq) ?? 0)];
    } else {
      pitchWindowRef.current = [];
    }

    if (phase.type === 'targetPitch' && validFreq && target?.freq) {
      const cents = Math.abs(centsOffFromFreq(validFreq, target.freq));
      if (cents <= 20) {
        pitchHoldRef.current += 1 / 60;
        setHoldSeconds(pitchHoldRef.current);
      } else {
        pitchHoldRef.current = 0;
        setHoldSeconds(0);
      }
    } else if (phase.type !== 'targetPitch') {
      pitchHoldRef.current = 0;
      setHoldSeconds(0);
    }

    setAnalysisText(coachMessage({ rms, detectedFreq: validFreq }));
    rafRef.current = requestAnimationFrame(analyze);
  }, [coachMessage, phase.type, target]);

  const startMic = useCallback(async () => {
    try {
      setError('');
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          autoGainControl: false,
          noiseSuppression: false
        }
      });

      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      const audioContext = new AudioContextClass();
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.85;
      source.connect(analyser);

      streamRef.current = stream;
      audioContextRef.current = audioContext;
      analyserRef.current = analyser;
      setMicEnabled(true);

      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = setInterval(() => {
        setSessionSeconds((previous) => previous + 1);
      }, 1000);

      rafRef.current = requestAnimationFrame(analyze);
    } catch (err) {
      setError('Microphone access was blocked or unavailable. This app needs mic permission to coach you in real time.');
    }
  }, [analyze]);

  useEffect(() => {
    return () => stopMic();
  }, [stopMic]);

  useEffect(() => {
    resetLiveMetrics();
  }, [phaseIndex, targetIndex, resetLiveMetrics]);

  const phaseProgress = useMemo(() => {
    if (phase.type === 'checklist') {
      return (Object.values(checklistDone).filter(Boolean).length / phase.checklist.length) * 100;
    }
    if (phase.type === 'breath') {
      return (breathSeconds / phase.targetSeconds) * 100;
    }
    if (phase.type === 'targetPitch') {
      return (holdSeconds / 2.5) * 100;
    }
    if (phase.type === 'freePitch') {
      return pitchStability;
    }
    if (phase.type === 'phrase') {
      return pitchStability * 0.8 + clamp((1 - volume / 0.18) * 100, 0, 100) * 0.2;
    }
    return 0;
  }, [phase, checklistDone, breathSeconds, holdSeconds, pitchStability, volume]);

  const readyToAdvance =
    (phase.type === 'checklist' && checklistComplete) ||
    (phase.type === 'breath' && breathSeconds >= phase.targetSeconds) ||
    (phase.type === 'freePitch' && pitchStability >= 75 && !!currentFreq) ||
    (phase.type === 'targetPitch' && holdSeconds >= 2.5) ||
    (phase.type === 'phrase' && pitchStability >= 75 && volume < 0.14 && !!currentFreq);

  function toggleChecklist(item) {
    setChecklistDone((previous) => ({ ...previous, [item]: !previous[item] }));
  }

  function advancePhase() {
    setPhaseIndex((previous) => Math.min(previous + 1, PHASES.length - 1));
  }

  function nextTarget() {
    if (phase.type !== 'targetPitch') return;
    setTargetIndex((previous) => (previous + 1) % phase.targets.length);
  }

  function resetSession() {
    setPhaseIndex(0);
    setTargetIndex(0);
    setSessionSeconds(0);
    setChecklistDone({});
    resetLiveMetrics();
    setAnalysisText('Session reset. Start again and keep the reps clean.');
  }

  return (
    <div className="app-shell">
      <div className="container">
        <header className="hero-card">
          <div>
            <div className="badge">Real-time singing coach MVP</div>
            <h1>Vocal Trainer</h1>
            <p className="hero-text">
              This app listens to your mic, estimates pitch, tracks steadiness, and guides you through setup,
              breath, warmups, pitch matching, and phrase work.
            </p>
          </div>
          <div className="button-row">
            {!micEnabled ? (
              <button className="primary-button" onClick={startMic}>Start mic</button>
            ) : (
              <button className="secondary-button" onClick={stopMic}>Stop mic</button>
            )}
            <button className="secondary-button" onClick={resetSession}>Reset</button>
          </div>
        </header>

        {error ? <div className="error-box">{error}</div> : null}

        <div className="layout-grid">
          <main className="main-column">
            <section className="metrics-grid">
              <div className="metric-card">
                <div className="metric-label">Detected note</div>
                <div className="metric-value">{currentNote ?? '—'}</div>
                <div className="metric-subvalue">{currentFreq ? `${currentFreq.toFixed(1)} Hz` : 'No stable pitch yet'}</div>
              </div>
              <div className="metric-card">
                <div className="metric-label">Pitch offset</div>
                <div className="metric-value">
                  {nearestCents == null ? '—' : `${Math.round(nearestCents) > 0 ? '+' : ''}${Math.round(nearestCents)}¢`}
                </div>
                <div className="metric-subvalue">Relative to nearest note</div>
              </div>
              <div className="metric-card">
                <div className="metric-label">Input level</div>
                <div className="metric-value">{volume.toFixed(3)}</div>
                <div className="metric-subvalue">Lower and steadier is usually better</div>
              </div>
              <div className="metric-card">
                <div className="metric-label">Session time</div>
                <div className="metric-value">
                  {Math.floor(sessionSeconds / 60)}:{String(sessionSeconds % 60).padStart(2, '0')}
                </div>
                <div className="metric-subvalue">Consistency beats marathon sessions</div>
              </div>
            </section>

            <section className="phase-card">
              <div className="phase-header">
                <div>
                  <div className="eyebrow">Current phase</div>
                  <h2>{phase.title}</h2>
                  <div className="phase-subtitle">{phase.subtitle}</div>
                </div>
                <div className="progress-box">
                  <span>Progress</span>
                  <strong>{Math.round(clamp(phaseProgress, 0, 100))}%</strong>
                </div>
              </div>

              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${clamp(phaseProgress, 0, 100)}%` }} />
              </div>

              <p className="phase-description">{phase.description}</p>

              {phase.type === 'checklist' ? (
                <div className="checklist-grid">
                  {phase.checklist.map((item) => (
                    <button
                      key={item}
                      className={`check-item ${checklistDone[item] ? 'check-item-active' : ''}`}
                      onClick={() => toggleChecklist(item)}
                    >
                      <span>{item}</span>
                      <span>{checklistDone[item] ? '✓' : '○'}</span>
                    </button>
                  ))}
                </div>
              ) : null}

              {phase.type === 'breath' ? (
                <div className="phase-detail-grid two-column">
                  <div className="detail-card">
                    <div className="detail-label">Active hiss time</div>
                    <div className="detail-value">{breathSeconds.toFixed(1)}s</div>
                    <div className="detail-subvalue">Target: {phase.targetSeconds}s steady hiss</div>
                  </div>
                  <div className="detail-card">
                    <div className="detail-label">Breath steadiness</div>
                    <div className="detail-value">{breathStability}%</div>
                    <div className="detail-subvalue">Less wobble, less pressure</div>
                  </div>
                </div>
              ) : null}

              {phase.type === 'freePitch' ? (
                <div className="phase-detail-grid two-column">
                  <div className="detail-card">
                    <div className="detail-label">Pitch steadiness</div>
                    <div className="detail-value">{pitchStability}%</div>
                    <div className="detail-subvalue">Hum or lip trill lightly</div>
                  </div>
                  <div className="detail-card">
                    <div className="detail-label">Coach focus</div>
                    <div className="detail-value small-title">Easy tone, low effort</div>
                    <div className="detail-subvalue">Warmups should feel organized, not dramatic</div>
                  </div>
                </div>
              ) : null}

              {phase.type === 'targetPitch' ? (
                <div className="phase-detail-grid target-layout">
                  <div className="detail-card">
                    <div className="target-row">
                      <div>
                        <div className="detail-label">Target note</div>
                        <div className="detail-value">{target.note}</div>
                        <div className="detail-subvalue">{target.freq.toFixed(2)} Hz</div>
                      </div>
                      <div className="target-right">
                        <div className="detail-label">Offset from target</div>
                        <div className="detail-value">
                          {targetCents == null ? '—' : `${Math.round(targetCents) > 0 ? '+' : ''}${Math.round(targetCents)}¢`}
                        </div>
                        <div className="detail-subvalue">Aim for ±20¢</div>
                      </div>
                    </div>
                    <div className="sub-progress-header">
                      <span>Hold time inside target</span>
                      <span>{holdSeconds.toFixed(1)} / 2.5s</span>
                    </div>
                    <div className="progress-track">
                      <div className="progress-fill" style={{ width: `${clamp((holdSeconds / 2.5) * 100, 0, 100)}%` }} />
                    </div>
                  </div>
                  <button className="secondary-button tall-button" onClick={nextTarget}>Next target</button>
                </div>
              ) : null}

              {phase.type === 'phrase' ? (
                <div className="detail-card phrase-card">
                  <div className="detail-label">Practice phrase</div>
                  <div className="phrase-text">“{phase.phrase}”</div>
                  <div className="phase-detail-grid three-column">
                    <div className="mini-step">
                      <div className="detail-label">Step 1</div>
                      <div>Speak the phrase clearly</div>
                    </div>
                    <div className="mini-step">
                      <div className="detail-label">Step 2</div>
                      <div>Sing it on “oo” or “ah”</div>
                    </div>
                    <div className="mini-step">
                      <div className="detail-label">Step 3</div>
                      <div>Add the real words without extra force</div>
                    </div>
                  </div>
                </div>
              ) : null}

              <div className="action-row">
                <button
                  className="primary-button"
                  onClick={advancePhase}
                  disabled={!readyToAdvance && phaseIndex !== PHASES.length - 1}
                >
                  {phaseIndex === PHASES.length - 1 ? 'Final phase' : 'Advance phase'}
                </button>
                <span className="hint-text">{phase.successHint}</span>
              </div>
            </section>
          </main>

          <aside className="side-column">
            <section className="side-card">
              <div className="eyebrow">Coach feedback</div>
              <div className="coach-box">{analysisText}</div>
            </section>

            <section className="side-card">
              <div className="eyebrow">Phase roadmap</div>
              <div className="roadmap-list">
                {PHASES.map((item, index) => {
                  const active = index === phaseIndex;
                  const complete = index < phaseIndex;
                  return (
                    <div
                      key={item.id}
                      className={`roadmap-item ${active ? 'roadmap-item-active' : ''} ${complete ? 'roadmap-item-complete' : ''}`}
                    >
                      <div>
                        <div className="roadmap-title">{item.title}</div>
                        <div className="roadmap-subtitle">{item.subtitle}</div>
                      </div>
                      <div className="roadmap-status">{complete ? '✓' : active ? '●' : '○'}</div>
                    </div>
                  );
                })}
              </div>
            </section>

            <section className="side-card">
              <div className="eyebrow">What this MVP can judge</div>
              <ul className="capability-list">
                <li>Pitch detection and note matching</li>
                <li>Sharp or flat offset in cents</li>
                <li>Volume level and steadiness</li>
                <li>Sustain time inside a target</li>
                <li>Whether you are likely pushing too hard</li>
              </ul>
              <p className="small-print">
                This version does not do advanced lyric understanding, true vowel classification, or medical-grade strain
                detection. It is a practical trainer, not magic.
              </p>
            </section>
          </aside>
        </div>
      </div>
    </div>
  );
}

export default App;
