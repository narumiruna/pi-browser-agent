import { PDF_CACHE_VERSION } from "../translation/shared/pdf.js"

const DATABASE_NAME = "pi-browser-agent-pdf-translations"
const STORE_NAME = "translations"
const MAXIMUM_RECORDS = 5_000
const memoryRecords = new Map()

function createCacheKey(contextKey, block) {
  return JSON.stringify([
    PDF_CACHE_VERSION,
    String(contextKey),
    String(block.id),
    String(block.sourceHash),
  ])
}

function openDatabase(indexedDb = globalThis.indexedDB) {
  if (!indexedDb) {
    return Promise.resolve(null)
  }

  return new Promise((resolve, reject) => {
    const request = indexedDb.open(DATABASE_NAME, PDF_CACHE_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, {
          keyPath: "key",
        })
        store.createIndex("lastUsedAt", "lastUsedAt")
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function completeTransaction(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}

async function getCachedTranslations(contextKey, blocks, options = {}) {
  const database = await openDatabase(options.indexedDB).catch(() => null)
  const keys = blocks.map((block) => createCacheKey(contextKey, block))
  if (!database) {
    return keys.flatMap((key, index) => {
      const record = memoryRecords.get(key)
      return record ? [{ id: blocks[index].id, translation: record.translation }] : []
    })
  }

  const transaction = database.transaction(STORE_NAME, "readwrite")
  const store = transaction.objectStore(STORE_NAME)
  const results = []
  await Promise.all(
    keys.map(
      (key, index) =>
        new Promise((resolve) => {
          const request = store.get(key)
          request.onsuccess = () => {
            if (request.result) {
              request.result.lastUsedAt = Date.now()
              store.put(request.result)
              results.push({
                id: blocks[index].id,
                translation: request.result.translation,
              })
            }
            resolve()
          }
          request.onerror = resolve
        }),
    ),
  )
  await completeTransaction(transaction).catch(() => {})
  database.close()
  return results
}

async function evictOldRecords(database) {
  const countTransaction = database.transaction(STORE_NAME, "readonly")
  const countRequest = countTransaction.objectStore(STORE_NAME).count()
  const count = await new Promise((resolve) => {
    countRequest.onsuccess = () => resolve(countRequest.result || 0)
    countRequest.onerror = () => resolve(0)
  })
  await completeTransaction(countTransaction).catch(() => {})
  const removeCount = Math.max(0, count - MAXIMUM_RECORDS)
  if (removeCount === 0) {
    return
  }

  const transaction = database.transaction(STORE_NAME, "readwrite")
  const index = transaction.objectStore(STORE_NAME).index("lastUsedAt")
  let remaining = removeCount
  index.openCursor().onsuccess = (event) => {
    const cursor = event.target.result
    if (!cursor || remaining <= 0) {
      return
    }
    cursor.delete()
    remaining -= 1
    cursor.continue()
  }
  await completeTransaction(transaction).catch(() => {})
}

async function cacheTranslations(contextKey, blocksById, translations, options = {}) {
  const records = translations.flatMap((translation) => {
    const block = blocksById.get(translation.id)
    if (!block || !translation.translation) {
      return []
    }
    return [
      {
        key: createCacheKey(contextKey, block),
        lastUsedAt: Date.now(),
        translation: String(translation.translation),
      },
    ]
  })
  if (records.length === 0) {
    return
  }

  const database = await openDatabase(options.indexedDB).catch(() => null)
  if (!database) {
    for (const record of records) {
      memoryRecords.set(record.key, record)
    }
    while (memoryRecords.size > MAXIMUM_RECORDS) {
      memoryRecords.delete(memoryRecords.keys().next().value)
    }
    return
  }
  const transaction = database.transaction(STORE_NAME, "readwrite")
  const store = transaction.objectStore(STORE_NAME)
  for (const record of records) {
    store.put(record)
  }
  await completeTransaction(transaction)
  await evictOldRecords(database)
  database.close()
}

async function clearPdfCache(options = {}) {
  memoryRecords.clear()
  const database = await openDatabase(options.indexedDB)
  if (!database) {
    return
  }
  try {
    const transaction = database.transaction(STORE_NAME, "readwrite")
    transaction.objectStore(STORE_NAME).clear()
    await completeTransaction(transaction)
  } finally {
    database.close()
  }
}

export { cacheTranslations, clearPdfCache, createCacheKey, getCachedTranslations, MAXIMUM_RECORDS }
