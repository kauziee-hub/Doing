import { formatMessage } from './format.js';
const byId = (id) => document.getElementById(id);
const prompt = byId('prompt');
let latest = null;
let refreshing = false;
let sending = false;
let messageKey = '';
let tabKey = '';
let stickyError = '';

async function send(message) {
  const reply = await chrome.runtime.sendMessage(message);
  if (reply?.error) throw new Error(reply.error);
  return reply;
}
function showError(error) {
  stickyError = error.message;
  byId('connection').textContent = stickyError;
  byId('connection').classList.add('error');
}
function renderMessage(message) {
  const article = document.createElement('article');
  article.className = `message ${message.role}`;
  const name = document.createElement('div');
  name.className = 'who';
  name.textContent = message.role === 'user' ? 'You' : 'Doing';
  article.append(name);
  article.append(formatMessage(message.text));
  return article;
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const reply = await send({ type: 'panelStatus' });
    latest = reply;
    const state = reply.state;
    byId('reload').hidden = reply.protocol === 7;
    byId('allow').disabled = !!reply.connecting || !!state?.chatting || state?.phase === 'review' || reply.protocol !== 7;
    byId('connection').textContent =
      stickyError ||
      (reply.connecting
        ? reply.message
        : reply.connected
          ? state?.pageReady
            ? 'Allowed pages are ready.'
            : 'Reading your allowed pages…'
          : reply.message);
    byId('connection').classList.toggle('error', !!stickyError || /cannot reach|declined|expired|rejected/i.test(reply.message));
    const tabs = reply.allowedTabs || [];
    byId('tab-count').textContent = tabs.length;
    const nextTabs = JSON.stringify({ tabs, selected: reply.selectedTabId, busy: state?.chatting || state?.phase === 'review' });
    if (nextTabs !== tabKey) {
      tabKey = nextTabs;
      byId('tabs').replaceChildren();
      for (const tab of tabs) {
        const button = document.createElement('button');
        button.className = 'tab';
        button.title = tab.url;
        button.setAttribute('aria-pressed', String(tab.tabId === reply.selectedTabId));
        button.disabled = !!state?.chatting || state?.phase === 'review';
        const label = document.createElement('span');
        label.textContent = tab.title || new URL(tab.url).hostname;
        button.append(label);
        button.onclick = () => {
          stickyError = '';
          void send({ type: 'select', tabId: tab.tabId }).then(refresh).catch(showError);
        };
        const chip = document.createElement('div');
        chip.className = 'tab-chip';
        const remove = document.createElement('button');
        remove.className = 'remove-tab';
        remove.textContent = '×';
        remove.title = `Remove ${tab.title}`;
        remove.setAttribute('aria-label', `Remove tab ${tab.title}`);
        remove.onclick = () => {
          stickyError = '';
          void send({ type: 'remove-tab', tabId: tab.tabId }).then(refresh).catch(showError);
        };
        chip.append(button, remove);
        byId('tabs').append(chip);
      }
    }
    byId('group').hidden = tabs.length < 2;
    const messages = state?.messages || [];
    const nextMessages = JSON.stringify(messages);
    if (nextMessages !== messageKey) {
      const viewport = byId('conversation');
      const nearBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 90;
      messageKey = nextMessages;
      byId('messages').replaceChildren(...messages.map(renderMessage));
      byId('welcome').hidden = messages.length > 0;
      if (nearBottom || messages.at(-1)?.role === 'user') viewport.scrollTop = viewport.scrollHeight;
    }
    const working = !!state?.chatting;
    byId('progress').textContent = working
      ? state.phase === 'running'
        ? state.message
        : 'Thinking…'
      : state?.phase === 'review'
        ? 'Waiting for your go-ahead. Reply in chat.'
        : '';
    byId('stop-task').hidden = !working && state?.phase !== 'review';
    byId('send').hidden = working;
    byId('send').disabled = sending || !reply.connected || !state?.pageReady || !prompt.value.trim();
    prompt.disabled = working;
    byId('revoke').disabled = !reply.connected && !reply.connecting;
    byId('new-chat').disabled = !reply.connected;
  } catch (error) {
    showError(error);
  } finally {
    refreshing = false;
  }
}

byId('allow').addEventListener('click', async () => {
  byId('allow').disabled = true;
  stickyError = '';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url || !/^https?:/.test(tab.url)) throw new Error('Select the website tab you want Doing to use first.');
    // A side-panel button does not itself grant activeTab. Request only this site's host access.
    const origin = new URL(tab.url).origin + '/*';
    if (!(await chrome.permissions.request({ origins: [origin] })))
      throw new Error('Site permission was declined. Click Allow this tab when ready.');
    byId('connection').textContent = 'Connecting… Approve the first connection in Doing.';
    await send({ type: 'connect' });
  } catch (error) {
    showError(error);
  } finally {
    void refresh();
  }
});
byId('composer').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (sending || !prompt.value.trim() || latest?.state?.chatting) return;
  sending = true;
  stickyError = '';
  byId('send').disabled = true;
  const text = prompt.value.trim();
  try {
    await send({ type: 'chat', id: crypto.randomUUID(), text });
    prompt.value = '';
  } catch (error) {
    showError(error);
  } finally {
    sending = false;
    void refresh();
  }
});
prompt.addEventListener('input', () => {
  byId('send').disabled = !prompt.value.trim() || !latest?.connected || !latest?.state?.pageReady || sending;
  prompt.style.height = 'auto';
  prompt.style.height = Math.min(prompt.scrollHeight, 150) + 'px';
});
prompt.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    byId('composer').requestSubmit();
  }
});
for (const button of document.querySelectorAll('[data-prompt]'))
  button.addEventListener('click', () => {
    prompt.value = button.dataset.prompt;
    prompt.dispatchEvent(new Event('input'));
    prompt.focus();
  });
for (const [id, type] of [
  ['stop-task', 'chat-stop'],
  ['new-chat', 'chat-clear'],
  ['revoke', 'stop'],
  ['forget', 'forget'],
  ['group', 'group'],
])
  byId(id).addEventListener('click', () => {
    stickyError = '';
    void send({ type }).then(refresh).catch(showError);
  });
byId('reload').onclick = () => chrome.runtime.reload();
void refresh();
setInterval(() => void refresh(), 800);
