// null requests a read-only snapshot; an obsolete receipt cannot roll state back.
// Untouched history remains shared. This function also runs inside script iframes.
function applyTavernVariableReceipt(previous, delta) {
    if (!previous || !delta || delta.version !== 1) return null;
    if (delta.chatId !== previous.chatId || delta.lifecycleRevision < Number(previous.lifecycleRevision || 0)) return previous;
    if (delta.lifecycleRevision !== Number(previous.lifecycleRevision || 0)) return null;
    if (delta.stateRevision <= Number(previous.stateRevision || 0)) return previous;
    if (delta.baseRevision !== previous.stateRevision) return null;
    function copy(value) { return JSON.parse(JSON.stringify(value)); }
    const context = Object.assign({}, previous, { stateRevision: delta.stateRevision });
    if (delta.message) {
        if (!Number.isInteger(delta.messageId) || !previous.messages || !previous.messages[delta.messageId]) return null;
        context.messages = previous.messages.slice();
        const message = Object.assign({}, previous.messages[delta.messageId], copy(delta.message));
        // Retain the parent runtime's compatibility aliases without copying history.
        if (Object.prototype.hasOwnProperty.call(message, 'mes')) message.mes = message.message;
        context.messages[delta.messageId] = message;
    } else if (delta.chatVariables) context.chatVariables = copy(delta.chatVariables);
    else if (delta.scriptVariables) context.scriptVariables = copy(delta.scriptVariables);
    else return null;
    return context;
}
