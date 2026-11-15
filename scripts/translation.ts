import mountContent from "../src/browser/translation/content.js"

const runtime = globalThis as typeof globalThis & { __piTranslationCleanup?: () => void }
runtime.__piTranslationCleanup?.()
runtime.__piTranslationCleanup = mountContent()
