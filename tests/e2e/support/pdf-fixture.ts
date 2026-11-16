import { createHash } from "node:crypto"

/** Owned fixtures generated at test time. Encryption is a test of PDF.js, not production crypto. */
function assemble(objects: string[], trailer = ""): Buffer {
  let pdf = "%PDF-1.7\n"
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf, "latin1"))
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = Buffer.byteLength(pdf, "latin1")
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailer} >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf, "latin1")
}
const quote = (text: string) => text.replace(/([\\()])/g, "\\$1")
const stream = (text: string) => `BT /F1 12 Tf 40 720 Td (${quote(text)}) Tj ET`
const font = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
const page = (contents: number, fontId: number) =>
  `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 800 800] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contents} 0 R >>`
const content = (body: string) =>
  `<< /Length ${Buffer.byteLength(body, "latin1")} >>\nstream\n${body}\nendstream`
export function pdfFixture(
  text = "A reliable browser PDF reader keeps the original selectable while translating this sufficiently long paragraph.",
): Buffer {
  return assemble([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    page(5, 4),
    font,
    content(stream(text)),
  ])
}
export function pdfPages(texts: string[]): Buffer {
  const fontId = 3 + texts.length * 2
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${texts.map((_text, index) => `${3 + index * 2} 0 R`).join(" ")}] /Count ${texts.length} >>`,
  ]
  for (const [index, text] of texts.entries())
    objects.push(
      page(4 + index * 2, fontId),
      content(stream(text).replace("40 720 Td", "40 600 Td")),
    )
  objects.push(font)
  return assemble(objects)
}
const padding = Buffer.from(
  "28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a",
  "hex",
)
const padded = (password: string) =>
  Buffer.concat([Buffer.from(password, "latin1"), padding]).subarray(0, 32)
const md5 = (value: Buffer) => createHash("md5").update(value).digest()
function byte(values: Uint8Array, index: number): number {
  const value = values[index]
  if (value === undefined) throw new RangeError("Invalid fixture byte offset")
  return value
}
function rc4(key: Buffer, input: Buffer): Buffer {
  const state = Uint8Array.from({ length: 256 }, (_value, index) => index)
  let j = 0
  for (let i = 0; i < 256; i++) {
    j = (j + byte(state, i) + byte(key, i % key.length)) % 256
    const previous = byte(state, i)
    state[i] = byte(state, j)
    state[j] = previous
  }
  const result = Buffer.alloc(input.length)
  let i = 0
  j = 0
  for (let offset = 0; offset < input.length; offset++) {
    i = (i + 1) % 256
    j = (j + byte(state, i)) % 256
    const previous = byte(state, i)
    state[i] = byte(state, j)
    state[j] = previous
    result[offset] = byte(input, offset) ^ byte(state, (byte(state, i) + byte(state, j)) % 256)
  }
  return result
}
export function encryptedPdf(password: string): Buffer {
  const owner = rc4(md5(padded("owned-fixture-owner")).subarray(0, 5), padded(password))
  const id = md5(Buffer.from("owned-fixture-document-id"))
  const permissions = Buffer.alloc(4)
  permissions.writeInt32LE(-4)
  const key = md5(Buffer.concat([padded(password), owner, permissions, id])).subarray(0, 5)
  const user = rc4(key, padding)
  const objectKey = md5(Buffer.concat([key, Buffer.from([5, 0, 0, 0, 0])])).subarray(0, 10)
  const body = rc4(
    objectKey,
    Buffer.from(
      stream(
        "An encrypted owned document keeps its password local and its original text selectable.",
      ),
    ),
  ).toString("latin1")
  return assemble(
    [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      page(5, 4),
      font,
      content(body),
      `<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${owner.toString("hex")}> /U <${user.toString("hex")}> /P -4 >>`,
    ],
    `/Encrypt 6 0 R /ID [<${id.toString("hex")}><${id.toString("hex")}>]`,
  )
}
