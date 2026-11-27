/** Injected only into the explicitly allowed tab. Never accepts code or selectors from the model. */
export function pageSnapshot() {
  const KEY = '__hiroraBrowserObservation';
  const previous = globalThis[KEY];
  const nodes = new Map();
  const elements = [];
  const radioGroups = new Map();
  const clean = (text, max = 600) =>
    String(text || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max);
  const shown = (el) => {
    const style = getComputedStyle(el);
    return (
      !el.closest('[hidden], [inert], [aria-hidden="true"]') &&
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      el.getClientRects().length > 0
    );
  };
  const blocked = (el) =>
    el.matches('input[type="password"], input[type="hidden"], input[type="file"]') ||
    /password|one-time-code|cc-|transaction/i.test(el.autocomplete || '') ||
    el.disabled ||
    el.readOnly;
  const label = (el) =>
    clean(
      [
        el.getAttribute('aria-label'),
        el
          .getAttribute('aria-labelledby')
          ?.split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent)
          .join(' '),
        el.labels
          ? Array.from(el.labels)
              .map((n) => n.innerText)
              .join(' ')
          : '',
        el.innerText,
        el.placeholder,
        el.title,
        el.name,
      ]
        .filter(Boolean)
        .join(' '),
    );
  const add = (el, kind, value = '') => {
    if (elements.length >= 180) return;
    const id = `e${elements.length + 1}`;
    const name = label(el) || (kind === 'code' ? 'Code editor' : kind);
    const advances =
      kind === 'link' ||
      (kind === 'button' &&
        (el.type === 'submit' ||
          el.closest('form') ||
          /\b(next|continue|submit|finish|complete|apply|send|confirm|save|done|start|begin)\b/i.test(name)));
    const item = { id, kind, label: name, value: String(value).slice(0, 12000), advances: !!advances };
    if (kind === 'radio' || kind === 'checkbox') item.checked = el.checked ?? el.getAttribute('aria-checked') === 'true';
    if (kind === 'radio' && el.matches('input[type="radio"]') && el.name) {
      const key = JSON.stringify([Array.from(document.forms).indexOf(el.form), el.name]);
      if (!radioGroups.has(key)) radioGroups.set(key, `g${radioGroups.size + 1}`);
      item.group = radioGroups.get(key);
    }
    if (kind === 'select')
      item.options = Array.from(el.options)
        .slice(0, 100)
        .map((o) => ({ value: o.value.slice(0, 300), label: clean(o.label, 300) }));
    nodes.set(id, { node: el, kind, label: name, advances: !!advances });
    elements.push(item);
  };
  const editors = Array.from(document.querySelectorAll('.monaco-editor, .cm-editor, .CodeMirror, .ace_editor')).filter(shown);
  for (const el of editors) {
    if (el.matches('.readonly, .cm-editor.cm-readonly') || el.getAttribute('aria-readonly') === 'true') continue;
    const text = Array.from(el.querySelectorAll('.view-line, .cm-line, .CodeMirror-line, .ace_line'))
      .map((n) => n.textContent)
      .join('\n');
    add(el, 'code', text);
  }
  for (const el of document.querySelectorAll(
    'input, textarea, select, button, a[href], [role="button"], [role="radio"], [role="checkbox"], [role="textbox"], [contenteditable="true"]',
  )) {
    if (!shown(el) || blocked(el) || editors.some((editor) => editor.contains(el))) continue;
    if (el.matches('a') && !/^https?:$/.test(new URL(el.href, location.href).protocol)) continue;
    if (el.matches('input[type="radio"], [role="radio"]')) add(el, 'radio');
    else if (el.matches('input[type="checkbox"], [role="checkbox"]')) add(el, 'checkbox');
    else if (el.matches('select')) add(el, 'select', el.value);
    else if (el.matches('button, input[type="submit"], input[type="button"], [role="button"]')) add(el, 'button');
    else if (el.matches('a')) add(el, 'link');
    else if (
      el.matches(
        'textarea, [contenteditable="true"], [role="textbox"], input:not([type]), input[type="text"], input[type="email"], input[type="tel"], input[type="number"], input[type="url"], input[type="search"]',
      )
    )
      add(el, 'text', el.value ?? el.innerText);
  }
  // innerText avoids script/style and hidden page instructions. Field values travel only in controls.
  const text = document.body.innerText.slice(0, 18000);
  const semantic = JSON.stringify({ url: location.href, text, elements });
  const sameNodes =
    previous && previous.nodes.size === nodes.size && Array.from(nodes).every(([id, v]) => previous.nodes.get(id)?.node === v.node);
  const revision = previous?.semantic === semantic && sameNodes ? previous.revision : crypto.randomUUID();
  globalThis[KEY] = { revision, semantic, nodes };
  return { revision, url: location.href, title: document.title.slice(0, 300), text, elements };
}

