const { EdgeTTS } = require('node-edge-tts');
const fs = require('fs');

async function main() {
  const tts1 = new EdgeTTS({ voice: 'en-US-ChristopherNeural' });
  await tts1.ttsPromise("This is the default voice. Perfect for any kind of story.", "frontend/preview_default.mp3");
  
  const tts2 = new EdgeTTS({ voice: 'en-US-GuyNeural' });
  await tts2.ttsPromise("I am the energetic voice. Let's get right into the gameplay!", "frontend/preview_energetic.mp3");
  
  const tts3 = new EdgeTTS({ voice: 'en-US-AriaNeural' });
  await tts3.ttsPromise("This is the calm voice. Relax and listen closely.", "frontend/preview_calm.mp3");
  
  const tts4 = new EdgeTTS({ voice: 'en-GB-RyanNeural' });
  await tts4.ttsPromise("I am the narrator. Every great story begins with a single step.", "frontend/preview_narrator.mp3");
  console.log("Previews generated!");
}
main();
