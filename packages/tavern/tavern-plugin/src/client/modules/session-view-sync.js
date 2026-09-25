// Cached session views are immutable, like the React views returned by getSession.
function createSessionViewReader(maxSessions = 4) {
  const sessions = new Map();
  let sequence = 0;
  return function begin(sessionId) {
    const base = sessions.get(sessionId);
    const requestSequence = ++sequence;
    return {
      cursor: base && base.cursor,
      accept(result) {
        let view = result.view;
        if (result.viewDelta) {
          if (!base || result.viewDelta.baseCursor !== base.cursor) throw new Error("会话增量已过期，请重新读取");
          view = Object.assign({}, base.view);
          const copied = new Set();
          function parent(path) {
            let target = view;
            for (let i = 0; i < path.length - 1; i++) {
              const key = path[i];
              const id = JSON.stringify(path.slice(0, i + 1));
              if (!copied.has(id)) {
                const old = target[key];
                target[key] = Array.isArray(old) ? old.slice() : (path[i + 1] === "length" || typeof path[i + 1] === "number" ? [] : Object.assign({}, old));
                copied.add(id);
              }
              target = target[key];
            }
            return target;
          }
          // Remove old descendants before replacing a parent with null or a new object.
          for (const path of result.viewDelta.remove.slice().sort((a, b) => b.length - a.length)) {
            const target = parent(path), key = path[path.length - 1];
            if (!(Array.isArray(target) && key === "length")) delete target[key];
          }
          for (const [path, value] of result.viewDelta.set) parent(path)[path[path.length - 1]] = value;
        }
        const latest = sessions.get(sessionId);
        if (!latest || latest.sequence < requestSequence) {
          sessions.delete(sessionId);
          sessions.set(sessionId, { view, cursor: result.viewCursor, sequence: requestSequence });
          while (sessions.size > maxSessions) sessions.delete(sessions.keys().next().value);
        }
        return Object.assign({}, result, { view });
      }
    };
  };
}
