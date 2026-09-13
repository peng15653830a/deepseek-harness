// The header counts session summaries; its popup reads the lazy catalog.
// Refresh an opened catalog when membership/activity changes in the summary feed.
function syncTavernSubagentCatalogs(sessions) {
  if (!sessions || !sessions.list || typeof sessions.refreshSubagents !== 'function') return function () {};
  const signatures = new Map();
  let disposed = false;
  function reconcile() {
    const snapshot = sessions.list.getSnapshot();
    const groups = new Map();
    for (const row of Object.values(snapshot.byId || {})) {
      if (row.origin !== 'subagent' || !row.parentId) continue;
      if (!groups.has(row.parentId)) groups.set(row.parentId, []);
      groups.get(row.parentId).push(row.id + ':' + String(row.running === true));
    }
    for (const [parentId, catalog] of Object.entries(snapshot.subagentsByParent || {})) {
      if (!catalog || catalog.state !== 'ready') continue;
      const signature = (groups.get(parentId) || []).sort().join('|');
      if (signatures.get(parentId) === signature) continue;
      signatures.set(parentId, signature);
      Promise.resolve().then(function () {
        if (!disposed) return sessions.refreshSubagents(parentId);
      }).catch(function (error) { console.warn('[DSH Tavern] 子代理目录刷新失败', error); });
    }
  }
  const stop = sessions.list.subscribe(reconcile);
  reconcile();
  return function () { disposed = true; stop(); };
}
