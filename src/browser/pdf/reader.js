import {
  GlobalWorkerOptions,
  getDocument,
  PasswordResponses,
  TextLayer,
} from "pdfjs-dist/legacy/build/pdf.mjs"
import * as Pdf from "../translation/shared/pdf.js"
import { ui } from "../translation/shared/ui.js"
import { cacheTranslations, clearPdfCache, getCachedTranslations } from "./cache.js"
import { analyzePdfPage, removeRepeatedFurniture } from "./extraction.js"
import { createReaderPort } from "./local-session.js"
import {
  buildPdfTranslationCopy,
  createBoundedPdfBatches,
  decodeLaunchToken,
  getPdfHighlightBounds,
  hashText,
  renderSearchText,
  sanitizeDocumentId,
  splitPdfBlocks,
} from "./reader-utils.js"
import { announcePdfDocument } from "./session.js"
import { inspectRemotePdf, readLocalPdf } from "./source.js"

GlobalWorkerOptions.workerPort = new Worker(new URL("./worker.ts", import.meta.url), {
  type: "module",
})

const elements = {
  cancel: document.querySelector("#cancel-translation"),
  clearCache: document.querySelector("#clear-cache"),
  copyDocument: document.querySelector("#copy-document"),
  copyPage: document.querySelector("#copy-page"),
  documentStatus: document.querySelector("#document-status"),
  documentTitle: document.querySelector("#document-title"),
  error: document.querySelector("#error"),
  localFile: document.querySelector("#local-file"),
  nextPage: document.querySelector("#next-page"),
  openOriginal: document.querySelector("#open-original"),
  pageStatus: document.querySelector("#page-status"),
  password: document.querySelector("#pdf-password"),
  passwordDialog: document.querySelector("#password-dialog"),
  pause: document.querySelector("#pause-translation"),
  previousPage: document.querySelector("#previous-page"),
  retry: document.querySelector("#retry-failed"),
  search: document.querySelector("#translation-search"),
  sourcePages: document.querySelector("#source-pages"),
  sourceScroll: document.querySelector("#source-scroll"),
  translateAll: document.querySelector("#translate-all"),
  translationPages: document.querySelector("#translation-pages"),
  translationScroll: document.querySelector("#translation-scroll"),
  zoomIn: document.querySelector("#zoom-in"),
  zoomOut: document.querySelector("#zoom-out"),
  zoomStatus: document.querySelector("#zoom-status"),
}

const launchTokenFromHash = decodeLaunchToken(location.hash)
if (launchTokenFromHash && Pdf.isSafePdfId(launchTokenFromHash)) {
  sessionStorage.setItem("vibePdfLaunchToken", launchTokenFromHash)
}
const launchToken = launchTokenFromHash || sessionStorage.getItem("vibePdfLaunchToken") || "local"
history.replaceState(null, "", location.pathname)
const state = {
  activeRequests: new Set(),
  blocksById: new Map(),
  cacheContext: "",
  currentPage: 1,
  document: null,
  documentId: "",
  failedIds: new Set(),
  loadingTask: null,
  loadSequence: 0,
  pageCount: 0,
  pendingLoadingTask: null,
  pageData: new Map(),
  pageElements: new Map(),
  paused: false,
  pendingIds: new Set(),
  port: null,
  reconnectTimer: null,
  renderedPages: new Set(),
  renderTasks: new Map(),
  requestSequence: 0,
  sessionId: "",
  settingsFingerprint: "",
  source: null,
  sourceAbort: null,
  sourceSequence: 0,
  targetLanguage: "",
  translationDocumentId: "",
  translations: new Map(),
  zoom: 1,
}

function cancelRemoteSource() {
  state.sourceSequence += 1
  state.sourceAbort?.abort()
  state.sourceAbort = null
}

function setStatus(message) {
  elements.documentStatus.textContent = message
}

function showError(error) {
  const message = String(error?.message || error || "Unexpected PDF reader error.")
    .trim()
    .slice(0, 400)
  elements.error.textContent = message
  elements.error.hidden = !message
  setStatus(message || "Ready")
}

function clearError() {
  elements.error.hidden = true
  elements.error.textContent = ""
}

