import type { ImageContent } from "@earendil-works/pi-ai"
import { imageContentSource, MAX_PASTED_IMAGE_BYTES } from "./images.js"

export const ANNOTATION_LIMITS = {
  maxSourceDimension: 16_384,
  maxSourcePixels: 64_000_000,
  maxCanvasDimension: 4_096,
  maxCanvasPixels: 16_000_000,
  maxStrokes: 256,
  maxPointsPerStroke: 4_096,
  maxTotalPoints: 8_192,
  minPenWidth: 2,
  maxPenWidth: 32,
  defaultPenWidth: 8,
} as const

export interface AnnotationPoint {
  x: number
  y: number
}

export interface AnnotationStroke {
  points: AnnotationPoint[]
  width: number
}

export function pngDimensions(base64: string): { height: number; width: number } | undefined {
  if (base64.length < 32) return undefined
  let header: string
  try {
    header = atob(base64.slice(0, 32))
  } catch {
    return undefined
  }
  const signature = "\x89PNG\r\n\x1a\n"
  if (header.length < 24 || header.slice(0, 8) !== signature || header.slice(12, 16) !== "IHDR")
    return undefined
  const readUint32 = (offset: number): number =>
    ((header.charCodeAt(offset) << 24) |
      (header.charCodeAt(offset + 1) << 16) |
      (header.charCodeAt(offset + 2) << 8) |
      header.charCodeAt(offset + 3)) >>>
    0
  const width = readUint32(16)
  const height = readUint32(20)
  return width > 0 && height > 0 ? { width, height } : undefined
}

export function annotationCanvasSize(
  width: number,
  height: number,
): {
  height: number
  width: number
} {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > ANNOTATION_LIMITS.maxSourceDimension ||
    height > ANNOTATION_LIMITS.maxSourceDimension ||
    width * height > ANNOTATION_LIMITS.maxSourcePixels
  ) {
    throw new Error("The screenshot dimensions are too large to annotate safely")
  }
  const scale = Math.min(
    1,
    ANNOTATION_LIMITS.maxCanvasDimension / width,
    ANNOTATION_LIMITS.maxCanvasDimension / height,
    Math.sqrt(ANNOTATION_LIMITS.maxCanvasPixels / (width * height)),
  )
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  }
}

export function canvasPoint(
  clientX: number,
  clientY: number,
  rectangle: Pick<DOMRect, "height" | "left" | "top" | "width">,
  canvasWidth: number,
  canvasHeight: number,
): AnnotationPoint {
  if (rectangle.width <= 0 || rectangle.height <= 0) throw new Error("Canvas is not visible")
  return {
    x: Math.max(
      0,
      Math.min(canvasWidth, ((clientX - rectangle.left) / rectangle.width) * canvasWidth),
    ),
    y: Math.max(
      0,
      Math.min(canvasHeight, ((clientY - rectangle.top) / rectangle.height) * canvasHeight),
    ),
  }
}

export class AnnotationHistory {
  readonly strokes: AnnotationStroke[] = []
  private active?: AnnotationStroke
  private pointCount = 0

  get points(): number {
    return this.pointCount
  }

  get drawing(): boolean {
    return this.active !== undefined
  }

  start(point: AnnotationPoint, width: number): boolean {
    if (
      this.active ||
      this.strokes.length >= ANNOTATION_LIMITS.maxStrokes ||
      this.pointCount >= ANNOTATION_LIMITS.maxTotalPoints ||
      !Number.isFinite(point.x) ||
      !Number.isFinite(point.y) ||
      !Number.isFinite(width)
    ) {
      return false
    }
    const boundedWidth = Math.max(
      ANNOTATION_LIMITS.minPenWidth,
      Math.min(ANNOTATION_LIMITS.maxPenWidth, width),
    )
    this.active = { points: [point], width: boundedWidth }
    this.strokes.push(this.active)
    this.pointCount += 1
    return true
  }

  append(point: AnnotationPoint): boolean {
    const points = this.active?.points
    if (
      !points ||
      points.length >= ANNOTATION_LIMITS.maxPointsPerStroke ||
      this.pointCount >= ANNOTATION_LIMITS.maxTotalPoints ||
      !Number.isFinite(point.x) ||
      !Number.isFinite(point.y)
    ) {
      return false
    }
    const previous = points.at(-1)
    if (previous && previous.x === point.x && previous.y === point.y) return false
    points.push(point)
    this.pointCount += 1
    return true
  }

