const status = document.getElementById('status');
const allow = document.getElementById('allow');
async function send(message) {
  try {
    const reply = await chrome.runtime.sendMessage(message);
    status.textContent = reply.error || reply.message;
    if (message.type === 'status') {
      document.getElementById('reload').hidden = reply.protocol === 5;
      allow.disabled = !!reply.connecting || reply.protocol !== 5;
    }
  } catch (error) {
    status.textContent = error.message;
  }
}
allow.addEventListener('click', async () => {
  allow.disabled = true;
  await send({ type: 'connect' });
  allow.disabled = false;
});
document.getElementById('stop').addEventListener('click', () => void send({ type: 'stop' }));
document.getElementById('forget').addEventListener('click', () => void send({ type: 'forget' }));
document.getElementById('reload').addEventListener('click', () => chrome.runtime.reload());
void send({ type: 'status' });
setInterval(() => void send({ type: 'status' }), 1000);
