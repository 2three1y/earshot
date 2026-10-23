// Kokoro voice list (English voices of Kokoro-82M v1.0). The featured set mirrors
// the voice menu of pinguy/kokoro-tts-addon (Apache-2.0); the rest are from the model card.
export const KOKORO_VOICES = [
  { id: 'af_heart', name: 'Heart', desc: 'American female, warmest, best quality', group: 'American English' },
  { id: 'af_bella', name: 'Bella', desc: 'American female, expressive', group: 'American English' },
  { id: 'af_sarah', name: 'Sarah', desc: 'American female', group: 'American English' },
  { id: 'af_sky', name: 'Sky', desc: 'American female', group: 'American English' },
  { id: 'af_nicole', name: 'Nicole', desc: 'American female, soft', group: 'American English' },
  { id: 'af_alloy', name: 'Alloy', desc: 'American female', group: 'American English' },
  { id: 'af_aoede', name: 'Aoede', desc: 'American female', group: 'American English' },
  { id: 'af_jessica', name: 'Jessica', desc: 'American female', group: 'American English' },
  { id: 'af_kore', name: 'Kore', desc: 'American female', group: 'American English' },
  { id: 'af_nova', name: 'Nova', desc: 'American female', group: 'American English' },
  { id: 'af_river', name: 'River', desc: 'American female', group: 'American English' },
  { id: 'am_michael', name: 'Michael', desc: 'American male', group: 'American English' },
  { id: 'am_adam', name: 'Adam', desc: 'American male', group: 'American English' },
  { id: 'am_fenrir', name: 'Fenrir', desc: 'American male', group: 'American English' },
  { id: 'am_puck', name: 'Puck', desc: 'American male', group: 'American English' },
  { id: 'am_echo', name: 'Echo', desc: 'American male', group: 'American English' },
  { id: 'am_eric', name: 'Eric', desc: 'American male', group: 'American English' },
  { id: 'am_liam', name: 'Liam', desc: 'American male', group: 'American English' },
  { id: 'am_onyx', name: 'Onyx', desc: 'American male, deep', group: 'American English' },
  { id: 'am_santa', name: 'Santa', desc: 'American male, jolly', group: 'American English' },
  { id: 'bf_emma', name: 'Emma', desc: 'British female', group: 'British English' },
  { id: 'bf_isabella', name: 'Isabella', desc: 'British female', group: 'British English' },
  { id: 'bf_alice', name: 'Alice', desc: 'British female', group: 'British English' },
  { id: 'bf_lily', name: 'Lily', desc: 'British female', group: 'British English' },
  { id: 'bm_george', name: 'George', desc: 'British male', group: 'British English' },
  { id: 'bm_lewis', name: 'Lewis', desc: 'British male', group: 'British English' },
  { id: 'bm_daniel', name: 'Daniel', desc: 'British male', group: 'British English' },
  { id: 'bm_fable', name: 'Fable', desc: 'British male', group: 'British English' },
];

export const SAMPLE_TEXT = `# Welcome to Earshot

Earshot reads things out loud and listens when you talk. Everything happens on your own device. There is no account and no cloud.

## Reading

Press Read to start, Pause to hold your place, and Stop to go back to the beginning. You can move by sentence or by paragraph, and you can change the speed at any time.

You can paste text, open a text, Markdown or web page file, or fetch a web page by its address. Wikipedia articles and GitHub project pages work well.

## Voices

There are three ways to listen. Your device's voice works right away with no download. Earshot's neural voices sound much more natural. They are Kokoro voices, and you load them once under Load voices. The third way is VoiceOver mode, where Earshot moves the focus and your own screen reader does the reading, in the voice and speed you already like.

## Talking

Press Talk and say a command, like read, pause, faster, slower, next, back, or where am I. You can also ask a question about the text. With Whisper loaded, your voice is turned into text right on your device, so nothing you say is uploaded.

## Questions

When you ask a question, Earshot finds the passage that matches best and reads it to you. If you load the small answer model on a computer with WebGPU, it can also answer in its own words. It always shows you the passage it used, so you can check it.

## Shortcuts

Press K to read or pause, S to stop, J and L to move by sentence, P and N to move by paragraph, the minus and equals keys to change speed, and T to talk. Escape stops whatever Earshot is doing.

Have fun, and happy listening!`;
