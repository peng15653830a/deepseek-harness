// A disposable editor frame: template code is text, never evaluated here.
function EjsCodeEditor({ value, title, onApply, onClose, applyHint }) {
  const h = React.createElement;
  const dialogRef = React.useRef(null), frameRef = React.useRef(null);
  const [ready, setReady] = React.useState(false), [error, setError] = React.useState('');
  const applyRef = React.useRef(onApply); applyRef.current = onApply;
  React.useEffect(() => {
    let active = true;
    const dialog = dialogRef.current, frame = frameRef.current, previous = document.activeElement;
    const nonce = 'editor-' + Date.now() + '-' + Math.random();
    function receive(event) {
      if (!active || event.source !== frame.contentWindow || event.data?.nonce !== nonce) return;
      if (event.data.type === 'ready') setReady(true);
      if (event.data.type === 'error') setError(String(event.data.message));
      if (event.data.type === 'value' && typeof event.data.value === 'string') applyRef.current(event.data.value);
    }
    window.addEventListener('message', receive);
    dialog.showModal();
    rpc('getEjsEditorInfo').then(info => {
      if (!active) return;
      const url = new URL(info.entryUrl, window.location.origin).href;
      const background = getComputedStyle(document.body).backgroundColor;
      const channels = background.match(/\d+/g) || [];
      const dark = channels.length >= 3 && channels.slice(0, 3).reduce((sum, n) => sum + Number(n), 0) < 384;
      frame.onload = () => { if (active) frame.contentWindow.postMessage({ type: 'init', nonce, value, dark }, '*'); };
      frame.srcdoc = `<!doctype html><html><head><style>html,body,#editor{height:100%;margin:0;overflow:hidden}</style></head><body><div id="editor"></div><script type="module">
        let editor, nonce;
        const send = data => parent.postMessage({...data, nonce}, '*');
        addEventListener('message', async event => {
          if (event.source !== parent) return;
          if (event.data.type === 'init' && !nonce) {
            nonce = event.data.nonce;
            try {
              const module = await import(${JSON.stringify(url)});
              editor = await module.createEjsCodeEditor(document.getElementById('editor'), event.data);
              editor.focus(); send({type:'ready'});
            } catch(error) { send({type:'error',message:String(error.message || error)}); }
          } else if (event.data.type === 'read' && event.data.nonce === nonce && editor) send({type:'value',value:editor.getValue()});
        });
        addEventListener('pagehide', () => editor?.dispose());
      <\/script></body></html>`;
      frame.dataset.nonce = nonce;
    }).catch(err => { if (active) setError(String(err.message || err)); });
    return () => { active = false; window.removeEventListener('message', receive); frame.onload = null; dialog.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  return h('dialog', { ref: dialogRef, className: 'dsh-ejs-editor', 'aria-label': 'EJS 代码编辑器', onCancel: event => { event.preventDefault(); event.stopPropagation(); onClose(); } },
    h('div', { className: 'dsh-ejs-editor-head' }, h('div', null, h('h2', null, 'EJS 代码编辑'), h('p', null, title || '世界书条目')), h('button', { type: 'button', className: 'dsh-tavern-btn', onClick: onClose }, '取消')),
    h('iframe', { ref: frameRef, title: 'EJS 模板代码', sandbox: 'allow-scripts allow-same-origin' }),
    h('div', { className: 'dsh-ejs-editor-footer' }, h('span', { role: error ? 'alert' : 'status' }, error || (ready ? (applyHint || '应用后写回条目草稿；保存世界书后生效。') : '正在加载代码编辑器…')),
      h('button', { type: 'button', className: 'dsh-tavern-btn', disabled: !ready || Boolean(error), onClick: () => frameRef.current.contentWindow.postMessage({ type: 'read', nonce: frameRef.current.dataset.nonce }, '*') }, '应用到条目')));
}