  finish(): void {
    this.active = undefined
  }

  undo(): void {
    this.finish()
    this.pointCount -= this.strokes.pop()?.points.length ?? 0
  }

  clear(): void {
    this.finish()
    this.strokes.length = 0
    this.pointCount = 0
  }
}

export function canvasPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error("Chrome could not export the annotated screenshot"))
          return
        }
        if (blob.type !== "image/png") {
          reject(new Error("Chrome did not export a PNG annotation"))
          return
        }
        if (blob.size === 0 || blob.size > MAX_PASTED_IMAGE_BYTES) {
          reject(new Error("The annotated screenshot must use 3 MB or less"))
          return
        }
        resolve(blob)
      }, "image/png")
    } catch (error) {
      reject(error instanceof Error ? error : new Error("Unable to export the annotation"))
    }
  })
}

interface ScreenshotAnnotationOptions {
  onAttach: (image: Blob) => Promise<void>
}

export class ScreenshotAnnotationController {
  private readonly dialog: HTMLDialogElement
  private readonly canvas: HTMLCanvasElement
  private readonly widthInput: HTMLInputElement
  private readonly undoButton: HTMLButtonElement
  private readonly clearButton: HTMLButtonElement
  private readonly attachButton: HTMLButtonElement
  private readonly cancelButton: HTMLButtonElement
  private readonly errorOutput: HTMLElement
  private readonly history = new AnnotationHistory()
  private source?: HTMLImageElement
  private pointerId?: number
  private opening = 0
  private attaching = false

  constructor(private readonly options: ScreenshotAnnotationOptions) {
    this.dialog = requiredElement("screenshot-annotation-dialog")
    this.canvas = requiredElement("screenshot-annotation-canvas")
    this.widthInput = requiredElement("annotation-pen-width")
    this.undoButton = requiredElement("annotation-undo")
    this.clearButton = requiredElement("annotation-clear")
    this.attachButton = requiredElement("annotation-attach")
    this.cancelButton = requiredElement("annotation-cancel")
    this.errorOutput = requiredElement("annotation-error")

    this.canvas.addEventListener("pointerdown", (event) => this.startStroke(event))
    this.canvas.addEventListener("pointermove", (event) => this.extendStroke(event))
    this.canvas.addEventListener("pointerup", (event) => this.finishStroke(event))
    this.canvas.addEventListener("pointercancel", (event) => this.finishStroke(event))
    this.widthInput.addEventListener("input", () => this.updateControls())
    this.undoButton.addEventListener("click", () => {
      this.history.undo()
      this.redraw()
    })
    this.clearButton.addEventListener("click", () => {
      this.history.clear()
      this.redraw()
    })
    this.cancelButton.addEventListener("click", () => this.close())
    this.attachButton.addEventListener("click", () => void this.attach())
    this.dialog.addEventListener("cancel", (event) => {
      if (this.attaching) event.preventDefault()
    })
    this.dialog.addEventListener("close", () => this.reset())
  }

  async open(image: ImageContent): Promise<void> {
    const operation = ++this.opening
    this.reset()
    this.errorOutput.textContent = ""
    this.attachButton.disabled = true
    if (!this.dialog.open) this.dialog.showModal()
    try {
      if (image.mimeType.toLowerCase() !== "image/png") {
        throw new Error("Only viewport PNG screenshots can be annotated")
      }
      const source = imageContentSource(image)
      const dimensions = pngDimensions(image.data)
      if (!source || !dimensions) throw new Error("The screenshot image is invalid")
      const canvasSize = annotationCanvasSize(dimensions.width, dimensions.height)
      const loaded = new Image()
      loaded.src = source
      await loaded.decode()
      if (operation !== this.opening || !this.dialog.open) return
      if (loaded.naturalWidth !== dimensions.width || loaded.naturalHeight !== dimensions.height) {
        throw new Error("The screenshot dimensions are inconsistent")
      }
      this.source = loaded
      this.canvas.width = canvasSize.width
      this.canvas.height = canvasSize.height
      this.redraw()
    } catch (error) {
      if (operation === this.opening && this.dialog.open) {
        this.errorOutput.textContent = error instanceof Error ? error.message : String(error)
      }
    }
  }

  close(): void {
    this.opening += 1
    if (this.dialog.open) this.dialog.close()
    else this.reset()
  }