function updateControls() {
  const ready = Boolean(state.document && state.sessionId)
  elements.cancel.disabled = !state.sessionId
  elements.copyDocument.disabled = state.translations.size === 0
  elements.copyPage.disabled = !Array.from(state.blocksById.values()).some(
    (block) => block.pageNumber === state.currentPage && state.translations.has(block.id),
  )
  elements.nextPage.disabled = !state.document || state.currentPage >= state.pageCount
  elements.openOriginal.disabled = !state.source?.url
  elements.pause.disabled = !ready
  elements.previousPage.disabled = !state.document || state.currentPage <= 1
  elements.retry.disabled = state.failedIds.size === 0 || !ready
  elements.translateAll.disabled = !ready
  elements.pause.textContent = ui(state.paused ? "Resume" : "Pause")
  elements.pageStatus.textContent = state.document
    ? `${ui("Page {page}", { page: state.currentPage })} / ${state.pageCount}`
    : `${ui("Page {page}", { page: "–" })} / –`
  elements.zoomStatus.textContent = `${Math.round(state.zoom * 100)}%`
}

function getBlockElement(id) {
  return elements.translationPages.querySelector(`[data-block-id="${CSS.escape(id)}"]`)
}

function updateBlockElement(id, element = getBlockElement(id)) {
  const block = state.blocksById.get(id)
  if (!block || !element) {
    return
  }
  const translation = state.translations.get(id)
  const query = elements.search.value.trim()
  if (block.originalOnly) {
    element.dataset.state = "original"
    element.textContent = `${block.text}\n[${ui("Formula or structured content kept in the original PDF")}]`
    return
  }
  if (translation) {
    element.dataset.state = "ready"
    renderSearchText(element, translation, query)
  } else if (state.failedIds.has(id)) {
    element.dataset.state = "failed"
    element.textContent = ui("Translation failed. Use Retry failed to try again.")
  } else if (state.pendingIds.has(id)) {
    element.dataset.state = "pending"
    element.textContent = `${ui("Translating…")} ${state.targetLanguage || ""}`
  } else {
    element.dataset.state = "idle"
    element.textContent = block.text
  }
}

function applySearch() {
  const query = elements.search.value.trim().toLocaleLowerCase()
  for (const pageElement of elements.translationPages.children) {
    let visibleCount = 0
    for (const blockElement of pageElement.querySelectorAll("[data-block-id]")) {
      const block = state.blocksById.get(blockElement.dataset.blockId)
      const text = state.translations.get(block?.id) || block?.text || ""
      const visible = !query || text.toLocaleLowerCase().includes(query)
      blockElement.hidden = !visible
      if (visible) {
        visibleCount += 1
        updateBlockElement(block.id)
      }
    }
    pageElement.hidden = Boolean(query) && visibleCount === 0
  }
}

function createTranslationPages(pages) {
  elements.translationPages.replaceChildren()
  state.blocksById.clear()
  for (const page of pages) {
    const section = document.createElement("section")
    section.className = "translation-page"
    section.dataset.pageNumber = String(page.pageNumber)
    const heading = document.createElement("h2")
    heading.textContent = ui("Page {page}", { page: page.pageNumber })
    section.append(heading)
    if (page.blocks.length === 0) {
      const empty = document.createElement("p")
      empty.className = "empty-page"
      empty.textContent = ui("No extractable text was found on this page.")
      section.append(empty)
    }
    for (const block of page.blocks) {
      block.sourceHash = hashText(block.text)
      state.blocksById.set(block.id, block)
      const article = document.createElement("article")
      article.className = "translation-block"
      article.dataset.blockId = block.id
      article.dataset.kind = block.role
      article.tabIndex = block.originalOnly ? -1 : 0
      article.addEventListener("click", () => revealSourceBlock(block))
      article.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          revealSourceBlock(block)
        }
      })
      section.append(article)
      updateBlockElement(block.id, article)
    }
    elements.translationPages.append(section)
  }
}

function createSourcePlaceholders(pages) {
  elements.sourcePages.replaceChildren()
  state.pageElements.clear()
  for (const page of pages) {
    const element = document.createElement("article")
    element.className = "pdf-page"
    element.dataset.pageNumber = String(page.pageNumber)
    element.setAttribute("aria-label", ui("Page {page}", { page: page.pageNumber }))
    const ratio = page.height / page.width
    element.style.width = `${Math.round(page.width * state.zoom)}px`
    element.style.height = `${Math.round(page.width * state.zoom * ratio)}px`
    elements.sourcePages.append(element)
    state.pageElements.set(page.pageNumber, element)
  }
}

