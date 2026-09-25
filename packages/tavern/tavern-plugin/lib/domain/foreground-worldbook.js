import { worldbookRandomState, hasWorldbookRandom } from './worldbook-random.js'
import { estimateWorldBookTokens } from './worldbook-activation.js'
import { compactRecallDiagnostics, describeRecallEntries } from './worldbook-recall-log.js'
import { isMvuUpdateEntry } from './worldbook-recall.js'
import { prepareTemplateWorldbook, prepareWorldBookRecall, projectWorldBookTemplates } from './worldbook-recall.js'

/** One request uses one bound-book snapshot for both selection and rendering. */
export function createForegroundWorldbook({ bound, runtime, globalVariables, scanText = () => '', filterCandidates }) {
  return async function project({ chat, card, userText, userTextInHistory = false, worldBook: snapshot, purpose = 'generation' }) {
    try {
      let worldBook = snapshot || await bound(chat.cardPath, card, chat)
      const turn = Number([...(chat.messages || [])].reverse().find(message => message.role === 'assistant')?.turn) || 0
      const randomState = worldbookRandomState(chat, turn)
      // Older versions recorded the next-turn preview as a read. Let the first
      // real request re-evaluate that preview without suppressing its entries.
      const reads = { ...chat.worldBookReads }
      if (chat.preparedWorldBook && chat.preparedWorldBook.schemaVersion !== 2) {
        for (const ref of chat.preparedWorldBook.refs || []) {
          if (Number(reads[ref]?.turn) === Number(chat.preparedWorldBook.turn)) delete reads[ref]
        }
      }
      const templateRuntime = await runtime(chat.sessionId), globals = await globalVariables()
      worldBook = await prepareTemplateWorldbook(worldBook, templateRuntime, chat, globals)
      const preparedActivations = worldBook?.templateActivationRequests || []
      let activationRequests = preparedActivations, recalled, projected
      const tokenCosts = {}
      // Historical reconstruction must remain local even with the live filter installed.
      let screeningDone = purpose === 'history-import' || !filterCandidates, screening, allowedRefs
      const protectedRefs = () => new Set(activationRequests.flatMap(request => [request.ref, request.sourceRef]))
      // Rebuild from the same snapshot and original scopes; speculative passes never mutate Chat.
      // Only requests from controllers still selected survive to the next pass.
      const randomValues = []
      let converged = false
      for (let pass = 0; pass < 16; pass++) {
        let randomIndex = 0
        const random = () => { const index = randomIndex++; return randomValues[index] ?? (randomValues[index] = Math.random()) }
        recalled = prepareWorldBookRecall({ worldBook, chat: { ...chat, worldBookReads: reads }, card, turn, userText, userTextInHistory,
          scanText: scanText(chat), activationRequests, random, tokenCosts, ignoreBudget: pass === 0 || !screeningDone, allowedRefs, protectedRefs: protectedRefs() })
        projected = await projectWorldBookTemplates({ worldBook, selectedEntries: recalled.entries || [], includeConstants: true,
          runtime: templateRuntime, globalVariables: globals, chat, card, activationRequests, random, randomSeed: randomState.seed })
        let costsChanged = false
        for (const entry of recalled.entries || []) {
          const output = projected.renderedEntries.find(output => output.ref === entry.ref)
          const cost = output ? estimateWorldBookTokens(output.text) + 2 : 0
          if (tokenCosts[entry.ref] !== cost) costsChanged = true
          tokenCosts[entry.ref] = cost
        }
        const next = [...preparedActivations, ...(projected.activationRequests || [])]
        const key = requests => JSON.stringify(requests.map(request => [request.sourceRef, request.ref, request.force]).sort())
        if (pass > 0 && !costsChanged && key(next) === key(activationRequests)) {
          if (!screeningDone) {
            const protectedSet = protectedRefs()
            const candidates = (recalled.entries || []).filter(entry => !entry.constant && !protectedSet.has(entry.ref) && tokenCosts[entry.ref] > 0).map(entry => ({
              ref: entry.ref, title: entry.title || entry.comment, tokenCost: tokenCosts[entry.ref],
              text: projected.renderedEntries.find(output => output.ref === entry.ref).text,
              match: recalled.diagnostics.find(item => item.ref === entry.ref)?.match
            }))
            screening = await filterCandidates({ chat, card, userText, candidates, corpus: (worldBook?.view?.entries || []).filter(entry => entry.enabled !== false && !isMvuUpdateEntry(entry)) })
            allowedRefs = new Set(screening.selected)
            screeningDone = true
            continue
          }
          converged = true; break
        }
        activationRequests = next
      }
      if (!converged) throw new Error('世界书脚本激活未在 16 次投影内收敛')
      // A failed/empty template was not injected and must not consume cooldown.
      const renderedRefs = new Set(projected.refs)
      const accepted = recalled.refs.filter(ref => renderedRefs.has(ref))
      const recorded = recalled.recordReads(chat.worldBookReads)
      const nextReads = { ...chat.worldBookReads }
      for (const ref of accepted) nextReads[ref] = recorded[ref]
      const evaluatedRefs = new Set((recalled.diagnostics || []).map(entry => entry.ref))
      const excluded = (worldBook?.view?.entries || []).filter(entry => !evaluatedRefs.has(entry.ref) && (entry.enabled === false || !String(entry.content || '').trim() || isMvuUpdateEntry(entry)))
        .map(entry => ({ ref: entry.ref, title: entry.title || entry.comment, reason: entry.enabled === false ? 'disabled' : !String(entry.content || '').trim() ? 'empty' : 'mvu-update' }))
      const outputs = projected.renderedEntries || []
      const entries = describeRecallEntries([...(recalled.diagnostics || []), ...excluded]).map(entry => {
        const outputIndex = outputs.findIndex(output => output.ref === entry.ref)
        const failure = projected.diagnostics.find(item => item.ref === entry.ref)
        return { ...entry, outputOrder: outputIndex >= 0 ? outputIndex + 1 : null,
          rendering: outputIndex >= 0 ? 'rendered' : failure ? failure.code : entry.reason === 'selected' ? 'empty-output' : 'not-selected' }
      })
      const log = { settings: { ...recalled.settings, cooldownTurns: 10 }, budget: recalled.budget, screening, scanSources: recalled.scanSources || [],
        counts: entries.reduce((result, entry) => { result[entry.reason] = (result[entry.reason] || 0) + 1; return result }, {}), entries, outputs,
        dynamicRefs: accepted, activationRequests, templateDiagnostics: projected.diagnostics }
      return { ...projected, randomState: { ...randomState, outputs: Object.fromEntries(outputs.filter(output => hasWorldbookRandom(worldBook.view.entries.find(entry => entry.ref === output.ref)?.content)).map(output => [output.ref, output.text])) }, log, context: projected.foregroundContext, refs: accepted, reads: nextReads,
        activation: { schemaVersion: 2, turn, refs: accepted, diagnostics: compactRecallDiagnostics(recalled.diagnostics), mode: recalled.kind }, error: null }
    } catch (error) {
      if (error.code === 'FULL_TEMPLATE_UNAVAILABLE') throw error
      return { log: { error: String(error?.message || error), entries: [], outputs: [], counts: {} }, context: '', refs: [], diagnostics: [], activation: { schemaVersion: 2, refs: [], mode: 'error' }, error: String(error?.message || error) }
    }
  }
}
