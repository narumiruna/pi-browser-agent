export const SLASH_COMMANDS = [
  { name: "new", description: "Start a new session", acceptsArgument: false },
  { name: "resume", description: "Choose a saved session", acceptsArgument: false },
  { name: "name", description: "Rename the current session", acceptsArgument: true },
  { name: "settings", description: "Open settings", acceptsArgument: false },
  { name: "login", description: "Sign in to a model provider", acceptsArgument: false },
  {
    name: "logout",
    description: "Sign out of the selected model provider",
    acceptsArgument: false,
  },
] as const

export type SlashCommandName = (typeof SLASH_COMMANDS)[number]["name"]

export type SlashCommandResult =
  | { kind: "prompt"; text: string }
  | { kind: "escaped"; text: string }
  | { kind: "command"; name: SlashCommandName; argument: string }
  | { kind: "invalid"; error: string }

export function parseSlashCommand(input: string): SlashCommandResult {
  const trimmed = input.trim()
  if (trimmed.startsWith("//")) {
    const slashIndex = input.indexOf("/")
    return { kind: "escaped", text: input.slice(0, slashIndex) + input.slice(slashIndex + 1) }
  }

  const match = /^\/([a-z-]+)(?=\s|$)/.exec(trimmed)
  if (!match) return { kind: "prompt", text: input }

  const command = SLASH_COMMANDS.find((item) => item.name === match[1])
  if (!command) return { kind: "invalid", error: "Unknown slash command." }
  if (/[\r\n\u2028\u2029]/.test(input)) {
    return { kind: "invalid", error: "Slash commands must use a single line." }
  }

  const argument = trimmed.slice(match[0].length).trim()
  if (argument && !command.acceptsArgument) {
    return { kind: "invalid", error: "This slash command does not accept arguments." }
  }
  return { kind: "command", name: command.name, argument }
}

/** Match the command-name prefix, without its leading slash. */
export function getSlashCommandMatches(prefix: string) {
  return SLASH_COMMANDS.filter((command) => command.name.startsWith(prefix))
}