async function requestPassword(updatePassword, reason) {
  return new Promise((resolve) => {
    elements.password.value = ""
    elements.passwordDialog.querySelector("p").textContent = ui(
      reason === PasswordResponses.INCORRECT_PASSWORD
        ? "The PDF password is incorrect. Try again."
        : "This PDF is encrypted.",
    )
    const handleClose = () => {
      const password = elements.password.value
      elements.password.value = ""
      if (elements.passwordDialog.returnValue === "submit" && password) {
        updatePassword(password)
        resolve(true)
      } else {
        resolve(false)
      }
    }
    elements.passwordDialog.addEventListener("close", handleClose, {
      once: true,
    })
    elements.passwordDialog.returnValue = "cancel"
    elements.passwordDialog.showModal()
    elements.password.focus()
  })
}

async function loadPdfDocument(source) {
  const loadSequence = ++state.loadSequence
  clearError()
  setStatus("Opening PDF…")
  if (
    !(source.data instanceof Uint8Array) ||
    source.data.byteLength > Pdf.PDF_LIMITS.maximumSourceBytes
  )
    throw new Error("PDF bytes are unavailable or exceed the supported limit. Choose a local PDF.")
  const nextLoadingTask = getDocument({
    data: source.data,
    isEvalSupported: false,
    cMapUrl: chrome.runtime.getURL("pdf/cmaps/"),
    standardFontDataUrl: chrome.runtime.getURL("pdf/standard_fonts/"),
    wasmUrl: chrome.runtime.getURL("pdf/wasm/"),
    iccUrl: chrome.runtime.getURL("pdf/iccs/"),
    maxImageSize: 16000000,
    canvasMaxAreaInBytes: 64000000,
    stopEvent: true,
  })
  const previousPendingTask = state.pendingLoadingTask
  state.pendingLoadingTask = nextLoadingTask
  if (previousPendingTask && previousPendingTask !== nextLoadingTask) {
    previousPendingTask.destroy().catch(() => {})
  }
  let passwordCancelled = false
  nextLoadingTask.onPassword = (updatePassword, reason) => {
    requestPassword(updatePassword, reason)
      .then((accepted) => {
        if (!accepted) {
          passwordCancelled = true
          nextLoadingTask.destroy()
        }
      })
      .catch(() => {
        passwordCancelled = true
        nextLoadingTask.destroy()
      })
  }

  let pdfDocument
  const nextPageData = new Map()
  const pages = []
  let characterCount = 0
  let documentId = ""
  try {
    pdfDocument = await nextLoadingTask.promise
    if (pdfDocument.numPages > Pdf.PDF_LIMITS.maximumPages) {
      throw new Error(
        `This PDF has ${pdfDocument.numPages} pages; the supported limit is ${Pdf.PDF_LIMITS.maximumPages}.`,
      )
    }
    documentId = sanitizeDocumentId(pdfDocument.fingerprints?.[0])
    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
      setStatus(`${ui("Loading…")} ${pageNumber}/${pdfDocument.numPages}`)
      const page = await pdfDocument.getPage(pageNumber)
      const viewport = page.getViewport({ scale: 1 })
      if (
        ![viewport.width, viewport.height].every(
          (value) => Number.isFinite(value) && value > 0 && value <= 20000,
        )
      ) {
        throw new Error("This PDF page exceeds the supported dimensions.")
      }
      const [textContent, structureTree] = await Promise.all([
        page.getTextContent({ includeMarkedContent: true }),
        page.getStructTree().catch(() => null),
      ])
      const analyzedBlocks = analyzePdfPage({
        documentId,
        items: textContent.items,
        pageNumber,
        pageWidth: viewport.width,
        structureTree,
      })
      const blocks = splitPdfBlocks(analyzedBlocks, Pdf.PDF_LIMITS.maximumItemCharacters)
      characterCount += analyzedBlocks.reduce((sum, block) => sum + block.text.length, 0)
      if (characterCount > Pdf.PDF_LIMITS.maximumDocumentCharacters) {
        throw new Error("This PDF contains more extractable text than the supported limit.")
      }
      pages.push({
        blocks,
        height: viewport.height,
        pageNumber,
        width: viewport.width,
      })
      nextPageData.set(pageNumber, { page, textContent, viewport })
    }
  } catch (error) {
    await nextLoadingTask.destroy().catch(() => {})
    if (state.pendingLoadingTask === nextLoadingTask) {
      state.pendingLoadingTask = null
    }
    if (loadSequence !== state.loadSequence) {
      return false
    }
    if (passwordCancelled) {
      throw new Error("PDF password entry was cancelled.")
    }
    throw error
  }

  if (loadSequence !== state.loadSequence) {
    await nextLoadingTask.destroy().catch(() => {})
    return false
  }
  const metadata = await pdfDocument.getMetadata().catch(() => null)
  if (loadSequence !== state.loadSequence) {
    await nextLoadingTask.destroy().catch(() => {})
    return false
  }
  const filteredPages = removeRepeatedFurniture(pages)
  for (const page of filteredPages) {
    nextPageData.get(page.pageNumber).blocks = page.blocks
  }

  const previousLoadingTask = state.loadingTask
  state.pageObserver?.disconnect()
  for (const task of state.renderTasks.values()) {
    task.cancel()
  }
  state.renderTasks.clear()
  state.renderedPages.clear()
  state.loadingTask = nextLoadingTask
  state.pendingLoadingTask = null
  state.document = pdfDocument
  state.documentId = documentId
  state.translationDocumentId = `document-${crypto.randomUUID()}`
  state.pageCount = pdfDocument.numPages
  state.pageData = nextPageData
  state.currentPage = 1
  state.cacheContext = `${state.documentId}:${state.settingsFingerprint}:${state.targetLanguage}`
  if (!source.url) {
    state.source = { title: source.title, url: "" }
    localDocumentReady()
  }
  state.translations.clear()
  state.failedIds.clear()
  state.pendingIds.clear()
  state.activeRequests.clear()
  announcePdfDocument(state)
  if (previousLoadingTask && previousLoadingTask !== nextLoadingTask) {
    await previousLoadingTask.destroy().catch(() => {})
  }
  // A failed attempt does not replace the installed document.
  if (state.loadingTask !== nextLoadingTask) return false

  const title = Pdf.sanitizePdfTitle(metadata?.info?.Title, Pdf.sanitizePdfTitle(source.title))
  elements.documentTitle.textContent = title
  document.title = `${title} — Pi PDF Reader`
  createSourcePlaceholders(filteredPages)
  createTranslationPages(filteredPages)
  setupPageObserver()
  await renderWindow(1)
  if (state.loadingTask !== nextLoadingTask) return false
  if (characterCount < state.pageCount * 20) {
    showError(
      "Very little text could be extracted. This may be a scanned PDF and OCR is not supported yet.",
    )
  } else {
    setStatus(`${ui("Ready")} · ${state.pageCount}`)
    await queuePageWindow(1)
  }
  if (state.loadingTask !== nextLoadingTask) return false
  updateControls()
  return true
}

