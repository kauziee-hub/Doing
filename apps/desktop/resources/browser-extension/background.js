import { pageSnapshot, prepareAction, verifyFocus, setEditorComposition } from './page.js';

let session = null;
let pumping = false;
let generation = 0;
let attachedTab = null;
let restoring = true;
let connecting = false;
let changingTabs = false;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(path, body, current = session) {
  if (!current) throw new Error('Allow a tab first.');
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${current.port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${current.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(110000),
    });
  } catch {
    throw new Error('Cannot reach Doing. Open the Doing app and enable Browser assistant, then click Allow this tab again.');
  }
  if (!res.ok) {
    const error = new Error('Doing rejected the connection. Reconnect and approve it in Doing.');
    error.status = res.status;
    throw error;
  }
  return res.json();
}

async function rememberedConnection(port, force = false, expectedGeneration = generation) {
  const stored = (await chrome.storage.local.get('trustedHirora')).trustedHirora;
  if (!force && stored?.port === port && /^[a-f0-9]{48}$/.test(stored.token)) return stored;
  const token = Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, '0')).join('');
  const candidate = { token, port };
  const pending = await request('/pair/request', { label: 'Doing Browser Companion' }, candidate);
  await chrome.storage.session.set({ message: 'Approve the browser connection in Doing. No pairing code needed.' });
  await badge('ASK');
  for (let i = 0; i < 115; i++) {
    await sleep(1000);
    if (generation !== expectedGeneration) throw new Error('Tab permission canceled.');
    const reply = await request('/pair/status', { requestId: pending.requestId }, candidate);
    if (reply.state === 'denied') throw new Error('Connection declined in Doing.');
    if (reply.state === 'approved') {
      await chrome.storage.local.set({ trustedHirora: candidate });
      return candidate;
    }
  }
  throw new Error('Connection approval expired. Click Allow this tab again.');
}

async function badge(text) {
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: text === 'RUN' ? '#28785b' : '#1d1c35' });
}

async function detach() {
  const id = attachedTab;
  attachedTab = null;
  if (id !== null) await chrome.debugger.detach({ tabId: id }).catch(() => {});
}

async function stop(message = 'Tab access revoked by you.') {
  const old = session;
  session = null;
  generation++;
  await chrome.storage.session.remove('connection');
  await detach();
  await badge('');
  if (old) await request('/disconnect', { clientId: old.clientId }, old).catch(() => {});
  await chrome.storage.session.set({ message });
}

async function observe(current) {
  const tab = await chrome.tabs.get(current.tabId);
  if (new URL(tab.url).origin !== current.origin) throw new Error('The tab moved to a different site. Allow it again to continue.');
  if (tab.status !== 'complete') return null;
  const [result] = await chrome.scripting.executeScript({ target: { tabId: current.tabId }, func: pageSnapshot });
  if (!result?.result) throw new Error('The page could not be read.');
  const tabs = [];
  for (const allowed of current.allowedTabs || []) {
    if (allowed.tabId === current.tabId) {
      tabs.push({ id: String(allowed.tabId), url: result.result.url, title: result.result.title, text: result.result.text.slice(0, 2500) });
      continue;
    }
    const other = await chrome.tabs.get(allowed.tabId);
    if (new URL(other.url).origin !== allowed.origin) throw new Error('An allowed tab changed sites. Allow the group again.');
    if (other.status !== 'complete') continue;
    const [read] = await chrome.scripting.executeScript({ target: { tabId: allowed.tabId }, func: pageSnapshot });
    if (read?.result)
      tabs.push({ id: String(allowed.tabId), url: read.result.url, title: read.result.title, text: read.result.text.slice(0, 2500) });
  }
  return { ...result.result, tabId: String(current.tabId), tabs };
}

async function removeTab(tabId, message = 'Tab access removed.') {
  const current = session;
  if (!current?.allowedTabs?.some((tab) => tab.tabId === tabId)) return;
  generation++;
  changingTabs = true;
  current.allowedTabs = current.allowedTabs.filter((tab) => tab.tabId !== tabId);
  try {
    if (current.tabId === tabId && current.allowedTabs.length) {
      current.tabId = current.allowedTabs[0].tabId;
      current.origin = current.allowedTabs[0].origin;
      await detach();
    }
    await request('/tabs/remove', { clientId: current.clientId, id: String(tabId) }, current);
    if (session !== current) return;
    if (!current.allowedTabs.length) {
      await stop(message);
      return;
    }
    await chrome.storage.session.set({ connection: current, message });
  } finally {
    changingTabs = false;
    if (!pumping && session) void pump();
  }
}

