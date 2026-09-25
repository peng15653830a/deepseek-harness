function installTavernStylesheet(doc, css) {
    const id = 'dsh-tavern-plugin/tavern.css';
    const selector = '[data-plugin-css="' + id + '"]';
    const active = doc.__dshTavernStylesheet;
    if (active) { active.dispose(); delete doc.__dshTavernStylesheet; }
    let style = doc.querySelector('style' + selector);
    if (!style) {
        style = doc.createElement('style');
        style.dataset.plugin = 'dsh-tavern-plugin';
        style.dataset.pluginCss = id;
        style.textContent = css;
        doc.head.appendChild(style);
    } else if (style.textContent !== css) style.textContent = css;
    // Retire old link loaders only after the bundled styles are installed.
    for (const node of doc.querySelectorAll(selector)) if (node !== style) node.remove();
}
