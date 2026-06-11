require('dotenv').config();
const { fork } = require('child_process');
const path = require('path');

const children = new Map();
function start(name, file, env = {}) {
  const child = fork(path.join(__dirname, file), [], {
    cwd: __dirname,
    env: { ...process.env, ...env },
    stdio: 'inherit'
  });
  children.set(name, child);
  child.on('exit', (code, signal) => {
    children.delete(name);
    if (!shuttingDown) {
      console.log(`[supervisor] ${name} beendet (${code || signal}), Neustart in 3s...`);
      setTimeout(() => start(name, file, env), 3000);
    }
  });
  console.log(`[supervisor] ${name} gestartet (PID ${child.pid})`);
}
let shuttingDown = false;
function shutdown() {
  shuttingDown = true;
  for (const child of children.values()) child.kill('SIGTERM');
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start('discord-bot', 'bot.js', { RUNNING_INSIDE_KAN_SUPERVISOR: '1' });
start('web-dashboard', 'server.js', { RUNNING_INSIDE_KAN_SUPERVISOR: '1' });
