# Vocal Trainer

A browser-based singing practice MVP built with React and Vite.

## What it does

- listens to your microphone locally in the browser
- estimates pitch in real time
- shows the detected note and cents sharp/flat
- tracks input steadiness and sustain time
- guides you through five phases:
  - body setup
  - breath control
  - gentle warmup
  - pitch matching
  - phrase practice

## What it does not do yet

This MVP does **not** do advanced lyric understanding, medical-grade vocal strain detection, or deep voice-type classification. It is a practical practice coach, not a replacement for a great teacher.

## Run locally

```bash
npm install
npm run dev
```

Then open the local Vite URL in your browser and allow microphone access.

## Build

```bash
npm run build
```

## Notes

- best in Chrome or another modern browser with Web Audio support
- the app requests microphone permission to analyze pitch and steadiness
- pitch detection works best in a quiet room with one voice at a time