async function execute(current, command, mine) {
  const valid = () => session === current && generation === mine;
  if (!valid() || command.origin !== current.origin || !['click', 'type', 'select', 'switch'].includes(command.action.kind))
    throw new Error('Action permission revoked.');
  // Re-observe after model latency; IDs from a stale page must never reach a different question.
  const fresh = await observe(current);
  if (!fresh || fresh.revision !== command.revision)
    throw new Error('The page changed while Doing was thinking. Restart from the current page.');
  const permit = await request('/permit', { clientId: current.clientId, runId: command.runId, commandId: command.id }, current);
  if (!valid() || !permit.allowed) throw new Error('Action permission revoked.');
  if (command.action.kind === 'switch') {
    const allowed = current.allowedTabs?.find((t) => String(t.tabId) === command.action.tab);
    if (!allowed) throw new Error('That tab was not allowed by you.');
    const destination = await chrome.tabs.get(allowed.tabId);
    if (new URL(destination.url).origin !== allowed.origin) throw new Error('The destination tab changed sites.');
    await chrome.tabs.update(allowed.tabId, { active: true });
    if (!valid()) throw new Error('Action permission revoked.');
    current.tabId = allowed.tabId;
    current.origin = allowed.origin;
    await chrome.storage.session.set({ connection: current });
    return;
  }
  if (command.action.kind === 'type') {
    await chrome.debugger.attach({ tabId: current.tabId }, '1.3');
    attachedTab = current.tabId;
  }
  try {
    if (!valid()) throw new Error('Action permission revoked.');
    const [prepared] = await chrome.scripting.executeScript({ target: { tabId: current.tabId }, func: prepareAction, args: [command] });
    // An injected function can fail without rejecting executeScript in some Chromium builds.
    if (!prepared?.result || typeof prepared.result.typing !== 'boolean')
      throw new Error('The page could not prepare this control for the requested action.');
    if (prepared.result.typing) {
      const [focus] = await chrome.scripting.executeScript({ target: { tabId: current.tabId }, func: verifyFocus, args: [command] });
      if (!valid() || !focus?.result) throw new Error('The editor lost focus.');
      if (prepared.result.code) {
        // Monaco/CodeMirror/Ace own their document selection; Ctrl+A stays inside the verified editor.
        await chrome.debugger.sendCommand({ tabId: current.tabId }, 'Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: 'a',
          code: 'KeyA',
          windowsVirtualKeyCode: 65,
          modifiers: 2,
        });
        await chrome.debugger.sendCommand({ tabId: current.tabId }, 'Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: 'a',
          code: 'KeyA',
          windowsVirtualKeyCode: 65,
          modifiers: 2,
        });
      }
      if (!valid()) throw new Error('Action permission revoked.');
      if (prepared.result.code) {
        const [composition] = await chrome.scripting.executeScript({
          target: { tabId: current.tabId },
          func: setEditorComposition,
          args: [command, true],
        });
        if (!composition?.result) throw new Error('Could not prepare code input.');
      }
      try {
        await chrome.debugger.sendCommand({ tabId: current.tabId }, 'Input.insertText', { text: command.action.text });
      } finally {
        if (prepared.result.code)
          await chrome.scripting
            .executeScript({ target: { tabId: current.tabId }, func: setEditorComposition, args: [command, false] })
            .catch(() => {});
      }
      await sleep(150);
      const after = await observe(current);
      const entered = after?.elements.find((el) => el.id === command.action.target);
      const before = fresh.elements.find((el) => el.id === command.action.target);
      if (!entered || (entered.value === before?.value && entered.value !== command.action.text))
        throw new Error('The editor did not accept the typed text. No success was recorded.');
      if (entered.kind === 'text' && entered.value !== command.action.text)
        throw new Error('The field did not retain the requested text. Check it before continuing.');
      const canonical = (text) =>
        text
          .replace(/\r\n/g, '\n')
          .replace(/\u00a0/g, ' ')
          .trim();
      if (entered.kind === 'code' && canonical(entered.value) !== canonical(command.action.text))
        throw new Error(
          'The visible code differs from the requested solution. The editor may have reformatted it or only part is visible; review it before continuing.',
        );
    }
  } finally {
    await detach();
  }
}

