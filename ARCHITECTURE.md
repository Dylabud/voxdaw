# VoxDaw - Technical Architecture & Implementation Blueprint

## Overview
This document outlines the technical stack, data flow, and architecture for VoxDaw Tool 2 (Live Gesture Instrument). The system requires seamless integration between browser hardware APIs (Camera, Microphone) and intensive real-time processing algorithms.

## 1. Technical Stack
* **Frontend Framework:** React (initialized via Vite) for a lightning-fast development environment and optimized production builds.
* **Language:** TypeScript (Strict Mode) to ensure type safety across complex mathematical and state objects.
* **Styling:** Tailwind CSS or standard CSS Modules, adhering strictly to the `#0e0e10` (Background) and `#5DCAA5` (Accent) color palette.

## 2. Core Engines & Libraries
* **Gesture Recognition Engine:** `MediaPipe Hands` (by Google).
    * *Why:* It runs directly in the browser via WebAssembly (WASM), providing high-fidelity, sub-millisecond 3D hand tracking without needing server-side processing. This is critical for zero-latency goals.
* **Audio DSP Engine:** `Tone.js` (Wrapper for Web Audio API).
    * *Why:* Provides mathematically precise, high-performance building blocks for synthesizers, effects (reverb, vibrato), and scheduling. It allows us to tie gesture coordinate data directly to audio signal parameters.

## 3. System Data Flow
1.  **Input Layer:** `getUserMedia` requests camera access. The video feed is drawn to a hidden `<canvas>` element to optimize processing.
2.  **Processing Layer (Video):** MediaPipe consumes the canvas data on every frame (`requestAnimationFrame`), outputting an array of 3D coordinates (X, Y, Z) for 21 hand landmarks.
3.  **Mapping Layer (The Math):** A dedicated utility maps raw coordinate data to usable audio parameters. 
    * *Example:* Distance between thumb and index finger (calculated via Euclidean distance) maps to `0.0 - 1.0` range for Volume.
4.  **Output Layer (Audio):** The mapped values are fed directly to the `Tone.js` nodes (e.g., `synth.frequency.rampTo(mappedPitch, 0.1)`).

## 4. UI/UX Layout
* **Main Viewport:** A clean, centralized dashboard. 
* **Center Focus:** A stylized, minimalist representation of the live camera feed (perhaps a dot-matrix or silhouette filter to maintain the dark premium vibe) so the user can see their hands tracking.
* **Telemetry HUD:** Unobtrusive, floating metrics displaying real-time data (Pitch Hz, Reverb Decay, Velocity) updating dynamically.
* **Controls:** Hidden or collapsible side-panel for advanced settings (oscillator type, scale locking, effect routing).