async function renderPage(pageNumber) {
  if (!state.document || state.renderedPages.has(pageNumber) || state.renderTasks.has(pageNumber)) {
    return
  }
  const data = state.pageData.get(pageNumber)
  const container = state.pageElements.get(pageNumber)
  if (!data || !container) {
    return
  }
  const viewport = data.page.getViewport({ scale: state.zoom })
  container.style.width = `${viewport.width}px`
  container.style.height = `${viewport.height}px`
  container.style.setProperty("--total-scale-factor", String(viewport.scale * viewport.userUnit))
  const canvas = document.createElement("canvas")
  const outputScale = Math.min(
    devicePixelRatio || 1,
    2,
    4096 / viewport.width,
    4096 / viewport.height,
    Math.sqrt(4_000_000 / (viewport.width * viewport.height)),
  )
  canvas.width = Math.floor(viewport.width * outputScale)
  canvas.height = Math.floor(viewport.height * outputScale)
  canvas.style.width = `${viewport.width}px`
  canvas.style.height = `${viewport.height}px`
  const context = canvas.getContext("2d", { alpha: false })
  const renderTask = data.page.render({
    canvasContext: context,
    transform: outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0],
    viewport,
  })
  state.renderTasks.set(pageNumber, renderTask)
  try {
    await renderTask.promise
    const textLayerElement = document.createElement("div")
    textLayerElement.className = "text-layer"
    const textLayer = new TextLayer({
      container: textLayerElement,
      textContentSource: data.textContent,
      viewport,
    })
    await textLayer.render()
    if (
      state.renderTasks.get(pageNumber) !== renderTask ||
      state.pageData.get(pageNumber) !== data ||
      state.pageElements.get(pageNumber) !== container
    ) {
      textLayer.cancel()
      return
    }
    document.querySelectorAll(".hiddenCanvasElement").forEach((element) => {
      element.setAttribute("aria-hidden", "true")
    })
    container.replaceChildren(canvas, textLayerElement)
    state.renderedPages.add(pageNumber)
  } catch (error) {
    if (error?.name !== "RenderingCancelledException") {
      throw error
    }
  } finally {
    if (state.renderTasks.get(pageNumber) === renderTask) {
      state.renderTasks.delete(pageNumber)
    }
  }
}