async function pump() {
  if (pumping || !session || changingTabs) return;
  pumping = true;
  const current = session;
  const mine = generation;
  let receipt;
  let snapshot;
  try {
    while (session === current && generation === mine) {
      const reply = await request('/tick', { clientId: current.clientId, receipt, snapshot }, current);
      if (session !== current || generation !== mine) break;
      receipt = undefined;
      snapshot = undefined;
      await chrome.storage.session.set({
        message:
          reply.phase === 'running'
            ? 'Working in the allowed tab. Stop: Ctrl+Shift+Y.'
            : reply.phase === 'review'
              ? 'Waiting for your approval in Doing.'
              : 'Tab allowed. Ask about this page or start a task in Doing.',
      });
      await badge(reply.phase === 'running' ? 'RUN' : reply.phase === 'review' ? 'ASK' : 'ON');
      if (reply.command) {
        try {
          await execute(current, reply.command, mine);
          receipt = { id: reply.command.id, ok: true, message: 'Browser action dispatched.' };
        } catch (error) {
          receipt = { id: reply.command.id, ok: false, message: String(error.message).slice(0, 500) };
        }
        await sleep(700);
      } else await sleep(reply.observe && reply.phase === 'running' ? 400 : 1000);
      if (session !== current || generation !== mine) break;
      if (reply.observe) snapshot = await observe(current);
      // Null means navigation is still loading. Poll without fabricating an observation.
      if (!snapshot) snapshot = undefined;
    }
  } catch (error) {
    if (session === current && generation === mine) await stop(`${error.message} Reconnect the tab to continue.`);
  } finally {
    pumping = false;
    if (session && generation !== mine) void pump();
  }
}

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  void (async () => {
    if (restoring) throw new Error('Browser companion is starting. Try again in a moment.');
    if (message.type === 'status' || message.type === 'panelStatus')
      return {
        protocol: 5,
        connected: !!session,
        connecting,
        remembered: !!(await chrome.storage.local.get('trustedHirora')).trustedHirora,
        message: (await chrome.storage.session.get('message')).message || 'No tab shared.',
        selectedTabId: session?.tabId,
        allowedTabs: session?.allowedTabs || [],
        state: message.type === 'panelStatus' && session ? await request('/chat/status', { clientId: session.clientId }) : null,
      };
    if (message.type === 'stop') {
      await stop();
      return { connected: false, message: 'Tab access revoked by you.' };
    }
    if (message.type === 'forget') {
      await stop();
      await chrome.storage.local.remove('trustedHirora');
      return { connected: false, message: 'Connection forgotten. Approval will be requested next time.' };
    }
    if (message.type === 'remove-tab') {
      await removeTab(message.tabId);
      return { message: 'Tab access removed.' };
    }
    if (message.type === 'chat' || message.type === 'chat-stop' || message.type === 'chat-clear') {
      const path = message.type === 'chat' ? '/chat/send' : message.type === 'chat-stop' ? '/chat/stop' : '/chat/clear';
      const state = await request(path, { clientId: session?.clientId, id: message.id, text: message.text });
      return { state, message: state.message };
    }
    if (message.type === 'select') {
      const allowed = session?.allowedTabs?.find((t) => t.tabId === message.tabId);
      if (!allowed) throw new Error('Allow that tab first.');
      const tab = await chrome.tabs.get(allowed.tabId);
      if (new URL(tab.url).origin !== allowed.origin) throw new Error('That tab changed sites.');
      await request('/tabs/select', {
        clientId: session.clientId,
        tab: { id: String(tab.id), title: tab.title.slice(0, 300), url: tab.url },
      });
      session.tabId = tab.id;
      session.origin = allowed.origin;
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.storage.session.set({ connection: session });
      return { message: `Selected ${tab.title}` };
    }
    if (message.type === 'group') {
      if (!session?.allowedTabs?.length) throw new Error('Allow tabs first.');
      const groupId = await chrome.tabs.group({ tabIds: session.allowedTabs.map((t) => t.tabId) });
      await chrome.tabGroups.update(groupId, { title: 'Doing', color: 'purple' });
      return { message: 'Allowed tabs grouped in Chrome.' };
    }
    if (message.type !== 'connect') throw new Error('Unknown command.');
    if (connecting) throw new Error('Approve the pending connection in Doing.');
    const port = message.port ?? 19389;
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local connection port.');
    connecting = true;
    let connectGeneration = generation;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id || !/^https?:/.test(tab.url || '')) throw new Error('Open the website you want Doing to use first.');
      const allowed = { tabId: tab.id, origin: new URL(tab.url).origin, title: (tab.title || '').slice(0, 300), url: tab.url };
      // Verify Chrome's tab/site permission before approving any page observation.
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => true });
      if (session) {
        await request('/tabs/allow', { clientId: session.clientId, tab: { id: String(tab.id), title: allowed.title, url: tab.url } });
        session.allowedTabs = [...(session.allowedTabs || []).filter((t) => t.tabId !== tab.id), allowed];
        session.tabId = tab.id;
        session.origin = allowed.origin;
        await chrome.storage.session.set({ connection: session, message: 'Tab added. Chat with Doing in the side panel.' });
        return { connected: true, message: 'Tab added. Chat with Doing in the side panel.' };
      }
      await stop('Connecting to Doing…');
      connectGeneration = generation;
      // Legacy manual pairing is accepted for older callers; the popup never asks for a code.
      let credential = /^[a-f0-9]{48}$/.test(message.token)
        ? { token: message.token, port }
        : await rememberedConnection(port, false, connectGeneration);
      if (generation !== connectGeneration) throw new Error('Tab permission canceled.');
      const latest = await chrome.tabs.get(tab.id);
      if (new URL(latest.url).origin !== new URL(tab.url).origin) throw new Error('The tab changed sites. Allow it again.');
      let paired;
      try {
        paired = await request('/connect', { id: String(tab.id), url: latest.url, title: (latest.title || '').slice(0, 300) }, credential);
      } catch (error) {
        if (![401, 403].includes(error.status) || message.token) throw error;
        await chrome.storage.local.remove('trustedHirora');
        credential = await rememberedConnection(port, true, connectGeneration);
        if (generation !== connectGeneration) throw new Error('Tab permission canceled.', { cause: error });
        paired = await request('/connect', { id: String(tab.id), url: latest.url, title: (latest.title || '').slice(0, 300) }, credential);
      }
      if (generation !== connectGeneration) {
        await request('/disconnect', { clientId: paired.clientId }, credential).catch(() => {});
        throw new Error('Tab permission canceled.');
      }
      const next = { ...credential, tabId: tab.id, origin: new URL(latest.url).origin };
      session = { ...next, clientId: paired.clientId, allowedTabs: [allowed] };
      await chrome.storage.session.set({ connection: session, message: 'Tab allowed. Chat with Doing in the side panel.' });
      await badge('ON');
      void pump();
      return { connected: true, message: 'Tab allowed. Chat with Doing in the side panel.' };
    } catch (error) {
      if (generation === connectGeneration) {
        await badge('');
        await chrome.storage.session.set({ message: error.message });
      }
      throw error;
    } finally {
      connecting = false;
    }
  })().then(respond, (error) => respond({ error: error.message }));
  return true;
});
chrome.commands.onCommand.addListener((command) => {
  if (command === 'stop') void stop();
});
chrome.tabs.onRemoved.addListener((id) => {
  if (session?.allowedTabs?.some((t) => t.tabId === id))
    void removeTab(id, 'Tab closed. Remaining tabs are still allowed.').catch(() => stop('Reconnect the remaining tabs.'));
});
chrome.tabs.onUpdated.addListener((id, change) => {
  const allowed = session?.allowedTabs?.find((t) => t.tabId === id);
  if (allowed && change.url && new URL(change.url).origin !== allowed.origin)
    void removeTab(id, 'Tab changed sites. Allow it again to share the new site.').catch(() => stop('Reconnect the remaining tabs.'));
});
chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId === attachedTab) {
    attachedTab = null;
    if (reason === 'canceled_by_user') void stop('Browser control canceled by you.');
  }
});
// A service-worker restart cannot replay a pending action or silently restore consent.
void (async () => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  const { connection } = await chrome.storage.session.get('connection');
  if (connection) await request('/disconnect', { clientId: connection.clientId }, connection).catch(() => {});
  await chrome.storage.session.remove('connection');
  await chrome.storage.session.set({ message: 'No tab shared.' });
  await badge('');
  restoring = false;
})();
