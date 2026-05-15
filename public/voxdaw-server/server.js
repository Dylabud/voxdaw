const WebSocket = require('ws');
const easymidi = require('easymidi');
const os = require('os'); // Built-in Node tool to check Mac vs Windows

let midiOutput;

// Explicitly check the Operating System
if (os.platform() === 'darwin') {
    // 'darwin' is Node's internal name for macOS
    midiOutput = new easymidi.Output('VoxDaw', true);
    console.log('🍎 Mac detected: Created Virtual MIDI port "VoxDaw"');
} else {
    // If it's Windows, connect to the loopMIDI cable
    midiOutput = new easymidi.Output('VoxDaw');
    console.log('🪟 Windows detected: Connected to loopMIDI port "VoxDaw"');
}

const wss = new WebSocket.Server({ port: 8080 });
console.log('🎹 VoxDaw MIDI Server running on ws://localhost:8080');

wss.on('connection', function connection(ws) {
  console.log('🟢 Browser connected to VoxDaw server!');

  ws.on('message', function incoming(message) {
    try {
      const data = JSON.parse(message);
      
      // Route the browser data directly to the OS MIDI driver
      if (data.type === 'noteon' || data.type === 'noteoff') {
        midiOutput.send(data.type, {
          note: data.note,
          velocity: data.velocity || 100,
          channel: data.channel || 0
        });
        console.log("SENDING TO MIDI: ", data.type, " Note: ", data.note);
      }
    } catch (e) {
      console.error('Error parsing message:', e);
    }
  });

  ws.on('close', () => console.log('🔴 Browser disconnected.'));
});