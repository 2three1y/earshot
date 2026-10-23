# Earshot

A talking reader and assistant that runs in your browser. It reads anything aloud with natural neural voices, listens when you talk, and answers questions about the text. Everything runs on your device. No account, no cloud.

Live: https://2three1y.github.io/earshot/

I made this from repos in my GitHub stars. Carter (2three1y).

## What it does

- Reads pasted text, .txt, .md and .html files, and web pages that allow it (Wikipedia and GitHub project pages work).
- Three ways to listen: your device's voice (instant), Earshot's Kokoro neural voices (28 English voices, downloaded once), or VoiceOver mode, where Earshot moves the focus and your own screen reader reads.
- Talk to it: press Talk and say "read", "pause", "faster", "next paragraph", "where am I", "what is this about?", or ask a question about the text. With Whisper loaded, speech recognition stays on your device.
- Ask about the text: it finds the passage that matches your question and reads it. Optional on-device models add matching by meaning and short answers in its own words.

## Made for VoiceOver

- Big Read, Pause and Stop buttons, plus sentence and paragraph moves.
- Speed slider with a spoken value, and voice pickers for neural and device voices.
- One polite live region. It stays quiet while Earshot is talking, says only the newest message when speech stops, and never repeats itself.
- VoiceOver mode: Read moves focus to the paragraph you're on, so VoiceOver reads it in your own voice and speed. Swipe on, or use read-all.
- Lock-screen and headphone controls work with the neural voice.
- Short tones when listening starts and stops.

## Keyboard shortcuts

They work when you're not typing in a text box. Escape works everywhere.

- K: read or pause
- S: stop
- Escape: stop talking or listening
- J and L: back or forward one sentence
- P and N: previous or next paragraph
- Minus and equals: slower or faster
- T: talk
- A: jump to the question box
- W: where am I
- Question mark: jump to the shortcut list

## Models and download sizes

Nothing downloads until you press Load voices. The button shows the total size first. Models come from Hugging Face and are kept in your browser for offline use.

- Speech engine (ONNX Runtime Web, from this site): about 13 MB, or 24 MB when the answer model is on
- Kokoro 82M neural voice, 8-bit: about 93 MB
- Whisper Tiny English: about 73 MB (8-bit encoder, 16-bit decoder)
- Whisper Base English: about 131 MB
- Distil-Whisper Small English: about 252 MB
- all-MiniLM-L6-v2 for matching by meaning: about 23 MB
- Granite 4.0 350M for answers in its own words: about 350 to 580 MB, needs WebGPU (desktop Chrome or Edge)

## Honest limits

- The neural models are heavy for phones. On an iPhone the first sentence can take a few seconds, and there may be short gaps between sentences. Device voice and VoiceOver mode are instant.
- Whisper's 8-bit decoder doesn't start in this ONNX Runtime build, so the decoder is 16-bit, which makes the download bigger than usual.
- The answer model needs WebGPU, so it's off on iPhone, iPad and Safari. Without it, answers are found passages, not explanations, and the page says so.
- Device speech recognition (used before Whisper is loaded) may send audio to Apple or Google. Whisper keeps it on your device.
- Web pages only load when the site allows cross-site reading (CORS).
- It hasn't been tested on a real iPhone with VoiceOver yet. It was tested with a keyboard, an automated accessibility check, and headless Chrome.

## Credits

Starred repos used, with licenses. Full details are on the credits page and in credits.json and NOTICE.

- nico-martin/gemma4-browser-extension, MIT: the in-browser Transformers.js approach and model choices
- pinguy/kokoro-tts-addon, Apache-2.0: the Kokoro offline neural voice and its voice list
- openai/whisper, MIT: speech recognition models
- huggingface/distil-whisper, MIT: Distil-Whisper Small English
- espeak-ng/espeak-ng, GPL-3.0-or-later: phonemes for Kokoro

Bundled because the starred projects are built on them: Transformers.js 4.2.0 (Apache-2.0), ONNX Runtime Web (MIT), and phonemizer 1.2.1 (the WebAssembly build of eSpeak NG).

## License

GPL-3.0-or-later, because Earshot ships eSpeak NG. See LICENSE and NOTICE.

## Development

It's plain HTML, CSS and JavaScript modules with no build step. Serve the folder with any static server. Run the checks with:

    node --test