function unrenderDistantPages(center) {
  for (const pageNumber of Array.from(state.renderedPages)) {
    if (Math.abs(pageNumber - center) <= 3) {
      continue
    }
    state.pageElements.get(pageNumber)?.replaceChildren()
    state.renderedPages.delete(pageNumber)
  }
}

async function renderWindow(center) {
  const pageNumbers = [center, center - 1, center + 1, center - 2, center + 2].filter(
    (pageNumber) => pageNumber >= 1 && pageNumber <= state.pageCount,
  )
  await Promise.all(pageNumbers.map(renderPage))
  unrenderDistantPages(state.currentPage)
}

function setupPageObserver() {
  state.pageObserver?.disconnect()
  state.pageObserver = new IntersectionObserver(
    (entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0]
      if (!visible) {
        return
      }
      const pageNumber = Number(visible.target.dataset.pageNumber)
      activatePage(pageNumber)
    },
    { root: elements.sourceScroll, threshold: [0.2, 0.5, 0.8] },
  )
  for (const pageElement of state.pageElements.values()) {
    state.pageObserver.observe(pageElement)
  }
}

function post(message) {
  if (!state.port) {
    throw new Error("The PDF translation service is reconnecting.")
  }
  state.port.postMessage(message)
}

async function applyCachedBlocks(blocks, snapshot) {
  const cached = await getCachedTranslations(snapshot.cacheContext, blocks)
  if (
    state.cacheContext !== snapshot.cacheContext ||
    state.documentId !== snapshot.documentId ||
    state.sessionId !== snapshot.sessionId ||
    state.translationDocumentId !== snapshot.translationDocumentId ||
    blocks.some((block) => state.blocksById.get(block.id) !== block)
  ) {
    return false
  }
  for (const translation of cached) {
    state.translations.set(translation.id, translation.translation)
    updateBlockElement(translation.id)
  }
  applySearch()
  updateControls()
  return true
}

async function queueBlocks(blocks, placement = "front") {
  if (state.paused || !state.sessionId) {
    return
  }
  const snapshot = {
    cacheContext: state.cacheContext,
    documentId: state.documentId,
    sessionId: state.sessionId,
    translationDocumentId: state.translationDocumentId,
  }
  if (!(await applyCachedBlocks(blocks, snapshot)) || state.paused) {
    return
  }
  const pending = blocks.filter(
    (block) =>
      !block.originalOnly && !state.translations.has(block.id) && !state.pendingIds.has(block.id),
  )
  const batches = createBoundedPdfBatches(pending, {
    maximumCharacters: Pdf.PDF_LIMITS.maximumBatchCharacters,
    maximumItems: Pdf.PDF_LIMITS.maximumItemsPerBatch,
  })
  for (const items of batches) {
    const requestId = `request-${++state.requestSequence}`
    state.activeRequests.add(requestId)
    for (const item of items) {
      state.pendingIds.add(item.id)
      state.failedIds.delete(item.id)
      updateBlockElement(item.id)
    }
    try {
      post({
        type: Pdf.CLIENT_MESSAGE_TYPES.QUEUE,
        documentId: snapshot.translationDocumentId,
        items: items.map(({ id, role: kind, text }) => ({ id, kind, text })),
        placement,
        requestId,
        sessionId: snapshot.sessionId,
      })
    } catch (error) {
      state.activeRequests.delete(requestId)
      for (const item of items) {
        state.pendingIds.delete(item.id)
        updateBlockElement(item.id)
      }
      throw error
    }
  }
  updateControls()
}

async function queuePageWindow(pageNumber) {
  if (state.paused) {
    return
  }
  const pageNumbers = [pageNumber, pageNumber + 1, pageNumber - 1, pageNumber + 2].filter(
    (number) => number >= 1 && number <= state.pageCount,
  )
  for (const number of pageNumbers) {
    await queueBlocks(state.pageData.get(number)?.blocks || [], "front")
  }
}

