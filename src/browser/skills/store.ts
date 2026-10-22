import { withExclusiveStorageWrite } from "../storage-lock.js"
import { type ParsedSkill, SKILL_LIMITS, skillByteLength, validateSkillContent } from "./format.js"

export const SKILLS_STORAGE_KEY = "piBrowserAgentSkillsV1"
const LOCK = "pi-browser-agent-skills-write"
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/

export interface SkillRecord {
  id: string
  name: string
  description: string
  body: string
  enabled: boolean
}

/** Exact catalog serialization shared with runtime; the budget excludes fixed instructions. */
export function skillCatalog(
  records: readonly Pick<SkillRecord, "id" | "name" | "description" | "enabled">[],
): string {
  return JSON.stringify(
    records
      .filter((record) => record.enabled)
      .map(({ id, name, description }) => ({ id, name, description })),
  )
}

function ownFields(value: unknown, fields: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  const keys = Reflect.ownKeys(value)
  return (
    keys.length === fields.length &&
    keys.every((key) => typeof key === "string" && fields.includes(key)) &&
    fields.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value")
    })
  )
}

function envelope(records: SkillRecord[]): { version: 1; records: SkillRecord[] } {
  return { version: 1, records }
}

function validateBudgets(records: SkillRecord[]): void {
  if (records.length > SKILL_LIMITS.installed) {
    throw new Error(`Installed skill limit is ${SKILL_LIMITS.installed}`)
  }
  if (skillByteLength(JSON.stringify(envelope(records))) > SKILL_LIMITS.storageBytes) {
    throw new Error(`Skill storage exceeds the ${SKILL_LIMITS.storageBytes}-byte limit`)
  }
  if (skillByteLength(skillCatalog(records)) > SKILL_LIMITS.catalogBytes) {
    throw new Error(`Enabled skill catalog exceeds the ${SKILL_LIMITS.catalogBytes}-byte limit`)
  }
}

function recordsFrom(value: unknown): SkillRecord[] {
  if (value === undefined) return []
  try {
    if (
      !ownFields(value, ["version", "records"]) ||
      value.version !== 1 ||
      !Array.isArray(value.records)
    ) {
      throw new Error("Unsupported envelope")
    }
    if (value.records.length > SKILL_LIMITS.installed) throw new Error("Too many records")
    if (
      Object.getPrototypeOf(value.records) !== Array.prototype ||
      Reflect.ownKeys(value.records).length !== value.records.length + 1
    ) {
      throw new Error("Invalid records array")
    }
    const ids = new Set<string>()
    const names = new Set<string>()
    const records: SkillRecord[] = []
    for (let index = 0; index < value.records.length; index++) {
      const entry = Object.getOwnPropertyDescriptor(value.records, String(index))
      if (!entry?.enumerable || !Object.hasOwn(entry, "value")) {
        throw new Error("Invalid record entry")
      }
      const item: unknown = entry.value
      if (
        !ownFields(item, ["id", "name", "description", "body", "enabled"]) ||
        typeof item.id !== "string" ||
        item.id.length !== 36 ||
        !uuid.test(item.id) ||
        typeof item.name !== "string" ||
        typeof item.description !== "string" ||
        typeof item.body !== "string" ||
        typeof item.enabled !== "boolean" ||
        ids.has(item.id) ||
        names.has(item.name)
      ) {
        throw new Error("Invalid or duplicate record")
      }
      const record: SkillRecord = {
        id: item.id,
        name: item.name,
        description: item.description,
        body: item.body,
        enabled: item.enabled,
      }
      validateSkillContent(record)
      ids.add(record.id)
      names.add(record.name)
      records.push(record)
    }
    validateBudgets(records)
    return records
  } catch {
    throw new Error("Saved skill storage is invalid or exceeds limits; no records were changed")
  }
}

function contentFrom(skill: ParsedSkill): Pick<SkillRecord, "name" | "description" | "body"> {
  const content = { name: skill.name, description: skill.description, body: skill.body }
  validateSkillContent(content)
  return content
}

function requiredRecord(records: SkillRecord[], id: string, expected?: SkillRecord): SkillRecord {
  const record = records.find((item) => item.id === id)
  if (!record) throw new Error("Skill no longer exists")
  if (
    expected &&
    (record.id !== expected.id ||
      record.name !== expected.name ||
      record.description !== expected.description ||
      record.body !== expected.body ||
      record.enabled !== expected.enabled)
  ) {
    throw new Error("The selected skill changed. Select and review it again.")
  }
  return record
}

/** No cached mutable state: each locked update reads and validates the latest envelope. */
export class SkillStore {
  async list(): Promise<SkillRecord[]> {
    const stored = await chrome.storage.local.get(SKILLS_STORAGE_KEY)
    return recordsFrom(stored[SKILLS_STORAGE_KEY])
  }

  async import(skill: ParsedSkill): Promise<SkillRecord> {
    const content = contentFrom(skill)
    return withExclusiveStorageWrite(LOCK, async () => {
      const records = await this.list()
      if (records.some((record) => record.name === content.name)) {
        throw new Error("A skill with this name is already installed; use explicit replacement")
      }
      const record: SkillRecord = { id: crypto.randomUUID(), ...content, enabled: false }
      if (records.some((item) => item.id === record.id)) throw new Error("Duplicate skill ID")
      await this.save([...records, record])
      return { ...record }
    })
  }

  async replace(id: string, skill: ParsedSkill, expected?: SkillRecord): Promise<SkillRecord> {
    const content = contentFrom(skill)
    const reviewed = expected && { ...expected }
    return withExclusiveStorageWrite(LOCK, async () => {
      const records = await this.list()
      requiredRecord(records, id, reviewed)
      if (records.some((record) => record.id !== id && record.name === content.name)) {
        throw new Error("A skill with this name is already installed")
      }
      const record: SkillRecord = { id, ...content, enabled: false }
      await this.save(records.map((item) => (item.id === id ? record : item)))
      return { ...record }
    })
  }

  async setEnabled(id: string, enabled: boolean, expected?: SkillRecord): Promise<void> {
    if (typeof enabled !== "boolean") throw new Error("Skill enabled state must be a boolean")
    const reviewed = expected && { ...expected }
    await withExclusiveStorageWrite(LOCK, async () => {
      const records = await this.list()
      requiredRecord(records, id, reviewed).enabled = enabled
      await this.save(records)
    })
  }

  async remove(id: string, expected?: SkillRecord): Promise<void> {
    const reviewed = expected && { ...expected }
    await withExclusiveStorageWrite(LOCK, async () => {
      const records = await this.list()
      requiredRecord(records, id, reviewed)
      await this.save(records.filter((record) => record.id !== id))
    })
  }

  private async save(records: SkillRecord[]): Promise<void> {
    validateBudgets(records)
    // A single key write publishes the complete replacement. Never mutate the read envelope.
    await chrome.storage.local.set({ [SKILLS_STORAGE_KEY]: envelope(records) })
  }
}
