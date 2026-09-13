// Presentation only: keep host-owned error nodes and append-only history intact.
function createTurnErrorControls(root, options) {
    const key = 'dsh-tavern-hidden-errors:' + options.sessionId;
    let hidden = new Set();
    try {
        const stored = JSON.parse(options.storage.getItem(key) || '[]');
        if (Array.isArray(stored)) hidden = new Set(stored.filter(value => typeof value === 'string'));
    } catch (_) {}
    const owned = new Map();
    function save() {
        try { options.storage.setItem(key, JSON.stringify([...hidden])); } catch (_) {}
    }
    function remove(row, entry) {
        if (row.style.display === 'none') row.style.display = entry.display;
        entry.panel.remove();
    }
    function apply() {
        const rows = new Set(root.querySelectorAll('[data-chat-flow-kind="turn-error"]'));
        for (const [row, entry] of owned) if (!rows.has(row)) { remove(row, entry); owned.delete(row); }
        for (const row of rows) {
            const id = row.getAttribute('data-chat-turn') || row.getAttribute('data-chat-flow-key');
            if (!id) continue;
            let entry = owned.get(row);
            if (!entry) {
                if (row.hidden) continue;
                const panel = root.ownerDocument.createElement('div');
                panel.className = 'dsh-tavern-error-controls';
                const label = root.ownerDocument.createElement('span');
                const details = root.ownerDocument.createElement('button');
                const toggle = root.ownerDocument.createElement('button');
                details.type = toggle.type = 'button';
                panel.append(label, details, toggle);
                entry = { panel, label, details, toggle, display: row.style.display, expanded: false };
                owned.set(row, entry);
                details.onclick = function () { entry.expanded = !entry.expanded; apply(); };
                toggle.onclick = function () {
                    if (hidden.has(id)) hidden.delete(id); else hidden.add(id);
                    save(); apply();
                };
                row.insertAdjacentElement('afterend', panel);
            }
            const text = row.textContent || '';
            const long = text.length > 1000;
            const dismissed = hidden.has(id);
            const conceal = dismissed || (long && !entry.expanded);
            const display = conceal ? 'none' : entry.display;
            // Superseded-turn projection owns `hidden`; keep its errors hidden.
            if (!row.hidden && row.style.display !== display) row.style.display = display;
            if (entry.panel.hidden !== row.hidden) entry.panel.hidden = row.hidden;
            const summary = dismissed ? '错误提示已隐藏' : long
                ? (/message content cannot be empty/i.test(text) ? '模型接口错误：消息内容不能为空。' : '模型接口调用失败，已收起过长的错误信息。') : '';
            if (entry.label.textContent !== summary) entry.label.textContent = summary;
            if (entry.details.hidden !== (dismissed || !long)) entry.details.hidden = dismissed || !long;
            const detailText = entry.expanded ? '收起详情' : '显示原始错误';
            if (entry.details.textContent !== detailText) entry.details.textContent = detailText;
            const toggleText = dismissed ? '恢复错误提示' : '隐藏此错误';
            if (entry.toggle.textContent !== toggleText) entry.toggle.textContent = toggleText;
        }
    }
    return { apply, dispose() { for (const [row, entry] of owned) remove(row, entry); owned.clear(); } };
}