async function queueEntireDocument() {
  const blocks = Array.from(state.blocksById.values()).filter(
    (block) => !block.originalOnly && !state.translations.has(block.id),
  )
  const characters = blocks.reduce((sum, block) => sum + block.text.length, 0)
  if (
    !confirm(
      ui(
        "Translate {blocks} remaining blocks ({count} characters)? This may use significant API quota.",
        { blocks: blocks.length, count: characters.toLocaleString(document.documentElement.lang) },
      ),
    )
  ) {
    return
  }
  const confirmedDocument = state.translationDocumentId
  const confirmedSession = state.sessionId
  const pages = [...state.pageData.values()]
  for (const page of pages) {
    if (state.translationDocumentId !== confirmedDocument || state.sessionId !== confirmedSession)
      return
    await queueBlocks(page.blocks || [], "back")
  }
}

async function retryFailed() {
  if (!state.sessionId || state.failedIds.size === 0) {
    return
  }
  const blocks = Array.from(state.failedIds)
    .map((id) => state.blocksById.get(id))
    .filter(Boolean)
  const batches = createBoundedPdfBatches(blocks, {
    maximumCharacters: Pdf.PDF_LIMITS.maximumBatchCharacters,
    maximumItems: Pdf.PDF_LIMITS.maximumItemsPerBatch,
  })
  for (const items of batches) {
    const requestId = `retry-${++state.requestSequence}`
    for (const item of items) {
      state.pendingIds.add(item.id)
      state.failedIds.delete(item.id)
      updateBlockElement(item.id)
    }
    try {
      post({
        type: Pdf.CLIENT_MESSAGE_TYPES.RETRY,
        documentId: state.translationDocumentId,
        items: items.map(({ id, role: kind, text }) => ({ id, kind, text })),
        placement: "front",
        requestId,
        sessionId: state.sessionId,
      })
    } catch (error) {
      for (const item of items) {
        state.pendingIds.delete(item.id)
        state.failedIds.add(item.id)
        updateBlockElement(item.id)
      }
      throw error
    }
  }
  updateControls()
}

function revealSourceBlock(block) {
  const pageElement = state.pageElements.get(block.pageNumber)
  if (!pageElement) {
    return
  }
  pageElement.scrollIntoView({ block: "start" })
  state.currentPage = block.pageNumber
  updateControls()
  renderWindow(block.pageNumber)
    .then(() => {
      pageElement.querySelectorAll(".source-highlight").forEach((item) => {
        item.remove()
      })
      const viewport = state.pageData.get(block.pageNumber).page.getViewport({ scale: state.zoom })
      for (const box of block.boxes) {
        const bounds = getPdfHighlightBounds(viewport, box)
        const highlight = document.createElement("div")
        highlight.className = "source-highlight"
        highlight.style.left = `${bounds.left}px`
        highlight.style.top = `${bounds.top}px`
        highlight.style.width = `${bounds.width}px`
        highlight.style.height = `${bounds.height}px`
        pageElement.append(highlight)
      }
      setTimeout(() => {
        pageElement.querySelectorAll(".source-highlight").forEach((item) => {
          item.remove()
        })
      }, 4000)
    })
    .catch(showError)
}

