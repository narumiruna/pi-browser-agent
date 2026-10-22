import { afterEach, describe, expect, test, vi } from "vitest"
import { type ParsedSkill, SKILL_LIMITS, skillByteLength } from "../../src/browser/skills/format.js"
import {
  SKILLS_STORAGE_KEY,
  type SkillRecord,
  SkillStore,
  skillCatalog,
} from "../../src/browser/skills/store.js"

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const skill = (
  name = "review-page",
  body = "# Review\n\nRead the page.",
  description = "Review the page.",
): ParsedSkill => ({ name, description, body, warnings: [] })
const record = (n = 1, patch: Partial<SkillRecord> = {}): SkillRecord => ({
  id: id(n),
  name: `skill-${n}`,
  description: "Review the page.",
  body: "Read the page.",
  enabled: false,
  ...patch,
})
const envelope = (records: SkillRecord[]) => ({ version: 1, records })

function environment() {
  const values: Record<string, unknown> = {}
  const local = {
    // Return references deliberately: failed writes must not mutate the previous envelope.
    get: vi.fn(async (key: string) => ({ [key]: values[key] })),
    set: vi.fn(async (items: Record<string, unknown>) => {
      Object.assign(values, structuredClone(items))
    }),
  }
  vi.stubGlobal("chrome", { storage: { local } })
  return { values, local, store: new SkillStore() }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("versioned skill store", () => {
  test("uses a separate versioned envelope, disabled imports, detached reads, and explicit removal", async () => {
    const { store, values } = environment()
    values.unrelatedSettings = { secret: "not modified" }
    expect(SKILLS_STORAGE_KEY).toBe("piBrowserAgentSkillsV1")
    await expect(store.list()).resolves.toEqual([])
    const saved = await store.import(skill())
    expect(saved).toMatchObject({ name: "review-page", enabled: false })
    expect(saved.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(values[SKILLS_STORAGE_KEY]).toEqual(envelope([saved]))
    expect(JSON.stringify(values[SKILLS_STORAGE_KEY])).not.toContain("warnings")
    await store.setEnabled(saved.id, true)
    expect(await store.list()).toEqual([{ ...saved, enabled: true }])
    const listed = await store.list()
    if (!listed[0]) throw new Error("Missing skill")
    listed[0].body = "Changed outside storage"
    saved.name = "changed-outside-storage"
    expect((await store.list())[0]?.body).toBe(skill().body)
    expect((await store.list())[0]?.name).toBe("review-page")
    await store.setEnabled(saved.id, false)
    await store.remove(saved.id)
    expect(values[SKILLS_STORAGE_KEY]).toEqual(envelope([]))
    expect(values.unrelatedSettings).toEqual({ secret: "not modified" })
  })

  test("replacement keeps ID and position but requires a fresh enable decision", async () => {
    const { store } = environment()
    const original = await store.import(skill())
    const other = await store.import(skill("other"))
    await store.setEnabled(original.id, true)
    const replaced = await store.replace(original.id, skill("renamed", "New body"))
    expect(replaced).toEqual({
      id: original.id,
      name: "renamed",
      description: skill().description,
      body: "New body",
      enabled: false,
    })
    expect(await store.list()).toEqual([replaced, other])
  })

  test("name collisions never overwrite imports or another record during replacement", async () => {
    const { store, values, local } = environment()
    const first = await store.import(skill())
    const second = await store.import(skill("other"))
    const before = structuredClone(values)
    local.set.mockClear()
    await expect(store.import(skill())).rejects.toThrow("already installed")
    await expect(store.replace(second.id, skill(first.name))).rejects.toThrow("already installed")
    expect(values).toEqual(before)
    expect(local.set).not.toHaveBeenCalled()
  })

  test("missing IDs cannot silently import, enable, or delete a different record", async () => {
    const { store, values, local } = environment()
    await store.import(skill())
    const before = structuredClone(values)
    local.set.mockClear()
    for (const missing of ["", id(123), "__proto__", "constructor"]) {
      await expect(store.replace(missing, skill("replacement"))).rejects.toThrow("no longer exists")
      await expect(store.setEnabled(missing, true)).rejects.toThrow("no longer exists")
      await expect(store.remove(missing)).rejects.toThrow("no longer exists")
    }
    expect(values).toEqual(before)
    expect(local.set).not.toHaveBeenCalled()
  })

  test("serializes concurrent imports across instances and requests an exclusive browser lock", async () => {
    const { store } = environment()
    const request = vi.fn(
      async (_name: string, _options: unknown, operation: () => Promise<unknown>) => operation(),
    )
    vi.stubGlobal("navigator", { locks: { request } })
    await Promise.all([
      store.import(skill("first")),
      new SkillStore().import(skill("second")),
      store.import(skill("third")),
    ])
    expect((await store.list()).map((item) => item.name)).toEqual(["first", "second", "third"])
    expect(request).toHaveBeenCalledTimes(3)
    expect(request.mock.calls[0]?.[1]).toEqual({ mode: "exclusive" })
  })

  test("serializes colliding names and concurrent replace/enable/remove operations", async () => {
    const { store } = environment()
    const collision = await Promise.allSettled([
      store.import(skill()),
      new SkillStore().import(skill()),
    ])
    expect(collision.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"])
    const [saved] = await store.list()
    if (!saved) throw new Error("Missing skill")
    await Promise.all([
      store.setEnabled(saved.id, true),
      new SkillStore().replace(saved.id, skill("renamed")),
    ])
    expect((await store.list())[0]).toMatchObject({ name: "renamed", enabled: false })
    const result = await Promise.allSettled([
      store.remove(saved.id),
      store.replace(saved.id, skill("too-late")),
    ])
    expect(result.map((item) => item.status)).toEqual(["fulfilled", "rejected"])
    expect(await store.list()).toEqual([])
  })

  test.each(["enable", "replace", "remove"])(
    "rejects a stale reviewed record atomically during %s",
    async (operation) => {
      const { store, values, local } = environment()
      const reviewed = await store.import(skill())
      // A competing update enters the same lock queue before this reviewed action.
      const replacement = store.replace(reviewed.id, skill("review-page", "Unreviewed body"))
      const pending =
        operation === "enable"
          ? store.setEnabled(reviewed.id, true, reviewed)
          : operation === "replace"
            ? store.replace(reviewed.id, skill("replacement"), reviewed)
            : store.remove(reviewed.id, reviewed)
      const rejected = expect(pending).rejects.toThrow("selected skill changed")
      const latest = await replacement
      await rejected
      expect(await store.list()).toEqual([latest])
      expect(values[SKILLS_STORAGE_KEY]).toEqual(envelope([latest]))
      expect(local.set).toHaveBeenCalledTimes(2)
    },
  )

  test("captures expected review state before waiting and accepts unchanged records", async () => {
    const { store } = environment()
    const reviewed = await store.import(skill())
    const enabling = store.setEnabled(reviewed.id, true, reviewed)
    reviewed.body = "Mutated by the caller after submission"
    await enabling
    const [enabled] = await store.list()
    if (!enabled) throw new Error("Missing skill")
    expect(enabled.enabled).toBe(true)
    const replaced = await store.replace(enabled.id, skill("replacement"), enabled)
    await store.remove(replaced.id, replaced)
    expect(await store.list()).toEqual([])
  })

  test("captures import and replacement content before waiting for the write lock", async () => {
    const { store } = environment()
    const input = skill()
    const importing = store.import(input)
    input.body = "Mutated after validation"
    const saved = await importing
    expect(saved.body).toBe(skill().body)
    const replacement = skill("replacement")
    const replacing = store.replace(saved.id, replacement)
    replacement.name = "mutated-after-validation"
    expect((await replacing).name).toBe("replacement")
  })

  test("all failed writes leave previous records intact and later queued writes still work", async () => {
    const { store, values, local } = environment()
    const saved = await store.import(skill())
    await store.setEnabled(saved.id, true)
    const before = structuredClone(values)
    for (const operation of [
      () => store.import(skill("new-skill")),
      () => store.replace(saved.id, skill("replacement")),
      () => store.setEnabled(saved.id, false),
      () => store.remove(saved.id),
    ]) {
      local.set.mockRejectedValueOnce(new Error("Disk full"))
      await expect(operation()).rejects.toThrow("Disk full")
      expect(values).toEqual(before)
      expect(await store.list()).toEqual([{ ...saved, enabled: true }])
    }
    local.set.mockRejectedValueOnce(new Error("Disk full"))
    const results = await Promise.allSettled([
      store.import(skill("failed")),
      store.import(skill("succeeds")),
    ])
    expect(results.map((result) => result.status)).toEqual(["rejected", "fulfilled"])
    expect((await store.list()).map((item) => item.name)).toEqual(["review-page", "succeeds"])
  })

  test("propagates read failures without writes", async () => {
    const { store, local } = environment()
    local.get.mockRejectedValueOnce(new Error("Storage unavailable"))
    await expect(store.import(skill())).rejects.toThrow("Storage unavailable")
    expect(local.set).not.toHaveBeenCalled()
  })

  test.each([
    null,
    false,
    [],
    {},
    { version: 2, records: [] },
    { version: 1, records: {} },
    { version: 1, records: [], unknown: true },
    { version: 1, records: [null] },
    envelope([record(1, { id: "__proto__" })]),
    envelope([record(1, { id: "constructor" })]),
    envelope([record(1, { id: `${id(1)}\n` })]),
    envelope([record(1, { name: "valid-name\n" })]),
    envelope([record(1, { name: "Bad Name" })]),
    envelope([record(1, { name: "a".repeat(65) })]),
    envelope([record(1, { description: "" })]),
    envelope([record(1, { description: "x".repeat(513) })]),
    envelope([record(1, { description: "bad\nline" })]),
    envelope([record(1, { description: "bad\ud800" })]),
    envelope([record(1, { body: "" })]),
    envelope([record(1, { body: "bad\u0000body" })]),
    envelope([record(1, { body: "bad\udfffbody" })]),
    envelope([record(1, { body: "x".repeat(SKILL_LIMITS.inputBytes) })]),
    envelope([record(1, { body: "猫".repeat(22000) })]),
    envelope([record(1), record(1, { name: "different-name" })]),
    envelope([record(1), record(2, { name: "skill-1" })]),
    envelope([record(1, { enabled: "yes" as unknown as boolean })]),
    envelope([{ ...record(1), unknown: true } as SkillRecord]),
    envelope(Array.from({ length: 21 }, (_, i) => record(i))),
    JSON.parse('{"version":1,"records":[],"__proto__":{"polluted":true}}'),
  ])("rejects corrupt persisted data without silent deletion: %#", async (corrupt) => {
    const { store, values, local } = environment()
    values[SKILLS_STORAGE_KEY] = corrupt
    const before = structuredClone(values)
    await expect(store.list()).rejects.toThrow("Saved skill storage is invalid")
    await expect(store.import(skill())).rejects.toThrow("Saved skill storage is invalid")
    await expect(store.replace(id(1), skill())).rejects.toThrow("Saved skill storage is invalid")
    await expect(store.setEnabled(id(1), false)).rejects.toThrow("Saved skill storage is invalid")
    await expect(store.remove(id(1))).rejects.toThrow("Saved skill storage is invalid")
    expect(values).toEqual(before)
    expect(local.set).not.toHaveBeenCalled()
  })

  test("rejects inherited fields, accessors, and prototype keys without reading getters", async () => {
    const { store, values, local } = environment()
    const getter = vi.fn(() => 1)
    for (const corrupt of [
      Object.create({ version: 1, records: [] }),
      { version: 1, records: [Object.create(record())] },
      Object.defineProperty({ records: [] }, "version", { enumerable: true, get: getter }),
      envelope([JSON.parse(`{"__proto__":{},${JSON.stringify(record()).slice(1)}`)]),
    ]) {
      values[SKILLS_STORAGE_KEY] = corrupt
      await expect(store.list()).rejects.toThrow("invalid")
      await expect(store.import(skill())).rejects.toThrow("invalid")
      expect(values[SKILLS_STORAGE_KEY]).toBe(corrupt)
    }
    expect(getter).not.toHaveBeenCalled()
    expect(local.set).not.toHaveBeenCalled()
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false)
  })

  test("rejects sparse arrays, inherited array entries, extra keys, and accessor entries", async () => {
    const { store, values, local } = environment()
    const getter = vi.fn(() => record())
    const inherited = new Array<SkillRecord>(1)
    Object.setPrototypeOf(inherited, [record()])
    const accessor: SkillRecord[] = []
    Object.defineProperty(accessor, "0", { enumerable: true, get: getter })
    const extra = Object.assign([record()], { unexpected: true })
    for (const records of [new Array<SkillRecord>(1), inherited, accessor, extra]) {
      values[SKILLS_STORAGE_KEY] = envelope(records)
      await expect(store.list()).rejects.toThrow("invalid")
      await expect(store.import(skill())).rejects.toThrow("invalid")
    }
    expect(getter).not.toHaveBeenCalled()
    expect(local.set).not.toHaveBeenCalled()
  })

  test("prototype property names do not collide with object internals", async () => {
    const { store } = environment()
    for (const name of ["constructor", "prototype", "tostring"]) await store.import(skill(name))
    expect((await store.list()).map((item) => item.name)).toEqual([
      "constructor",
      "prototype",
      "tostring",
    ])
  })

  test("validates input metadata, Unicode, body, and enabled state before any write", async () => {
    const { store, local } = environment()
    const saved = await store.import(skill())
    local.set.mockClear()
    for (const bad of [
      skill("Bad Name"),
      skill("a".repeat(65)),
      skill("valid", ""),
      skill("valid", "bad\u0000body"),
      skill("valid", "Body", ""),
      skill("valid", "Body", "bad\ud800"),
      skill("valid", "x".repeat(SKILL_LIMITS.inputBytes)),
      skill("valid", "Body", "猫".repeat(513)),
    ]) {
      await expect(store.import(bad)).rejects.toThrow()
      await expect(store.replace(saved.id, bad)).rejects.toThrow()
    }
    await expect(store.setEnabled(saved.id, "yes" as unknown as boolean)).rejects.toThrow("boolean")
    expect(local.set).not.toHaveBeenCalled()
  })

  test("enforces installed limits for concurrent imports and allows replacement at the limit", async () => {
    const { store } = environment()
    for (let i = 0; i < SKILL_LIMITS.installed - 1; i++) await store.import(skill(`skill-${i}`))
    const results = await Promise.allSettled([
      store.import(skill("last")),
      store.import(skill("too-many")),
    ])
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"])
    expect(await store.list()).toHaveLength(20)
    const first = (await store.list())[0]
    if (!first) throw new Error("Missing skill")
    await expect(store.replace(first.id, skill("replacement"))).resolves.toMatchObject({
      id: first.id,
    })
  })

  test("enforces exact serialized storage byte boundary, including JSON overhead", async () => {
    const { store, values, local } = environment()
    const records = Array.from({ length: 9 }, (_, i) => record(i, { body: "a".repeat(58000) }))
    const saved = envelope(records)
    const remaining = SKILL_LIMITS.storageBytes - skillByteLength(JSON.stringify(saved))
    expect(remaining).toBeGreaterThan(0)
    if (!records[0]) throw new Error("Missing skill")
    records[0].body += "a".repeat(remaining)
    values[SKILLS_STORAGE_KEY] = saved
    expect(skillByteLength(JSON.stringify(saved))).toBe(SKILL_LIMITS.storageBytes)
    expect(await store.list()).toHaveLength(9)
    const before = structuredClone(values)
    await expect(store.import(skill("overflow"))).rejects.toThrow("storage exceeds")
    await expect(
      store.replace(records[0].id, skill(records[0].name, `${records[0].body}a`)),
    ).rejects.toThrow("storage exceeds")
    expect(values).toEqual(before)
    expect(local.set).not.toHaveBeenCalled()
    records[0].body += "a"
    await expect(store.list()).rejects.toThrow("invalid")
  })

  test("checks escaped JSON storage size, not only unescaped body bytes", async () => {
    const { store, values } = environment()
    const records = Array.from({ length: 5 }, (_, i) => record(i, { body: '"'.repeat(60000) }))
    values[SKILLS_STORAGE_KEY] = envelope(records)
    await expect(store.list()).rejects.toThrow("invalid")
  })

  test("bounds the enabled catalog on enabling and rejects oversized persisted catalogs", async () => {
    const { store, values, local } = environment()
    const installed: SkillRecord[] = []
    for (let i = 0; i < 12; i++)
      installed.push(await store.import(skill(`skill-${i}`, "Body", "猫".repeat(512))))
    expect(skillCatalog(installed)).toBe("[]")
    let enabled = 0
    while (enabled < installed.length) {
      const next = installed[enabled]
      if (!next) throw new Error("Missing skill")
      const proposed = installed.map((item, i) => ({ ...item, enabled: i <= enabled }))
      if (skillByteLength(skillCatalog(proposed)) > SKILL_LIMITS.catalogBytes) break
      await store.setEnabled(next.id, true)
      enabled++
    }
    expect(enabled).toBeGreaterThan(0)
    expect(enabled).toBeLessThan(installed.length)
    const next = installed[enabled]
    if (!next) throw new Error("Missing skill")
    const before = structuredClone(values)
    local.set.mockClear()
    await expect(store.setEnabled(next.id, true)).rejects.toThrow("catalog exceeds")
    expect(values).toEqual(before)
    expect(local.set).not.toHaveBeenCalled()
    const current = await store.list()
    expect(skillCatalog(current)).not.toContain("Body")
    expect(skillByteLength(skillCatalog(current))).toBeLessThanOrEqual(SKILL_LIMITS.catalogBytes)
    values[SKILLS_STORAGE_KEY] = envelope(current.map((item) => ({ ...item, enabled: true })))
    await expect(store.list()).rejects.toThrow("invalid")
    await expect(store.setEnabled(next.id, false)).rejects.toThrow("invalid")
  })

  test("catalog includes only enabled IDs and metadata with safe JSON escaping", () => {
    expect(
      skillCatalog([record(1, { enabled: true, description: 'Quotes " and <tags>' }), record(2)]),
    ).toBe(JSON.stringify([{ id: id(1), name: "skill-1", description: 'Quotes " and <tags>' }]))
  })
})
