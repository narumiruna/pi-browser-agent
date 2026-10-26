import { afterEach, describe, expect, test } from "vitest"
import { setLanguagePreference, t } from "../../src/browser/i18n/index.js"
import {
  escapeRestoredPrompt,
  getSlashCommandMatches,
  parseSlashCommand,
  SLASH_COMMANDS,
} from "../../src/browser/sidepanel/slash-commands.js"

afterEach(() => setLanguagePreference("en"))

describe("parseSlashCommand", () => {
  test("localizes errors without translating tokens, arguments, or descriptors", () => {
    setLanguagePreference("ja")
    expect(parseSlashCommand("/unknown secret")).toEqual({
      kind: "invalid",
      error: t("Unknown slash command."),
    })
    expect(t("Unknown slash command.")).not.toBe("Unknown slash command.")
    expect(parseSlashCommand("/new secret")).toEqual({
      kind: "invalid",
      error: t("This slash command does not accept arguments."),
    })
    expect(parseSlashCommand("/name first\nsecond")).toEqual({
      kind: "invalid",
      error: t("Slash commands must use a single line."),
    })
    expect(parseSlashCommand("/name My title")).toEqual({
      kind: "command",
      name: "name",
      argument: "My title",
    })
    expect(SLASH_COMMANDS[0].description).toBe("Start a new session")
  })

  test.each(SLASH_COMMANDS)("recognizes /$name", ({ name }) => {
    expect(parseSlashCommand(`/${name}`)).toEqual({ kind: "command", name, argument: "" })
    expect(parseSlashCommand(` \t/${name} \t `)).toEqual({ kind: "command", name, argument: "" })
  })

  test("accepts and trims only the name argument, preserving internal spaces", () => {
    expect(parseSlashCommand("  /name \t My  session title \t ")).toEqual({
      kind: "command",
      name: "name",
      argument: "My  session title",
    })
    expect(parseSlashCommand("/name /tmp/file")).toEqual({
      kind: "command",
      name: "name",
      argument: "/tmp/file",
    })
  })

  test.each(SLASH_COMMANDS.filter((command) => !command.acceptsArgument))(
    "rejects arguments for /$name without including them in the error",
    ({ name }) => {
      const result = parseSlashCommand(`/${name} secret-provider-token`)
      expect(result).toEqual({
        kind: "invalid",
        error: "This slash command does not accept arguments.",
      })
      expect(JSON.stringify(result)).not.toContain("secret-provider-token")
    },
  )

  test.each(["/unknown", "/new-session", "/compact secret", "/login-secret secret"])(
    "rejects the unknown command %s without echoing text",
    (input) => {
      expect(parseSlashCommand(input)).toEqual({ kind: "invalid", error: "Unknown slash command." })
    },
  )

  test.each([
    "/name first\nsecond",
    "/name first\rsecond",
    "/new\r\n/login",
    "/name first\u2028second",
    "/name first\u2029second",
    "/new\n",
    "\n/new",
  ])("rejects multiline command input %j", (input) => {
    expect(parseSlashCommand(input)).toEqual({
      kind: "invalid",
      error: "Slash commands must use a single line.",
    })
  })

  test.each([
    "",
    " \t ",
    " / ",
    "/",
    "hello /new",
    "/tmp/file",
    "  /tmp/file with spaces  ",
    "/new/path",
    "/new.txt",
    "/new?query",
    "/new#anchor",
    "/new123",
    "/NEW",
    "/newSession",
    "/123",
    "/名前",
    "ordinary\n/new",
  ])("preserves ordinary prompt text %j", (input) => {
    expect(parseSlashCommand(input)).toEqual({ kind: "prompt", text: input })
  })

  test.each([
    ["//new", "/new"],
    ["  //name  literal text  ", "  /name  literal text  "],
    ["\n\t//login secret\nsecond line\n", "\n\t/login secret\nsecond line\n"],
    ["///new", "//new"],
    ["//", "/"],
    ["//tmp/file", "/tmp/file"],
  ])("removes only the first slash from explicit escape %j", (input, text) => {
    expect(parseSlashCommand(input)).toEqual({ kind: "escaped", text })
  })
})

describe("restored literal prompts", () => {
  test.each([
    ["/logout", "//logout"],
    ["//logout", "///logout"],
    ["  /tree text", "  //tree text"],
    ["/tmp/file", "//tmp/file"],
    ["\n/name first\nsecond", "\n//name first\nsecond"],
    ["ordinary /tree", "ordinary /tree"],
    ["", ""],
  ])("restores %j as literal model text", (text, draft) => {
    expect(escapeRestoredPrompt(text)).toBe(draft)
    const result = parseSlashCommand(draft)
    expect(result.kind).toBe(text.trimStart().startsWith("/") ? "escaped" : "prompt")
    expect("text" in result && result.text).toBe(text)
  })
})

describe("slash command definitions and matching", () => {
  test("defines the supported commands and their argument rules", () => {
    expect(SLASH_COMMANDS.map((command) => command.name)).toEqual([
      "new",
      "resume",
      "tree",
      "name",
      "settings",
      "login",
      "logout",
    ])
    expect(
      SLASH_COMMANDS.filter((command) => command.acceptsArgument).map((item) => item.name),
    ).toEqual(["name"])
    expect(SLASH_COMMANDS.every((command) => command.description.length > 0)).toBe(true)
  })

  test.each([
    ["", ["new", "resume", "tree", "name", "settings", "login", "logout"]],
    ["n", ["new", "name"]],
    ["lo", ["login", "logout"]],
    ["resume", ["resume"]],
    ["missing", []],
    ["N", []],
    ["/n", []],
  ])("matches the lowercase name prefix %j", (prefix, names) => {
    expect(getSlashCommandMatches(prefix as string).map((command) => command.name)).toEqual(names)
  })
})