async function handleServerMessage(message) {
  if (!message || typeof message !== "object") {
    return
  }
  if (message.type === Pdf.SERVER_MESSAGE_TYPES.SESSION_STARTED) {
    state.sessionId = message.sessionId
    state.settingsFingerprint = String(message.settingsFingerprint || "default")
    state.targetLanguage = message.targetLanguage
    state.source = message.source
    const nextCacheContext = `${state.documentId}:${state.settingsFingerprint}:${state.targetLanguage}`
    if (state.cacheContext !== nextCacheContext) {
      state.translations.clear()
      state.failedIds.clear()
      state.pendingIds.clear()
      state.activeRequests.clear()
      for (const id of state.blocksById.keys()) updateBlockElement(id)
    }
    state.cacheContext = nextCacheContext
    elements.openOriginal.disabled = false
    setStatus(`${ui("Ready")} · ${state.targetLanguage}`)
    updateControls()
    if (!state.document && message.source.url) {
      cancelRemoteSource()
      const sourceSequence = state.sourceSequence
      const sourceAbort = new AbortController()
      state.sourceAbort = sourceAbort
      try {
        const source = await inspectRemotePdf(message.source.url, {
          signal: AbortSignal.any([sourceAbort.signal, AbortSignal.timeout(120000)]),
        })
        if (sourceSequence !== state.sourceSequence) return
        await loadPdfDocument({ ...source, title: message.source.title })
      } catch (error) {
        if (sourceSequence === state.sourceSequence) showError(error)
      } finally {
        if (state.sourceAbort === sourceAbort) state.sourceAbort = null
      }
    } else if (!state.document) {
      setStatus(ui("Choose the local PDF file to continue"))
    } else {
      announcePdfDocument(state)
      await queuePageWindow(state.currentPage)
    }
    return
  }
  if (message.sessionId && message.sessionId !== state.sessionId) {
    return
  }
  if (message.documentId && message.documentId !== state.translationDocumentId) {
    return
  }
  if (message.type === Pdf.SERVER_MESSAGE_TYPES.BATCH_STARTED) {
    setStatus(`${ui("Translating…")} ${message.itemCount}`)
    return
  }
  if (message.type === Pdf.SERVER_MESSAGE_TYPES.TRANSLATION_UPDATE) {
    for (const translation of message.translations || []) {
      if (!state.blocksById.has(translation.id)) {
        continue
      }
      state.translations.set(translation.id, translation.translation)
      state.pendingIds.delete(translation.id)
      state.failedIds.delete(translation.id)
      updateBlockElement(translation.id)
    }
    applySearch()
    await cacheTranslations(state.cacheContext, state.blocksById, message.translations || [])
    setStatus(ui("Translated blocks: {count}", { count: state.translations.size }))
    updateControls()
    return
  }
  if (message.type === Pdf.SERVER_MESSAGE_TYPES.BATCH_COMPLETE) {
    state.activeRequests.delete(message.requestId)
    for (const id of message.completedIds || []) {
      state.pendingIds.delete(id)
    }
    for (const id of message.failedIds || []) {
      state.pendingIds.delete(id)
      state.failedIds.add(id)
      updateBlockElement(id)
    }
    setStatus(
      state.activeRequests.size > 0
        ? `${ui("Translated blocks: {count}", { count: state.translations.size })}; ${ui("Queued batches: {count}", { count: state.activeRequests.size })}`
        : ui("Translated blocks: {count}", { count: state.translations.size }),
    )
    updateControls()
    return
  }
  if (message.type === Pdf.SERVER_MESSAGE_TYPES.ERROR) {
    if (message.requestId) {
      state.activeRequests.delete(message.requestId)
    }
    for (const id of message.failedIds || []) {
      state.pendingIds.delete(id)
      state.failedIds.add(id)
      updateBlockElement(id)
    }
    showError(message.error)
    if (!state.sessionId) {
      document.getElementById("pdf-approve").hidden = false
      sessionStopped()
    }
    updateControls()
    return
  }
  if (message.type === Pdf.SERVER_MESSAGE_TYPES.CANCELLED) {
    cancelRemoteSource()
    state.sessionId = ""
    const cancelledPort = state.port
    state.port = null
    cancelledPort?.disconnect()
    state.pendingIds.clear()
    setStatus(ui("Translation cancelled"))
    sessionStopped()
    document.getElementById("pdf-approve").hidden = false
    for (const id of state.blocksById.keys()) {
      updateBlockElement(id)
    }
    updateControls()
  }
}

export function connectPort() {
  clearTimeout(state.reconnectTimer)
  const previous = state.port
  state.port = null
  previous?.disconnect()
  const port = createReaderPort()
  state.port = port
  port.onMessage.addListener((message) => {
    handleServerMessage(message).catch(showError)
  })
  port.onDisconnect.addListener(() => {
    if (state.port !== port) {
      return
    }
    cancelRemoteSource()
    state.port = null
    state.sessionId = ""
    state.activeRequests.clear()
    state.pendingIds.clear()
    for (const id of state.blocksById.keys()) {
      updateBlockElement(id)
    }
    setStatus(ui("Translation interrupted. Select Start translation to continue."))
    sessionStopped()
    document.getElementById("pdf-approve").hidden = false
  })
  port.postMessage({ type: Pdf.CLIENT_MESSAGE_TYPES.START, launchToken })
}

