// Player-only notebook. No prompt construction or model access in this view.
function TavernLedger(props) {
  const h = React.createElement;
  const ledger = props.ledger || { items: [], npcs: [], scenes: [], itemLog: [], locationPath: [], updatedTurn: null };
  const [open, setOpen] = React.useState(true);
  const [tab, setTab] = React.useState("items");
  const [editing, setEditing] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const blocked = busy || props.busy;
  const labels = { name: "名称", qty: "数量", desc: "描述", carried: "随身携带", location: "所在地", gender: "性别", age: "年龄", title: "身份", relation: "与玩家的关系", ties: "与其他角色的关系", personality: "性格", outfit: "当前穿着", condition: "当前状态", important: "主要角色", follow: "随行", path: "地点路径（用 / 分隔）" };
  const fields = { items: ["name", "qty", "desc", "carried", "location"], npcs: ["name", "title", "relation", "ties", "gender", "age", "desc", "personality", "outfit", "condition", "important", "follow", "location"], scenes: ["path", "desc"] };
  function begin(row) {
    const draft = {};
    fields[tab].forEach(function (key) { draft[key] = key === "path" ? (row?.path || []).join(" / ") : (row?.[key] ?? (["carried", "important", "follow"].includes(key) ? key === "carried" : "")); });
    setEditing({ original: row, draft: draft, expected: JSON.stringify(ledger), kind: tab }); setError("");
  }
  async function submit(delta, expected) {
    if (blocked) return;
    setBusy(true); setError("");
    try {
      const result = await rpc("editLedger", { sessionId: props.sessionId, expected: expected, delta: delta });
      liveTavernView.setView(props.sessionId, result.view);
      setEditing(null);
    } catch (e) { setError(String(e.message || e)); }
    finally { setBusy(false); }
  }
  function save() {
    const e = editing, item = {};
    fields[e.kind].forEach(function (key) {
      const value = e.draft[key];
      if (key === "path") item.path = value.split("/").map(v => v.trim());
      else if (key === "qty") { if (String(value).trim() !== "") item.qty = Number(value); }
      else item[key] = value;
    });
    let ops;
    if (e.original && e.kind === "scenes") {
      ops = { reparent: [{ node: e.original.path, newPath: item.path }], update: [{ path: e.original.path, desc: item.desc }] };
    } else if (e.original && item.name.trim().toLowerCase() !== e.original.name.trim().toLowerCase()) {
      ops = { remove: [e.original.name], add: [item] };
    } else ops = { [e.original ? "update" : "add"]: [item] };
    void submit({ [e.kind]: ops }, e.expected);
  }
  function remove(row) {
    if (!window.confirm(tab === "scenes" ? "删除这个地点及其下属地点？" : "删除这条台账记录？")) return;
    void submit({ [tab]: { remove: [tab === "scenes" ? row.path : row.name] } }, JSON.stringify(ledger));
  }
  function actions(row) { return h("span", { className: "dsh-ledger-actions" },
    h("button", { type: "button", disabled: blocked, onClick: () => begin(row), "aria-label": "编辑" + (row.name || row.path.join(" / ")) }, "编辑"),
    h("button", { type: "button", disabled: blocked, onClick: () => remove(row), "aria-label": "删除" + (row.name || row.path.join(" / ")) }, "删除")); }
  function card(row, group) {
    const subtitle = tab === "items" ? (row.carried === false ? "寄存：" + (row.location || "地点不明") : "随身") : (row.follow ? "随行" : row.location || "所在地不明");
    return h("article", { key: row.name, className: "dsh-ledger-card" },
      h("div", { className: "dsh-ledger-card-head" }, h("strong", null, row.name + (tab === "items" && typeof row.qty === "number" ? " ×" + row.qty : "")), actions(row)),
      h("small", null, subtitle),
      (tab === "items" ? ["desc"] : group === "不在场" ? ["title", "relation"] : ["title", "relation", "ties", "outfit", "condition", "desc", "personality"]).map(function (key) {
        return row[key] ? h("p", { key: key }, h("span", { className: "dsh-ledger-field-label" }, labels[key] + "："), row[key]) : null;
      }));
  }
  function npcGroup(row) {
    if (row.important) return "主要角色";
    if (row.follow || (row.location && row.location === ledger.location)) return "在场";
    const route = ledger.locationPath || [];
    if (row.location && route.at(-1) === row.location) return "在场";
    if (row.location && route.slice(0, -1).includes(row.location)) return "同区域";
    return "不在场";
  }
  function sceneTree(prefix) {
    const children = new Map();
    ledger.scenes.forEach(function (row) {
      if (row.path.length <= prefix.length || !prefix.every((p, i) => p === row.path[i])) return;
      const name = row.path[prefix.length];
      if (!children.has(name)) children.set(name, [...prefix, name]);
    });
    return Array.from(children, function ([name, path]) {
      const row = ledger.scenes.find(r => JSON.stringify(r.path) === JSON.stringify(path));
      const current = JSON.stringify(ledger.locationPath) === JSON.stringify(path);
      const items = ledger.items.filter(r => r.carried === false && (r.location === name || r.location === path.join(" / ")));
      return h("details", { key: name, open: true, className: "dsh-ledger-scene" },
        h("summary", null, name, current ? h("small", null, " · 所在") : null),
        row ? h("div", { className: "dsh-ledger-scene-content" }, h("p", null, row.desc), actions(row)) : null,
        items.length ? h("small", null, "寄存：" + items.map(i => i.name + (i.qty === undefined ? "" : " ×" + i.qty)).join("、")) : null,
        sceneTree(path));
    });
  }
  return h("section", { className: "dsh-tavern-status-section dsh-ledger", "aria-label": "游玩台账" },
    h("button", { type: "button", className: "dsh-ledger-toggle", "aria-expanded": open, onClick: () => setOpen(!open) }, "游玩台账", h("span", null, open ? "收起" : "查看")),
    open ? h("div", null,
      h("p", { className: "dsh-tavern-status-empty" }, "玩家备忘录，不发送给前台 AI。" + (ledger.updatedTurn === null ? "暂无后台整理记录，可手动添加。" : "整理至第 " + ledger.updatedTurn + " 轮。")),
      ledger.location ? h("p", null, "当前地点：" + ledger.location) : null,
      h("div", { className: "dsh-ledger-tabs", role: "tablist", "aria-label": "台账分类" }, [["items", "物品"], ["npcs", "角色"], ["scenes", "地点"]].map(function ([id, label]) {
        return h("button", { key: id, type: "button", role: "tab", "aria-selected": tab === id, onClick: () => { setTab(id); setEditing(null); setError(""); } }, label, h("span", { className: "dsh-ledger-count" }, ledger[id].length));
      })),
      h("button", { type: "button", className: "dsh-ledger-add", disabled: blocked, onClick: () => begin(null) }, "＋ 添加记录"),
      error ? h("p", { className: "dsh-card-error", role: "alert" }, error) : null,
      editing ? h("form", { className: "dsh-ledger-form", onSubmit: e => { e.preventDefault(); save(); } },
        fields[editing.kind].map(function (key) {
          const bool = ["carried", "important", "follow"].includes(key);
          return h("label", { key: key }, labels[key], h("input", { type: bool ? "checkbox" : key === "qty" ? "number" : "text", min: key === "qty" ? 0 : undefined, disabled: blocked, ...(bool ? { checked: editing.draft[key] } : { value: editing.draft[key] }), onChange: e => setEditing({ ...editing, draft: { ...editing.draft, [key]: bool ? e.target.checked : e.target.value } }) }));
        }),
        h("div", { className: "dsh-ledger-actions" }, h("button", { type: "submit", disabled: blocked }, busy ? "保存中…" : "保存"), h("button", { type: "button", disabled: busy, onClick: () => setEditing(null) }, "取消"))) : null,
      !ledger[tab].length ? h("p", { className: "dsh-tavern-status-empty" }, "尚无记录") : tab === "scenes" ? sceneTree([]) : tab === "npcs" ? ["主要角色", "在场", "同区域", "不在场"].map(function (group) {
        const rows = ledger.npcs.filter(n => npcGroup(n) === group);
        return rows.length ? h("div", { key: group }, h("h4", null, group), rows.map(r => card(r, group))) : null;
      }) : ledger.items.map(r => card(r)),
      tab === "items" && ledger.itemLog.length ? h("details", null, h("summary", null, "近期物品变动"), ledger.itemLog.map(function (entry, i) {
        return h("p", { key: i }, "第 " + entry.turn + " 轮 · " + entry.name + " · " + ({ add: "获得", update: "更新", remove: "移除" }[entry.kind]) + (entry.to === undefined ? "" : " → " + entry.to));
      })) : null
    ) : null);
}