export function prepareAction(command) {
  const observation = globalThis.__hiroraBrowserObservation;
  if (location.origin !== command.origin || !observation || observation.revision !== command.revision)
    throw new Error('The page changed before the action.');
  const target = observation.nodes.get(command.action.target);
  if (!target?.node?.isConnected) throw new Error('The target is no longer available.');
  const el = target.node;
  if (el.disabled || el.readOnly || el.getAttribute('aria-disabled') === 'true') throw new Error('The control is disabled or read-only.');
  el.scrollIntoView({ block: 'center', inline: 'nearest' });
  if (command.action.kind === 'click') {
    if (!['button', 'link', 'radio', 'checkbox'].includes(target.kind)) throw new Error('Unsupported click target.');
    if (el.matches('a') && (new URL(el.href, location.href).origin !== location.origin || (el.target && el.target !== '_self')))
      throw new Error('This link leaves the authorized tab or site.');
    el.click();
    return { typing: false };
  }
  if (command.action.kind === 'select') {
    if (target.kind !== 'select' || !Array.from(el.options).some((o) => o.value === command.action.value))
      throw new Error('Option no longer available.');
    el.value = command.action.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { typing: false };
  }
  if (command.action.kind !== 'type' || !['text', 'code'].includes(target.kind)) throw new Error('Unsupported action.');
  // Current Monaco uses EditContext on a focusable DIV. Its IME textarea is read-only;
  // older Monaco uses inputarea, while CodeMirror/Ace use contenteditable/textarea.
  const focus =
    target.kind === 'code'
      ? el.querySelector('.native-edit-context, textarea.inputarea, textarea.ace_text-input, .cm-content[contenteditable="true"]') ||
        el.querySelector('[contenteditable="true"], textarea:not([readonly]), input:not([readonly])')
      : el;
  if (!focus || focus.disabled || focus.readOnly) throw new Error('This editor cannot receive typing.');
  focus.focus();
  if (document.activeElement !== focus) throw new Error('Could not focus the requested editor.');
  // Selection is restricted to this editable field; never send Ctrl+A to the whole page.
  if (focus instanceof HTMLInputElement || focus instanceof HTMLTextAreaElement) focus.select();
  else {
    const range = document.createRange();
    range.selectNodeContents(focus);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }
  return { typing: true, code: target.kind === 'code' };
}

export function verifyFocus(command) {
  const o = globalThis.__hiroraBrowserObservation;
  const target = o?.nodes.get(command.action.target)?.node;
  return (
    location.origin === command.origin &&
    o?.revision === command.revision &&
    !!target &&
    (target === document.activeElement || target.contains(document.activeElement))
  );
}

/** Keep editor auto-closing/auto-indent from rewriting a complete solution during text input. */
export function setEditorComposition(command, active) {
  const observation = globalThis.__hiroraBrowserObservation;
  const root = observation?.nodes.get(command.action.target)?.node;
  const focus = document.activeElement;
  if (location.origin !== command.origin || !root || !focus || !(root === focus || root.contains(focus))) return false;
  const target = focus.editContext || focus;
  target.dispatchEvent(
    new CompositionEvent(active ? 'compositionstart' : 'compositionend', { bubbles: true, data: active ? '' : command.action.text }),
  );
  return true;
}