function activatePage(pageNumber) {
  const normalized = Math.max(1, Math.min(state.pageCount, pageNumber))
  if (normalized === state.currentPage) {
    return
  }
  state.currentPage = normalized
  updateControls()
  renderWindow(normalized).catch(showError)
  queuePageWindow(normalized).catch(showError)
  elements.translationPages
    .querySelector(`[data-page-number="${normalized}"]`)
    ?.scrollIntoView({ block: "start" })
}

function navigateToPage(pageNumber) {
  activatePage(pageNumber)
  state.pageElements.get(state.currentPage)?.scrollIntoView({ block: "start" })
}

async function setZoom(nextZoom) {
  state.zoom = Math.max(0.5, Math.min(2.5, nextZoom))
  for (const task of state.renderTasks.values()) {
    task.cancel()
  }
  state.renderTasks.clear()
  state.renderedPages.clear()
  for (const [pageNumber, element] of state.pageElements) {
    const data = state.pageData.get(pageNumber)
    const viewport = data.page.getViewport({ scale: state.zoom })
    element.replaceChildren()
    element.style.width = `${viewport.width}px`
    element.style.height = `${viewport.height}px`
  }
  await renderWindow(state.currentPage)
  updateControls()
}

async function copyTranslations(pageNumber) {
  const blocks = Array.from(state.blocksById.values()).filter(
    (block) => pageNumber === undefined || block.pageNumber === pageNumber,
  )
  const text = buildPdfTranslationCopy(blocks, state.translations)
  if (!text) {
    return
  }
  await navigator.clipboard.writeText(text)
  setStatus(
    pageNumber ? `${ui("Copied")} · ${ui("Page {page}", { page: pageNumber })}` : ui("Copied"),
  )
}

let localDocumentReady = () => {}
let sessionStopped = () => {}
export function onSessionStopped(callback) {
  sessionStopped = callback
}
export function onLocalDocumentReady(callback) {
  localDocumentReady = callback
}

elements.localFile.addEventListener("change", async () => {
  cancelRemoteSource()
  const sourceSequence = state.sourceSequence
  try {
    const source = await readLocalPdf(elements.localFile.files?.[0])
    if (sourceSequence === state.sourceSequence && (await loadPdfDocument(source))) {
      state.source = { title: source.title, url: "" }
      updateControls()
    }
  } catch (error) {
    showError(error)
  } finally {
    elements.localFile.value = ""
  }
})
elements.openOriginal.addEventListener("click", () => {
  if (state.source?.url) {
    chrome.tabs.create({ url: state.source.url })
  }
})
elements.previousPage.addEventListener("click", () => navigateToPage(state.currentPage - 1))
elements.nextPage.addEventListener("click", () => navigateToPage(state.currentPage + 1))
elements.zoomOut.addEventListener("click", () => setZoom(state.zoom - 0.1))
elements.zoomIn.addEventListener("click", () => setZoom(state.zoom + 0.1))
elements.translateAll.addEventListener("click", () => queueEntireDocument().catch(showError))
elements.pause.addEventListener("click", () => {
  state.paused = !state.paused
  updateControls()
  if (!state.paused) {
    queuePageWindow(state.currentPage).catch(showError)
  }
})
elements.retry.addEventListener("click", () => retryFailed().catch(showError))
elements.cancel.addEventListener("click", () => {
  if (state.sessionId) {
    post({ type: Pdf.CLIENT_MESSAGE_TYPES.CANCEL, sessionId: state.sessionId })
  }
})
elements.clearCache.addEventListener("click", async () => {
  try {
    await clearPdfCache()
    setStatus(ui("PDF cache cleared"))
  } catch (error) {
    showError(error)
  }
})
elements.search.addEventListener("input", applySearch)
elements.copyPage.addEventListener("click", () =>
  copyTranslations(state.currentPage).catch(showError),
)
elements.copyDocument.addEventListener("click", () => copyTranslations().catch(showError))
window.addEventListener("beforeunload", () => {
  cancelRemoteSource()
  clearTimeout(state.reconnectTimer)
  state.pageObserver?.disconnect()
  state.port?.disconnect()
  state.pendingLoadingTask?.destroy()
  state.loadingTask?.destroy()
})

if (!Pdf.isSafePdfId(launchToken)) {
  showError("This PDF reader link is invalid. Open a PDF and click Pi Translator again.")
}
elements.localFile.disabled = false
updateControls()