  private point(event: PointerEvent): AnnotationPoint {
    return canvasPoint(
      event.clientX,
      event.clientY,
      this.canvas.getBoundingClientRect(),
      this.canvas.width,
      this.canvas.height,
    )
  }

  private startStroke(event: PointerEvent): void {
    if (this.attaching || !this.source || this.pointerId !== undefined || event.button !== 0) return
    event.preventDefault()
    const rectangle = this.canvas.getBoundingClientRect()
    const displayScale = rectangle.width > 0 ? this.canvas.width / rectangle.width : 1
    const width = Number.parseFloat(this.widthInput.value) * displayScale
    if (!this.history.start(this.point(event), width)) {
      this.errorOutput.textContent = `An annotation can contain at most ${ANNOTATION_LIMITS.maxStrokes} strokes`
      return
    }
    this.pointerId = event.pointerId
    this.canvas.setPointerCapture(event.pointerId)
    this.redraw()
  }

  private extendStroke(event: PointerEvent): void {
    if (event.pointerId !== this.pointerId || !this.history.drawing) return
    event.preventDefault()
    if (!this.history.append(this.point(event))) {
      if (this.history.points >= ANNOTATION_LIMITS.maxTotalPoints) {
        this.errorOutput.textContent = "This annotation reached its total point limit"
      } else if (
        this.history.strokes.at(-1)?.points.length === ANNOTATION_LIMITS.maxPointsPerStroke
      ) {
        this.errorOutput.textContent = "This stroke reached its point limit; start another stroke"
      }
      return
    }
    this.redraw()
  }

  private finishStroke(event: PointerEvent): void {
    if (event.pointerId !== this.pointerId) return
    event.preventDefault()
    if (this.canvas.hasPointerCapture(event.pointerId))
      this.canvas.releasePointerCapture(event.pointerId)
    this.pointerId = undefined
    this.history.finish()
    this.redraw()
  }

  private redraw(): void {
    const context = this.canvas.getContext("2d")
    if (!context || !this.source) {
      this.updateControls()
      return
    }
    context.clearRect(0, 0, this.canvas.width, this.canvas.height)
    context.drawImage(this.source, 0, 0, this.canvas.width, this.canvas.height)
    context.strokeStyle = "#ff2d55"
    context.fillStyle = "#ff2d55"
    context.lineCap = "round"
    context.lineJoin = "round"
    for (const stroke of this.history.strokes) {
      const first = stroke.points[0]
      if (!first) continue
      context.lineWidth = stroke.width
      if (stroke.points.length === 1) {
        context.beginPath()
        context.arc(first.x, first.y, stroke.width / 2, 0, Math.PI * 2)
        context.fill()
        continue
      }
      context.beginPath()
      context.moveTo(first.x, first.y)
      for (let index = 1; index < stroke.points.length; index += 1) {
        const point = stroke.points[index]
        if (point) context.lineTo(point.x, point.y)
      }
      context.stroke()
    }
    this.updateControls()
  }

  private updateControls(): void {
    const hasStrokes = this.history.strokes.length > 0
    this.widthInput.disabled = this.attaching
    this.undoButton.disabled = this.attaching || !hasStrokes
    this.clearButton.disabled = this.attaching || !hasStrokes
    this.cancelButton.disabled = this.attaching
    this.attachButton.disabled = this.attaching || !this.source || !hasStrokes
  }

  private async attach(): Promise<void> {
    if (
      this.attaching ||
      !this.source ||
      this.history.strokes.length === 0 ||
      this.attachButton.disabled
    ) {
      return
    }
    this.attaching = true
    this.errorOutput.textContent = ""
    this.updateControls()
    try {
      await this.options.onAttach(await canvasPng(this.canvas))
      this.close()
    } catch (error) {
      this.attaching = false
      this.errorOutput.textContent = error instanceof Error ? error.message : String(error)
      this.updateControls()
    }
  }

  private reset(): void {
    if (this.pointerId !== undefined && this.canvas.hasPointerCapture(this.pointerId)) {
      this.canvas.releasePointerCapture(this.pointerId)
    }
    this.pointerId = undefined
    this.source = undefined
    this.attaching = false
    this.history.clear()
    this.canvas.width = 1
    this.canvas.height = 1
    this.widthInput.value = String(ANNOTATION_LIMITS.defaultPenWidth)
    this.errorOutput.textContent = ""
    this.updateControls()
  }
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id)
  if (!(value instanceof HTMLElement)) throw new Error(`Missing #${id}`)
  return value as T
}
