// Bound initial story rendering independently of host child-slot ownership.
// Only explicit input expands history; canonical records are never changed.
function createTavernHistoryViewport(initialLimit = 20) {
    const entries = new Map(), listeners = new Set(), limits = new Map();
    let snapshot = new Set();
    function publish(next, force = false) {
        if (!force && next.size === snapshot.size && [...next].every(key => snapshot.has(key))) return;
        const previous = snapshot;
        snapshot = new Set(next);
        for (const key of previous) if (!next.has(key)) entries.get(key)?.release();
        listeners.forEach(fn => fn());
    }
    function ordered(sessionId) {
        return [...entries.values()].filter(item => item.sessionId === sessionId).sort((a, b) => a.turn - b.turn);
    }
    function select(sessionId) {
        const rows = ordered(sessionId);
        publish(new Set(rows.slice(-(limits.get(sessionId) || initialLimit)).map(item => item.key)), true);
    }
    return {
        subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
        snapshot() { return snapshot; },
        register(sessionId, turn, release) {
            const key = JSON.stringify([sessionId, turn]);
            let item = entries.get(key);
            const added = !item;
            const newest = ordered(sessionId).at(-1);
            if (added && limits.has(sessionId) && newest && turn > newest.turn) limits.set(sessionId, limits.get(sessionId) + 1);
            if (!item) { item = { key, sessionId, turn, release, mounts: 0 }; entries.set(key, item); }
            item.mounts++;
            if (added) select(sessionId);
            return () => {
                if (--item.mounts > 0) return;
                item.release();
                entries.delete(key);
                if (!ordered(sessionId).length) limits.delete(sessionId);
                publish(new Set([...snapshot].filter(k => k !== key)));
            };
        },
        more(sessionId) {
            limits.set(sessionId, (limits.get(sessionId) || initialLimit) + initialLimit);
            select(sessionId);
        },
        hasEarlier(sessionId, turn) {
            const rows = ordered(sessionId), selected = rows.filter(item => snapshot.has(item.key));
            return selected[0]?.turn === turn && rows[0]?.turn < turn;
        },
        key(sessionId, turn) { return JSON.stringify([sessionId, turn]); }
    };
}
const tavernHistoryViewport = createTavernHistoryViewport();

function TavernWindowedNode(props) {
    const ref = React.useRef(null);
    const turn = Number(props.node.location?.turn?.turn || 0);
    const key = tavernHistoryViewport.key(props.sessionId, turn);
    const active = React.useSyncExternalStore(tavernHistoryViewport.subscribe, tavernHistoryViewport.snapshot).has(key);
    React.useLayoutEffect(() => tavernHistoryViewport.register(props.sessionId, turn, () => {
        tavernRetainedFrames.invalidateOwner(key);
    }), [key]);
    const earlier = props.node.kind !== "user" && tavernHistoryViewport.hasEarlier(props.sessionId, turn);
    function more() {
        const node = ref.current, top = node?.getBoundingClientRect().top;
        const scroller = node?.closest("[data-conversation-scroll]");
        tavernHistoryViewport.more(props.sessionId);
        // Keep the previously visible round anchored while older bodies mount.
        requestAnimationFrame(() => {
            if (node?.isConnected && scroller) scroller.scrollTop += node.getBoundingClientRect().top - top;
        });
    }
    return React.createElement("div", { ref, "data-tavern-history-turn": turn, hidden: !active },
        active ? React.createElement(React.Fragment, null,
            earlier ? React.createElement("div", { className: "dsh-tavern-history-controls" },
                React.createElement("button", { type: "button", className: "dsh-tavern-btn", onClick: more }, "加载更多（20 轮）")) : null,
            React.createElement(props.bodyComponent, { ...props, frameOwner: key })
        ) : null);
}
