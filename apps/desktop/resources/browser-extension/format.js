function inline(parent, text) {
  for (const part of text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)) {
    const bold = part.startsWith('**') && part.endsWith('**');
    const code = part.startsWith('`') && part.endsWith('`');
    const node = document.createElement(bold ? 'strong' : code ? 'code' : 'span');
    node.textContent = bold ? part.slice(2, -2) : code ? part.slice(1, -1) : part;
    parent.append(node);
  }
}
/** Safe text formatting only: no model HTML, images, scripts or active URLs. */
export function formatMessage(text) {
  const body = document.createElement('div');
  body.className = 'message-body';
  const pieces = text.split(/```([\w+#-]*)\n([\s\S]*?)```/g);
  for (let i = 0; i < pieces.length; i += 3) {
    let list = null;
    for (const line of pieces[i].split('\n')) {
      if (!line.trim()) {
        list = null;
        continue;
      }
      const bullet = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
      if (bullet) {
        if (!list) {
          list = document.createElement('ul');
          body.append(list);
        }
        const item = document.createElement('li');
        inline(item, bullet[1]);
        list.append(item);
        continue;
      }
      list = null;
      const heading = /^#{1,4}\s+(.*)$/.exec(line);
      const p = document.createElement(heading ? 'h3' : 'p');
      inline(p, heading ? heading[1] : line);
      body.append(p);
    }
    if (i + 2 < pieces.length) {
      const block = document.createElement('section');
      block.className = 'code-block';
      const bar = document.createElement('div');
      bar.className = 'code-bar';
      const language = document.createElement('span');
      language.textContent = pieces[i + 1] || 'code';
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.textContent = 'Copy';
      copy.setAttribute('aria-label', 'Copy code');
      const code = pieces[i + 2];
      copy.onclick = async () => {
        try {
          await navigator.clipboard.writeText(code);
          copy.textContent = 'Copied';
        } catch {
          copy.textContent = 'Select to copy';
        }
      };
      bar.append(language, copy);
      const pre = document.createElement('pre');
      pre.textContent = code;
      block.append(bar, pre);
      body.append(block);
    }
  }
  return body;
}
