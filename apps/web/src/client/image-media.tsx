import * as Dialog from "@radix-ui/react-dialog";
import { useQueryClient } from "@tanstack/react-query";
import { ImageIcon, LoaderCircle, X } from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState, type PropsWithChildren } from "react";
import { imageTarget, readImage } from "@arduano/agent-multiplex-client/browser";
import { type ImageDescriptor, type NativeImageUnavailable, type NativeModel, type SessionRecord } from "@arduano/agent-multiplex-protocol";
import { useApi, errorMessage } from "./api.js";

const ImageSession = createContext<SessionRecord | null>(null);
export function ImageSessionProvider({ session, children }: PropsWithChildren<{ session: SessionRecord | null }>) {
  return <ImageSession.Provider value={session}>{children}</ImageSession.Provider>;
}

export interface TranscriptImage {
  readonly nativeAssetId?: string;
  readonly image?: ImageDescriptor | NativeImageUnavailable;
  readonly path?: string;
  readonly alt?: string;
}

/** External URLs are presentation concerns and never become runtime read requests. */
export function isLocalImagePath(value: string): boolean {
  return value.length > 0 && value === value.trim() && !value.startsWith("//") && !value.includes("\\") && !/[\x00-\x1f\x7f]/.test(value) &&
    !/^[a-z][a-z0-9+.-]*:/i.test(value) && !value.startsWith("#");
}

/** Model facts stay harness-native; unknown discovery never claims support. */
export function modelImageLimits(model: NativeModel | undefined): {
  support: "supported" | "unsupported" | "unknown"; count: number; bytes: number; mediaTypes?: string[];
} {
  const result = { support: "unknown" as "supported" | "unsupported" | "unknown", count: 10, bytes: 10 * 1_024 * 1_024 };
  if (!model) return result;
  const native = object(model.native);
  if (model.harness === "codex") {
    const modalities = native?.inputModalities;
    return Array.isArray(modalities) ? { ...result, support: modalities.includes("image") ? "supported" : "unsupported" } : result;
  }
  const capabilities = object(native?.capabilities);
  const vision = object(capabilities?.limits)?.vision;
  const limits = object(vision);
  const supported = object(capabilities?.supports)?.vision;
  return {
    support: native?.imageSupport === "unknown" ? "unknown" : supported === true ? "supported" : supported === false ? "unsupported" : "unknown",
    count: positiveLimit(limits?.max_prompt_images, result.count),
    bytes: positiveLimit(limits?.max_prompt_image_size, result.bytes),
    ...(Array.isArray(limits?.supported_media_types) ? { mediaTypes: limits.supported_media_types.filter((item): item is string => typeof item === "string") } : {}),
  };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function positiveLimit(value: unknown, maximum: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? Math.min(maximum, value) : maximum;
}

export function TranscriptImagePreview({ sourceKey, image, path, alt = "Image" }: TranscriptImage & { sourceKey: string }) {
  const session = useContext(ImageSession);
  const { client, connectionKey } = useApi();
  const queryClient = useQueryClient();
  const container = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [preview, setPreview] = useState<{ url?: string; error?: string; mediaType?: string }>({});
  const [attempt, setAttempt] = useState(0);
  const imageIdentity = image ? JSON.stringify(image) : "";
  useEffect(() => {
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setVisible(true);
    }, { rootMargin: "160px" });
    if (container.current) observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible || !session || path && !isLocalImagePath(path)) return;
    const abort = new AbortController();
    let objectUrl: string | undefined;
    setPreview({});
    void (async () => {
      if (image && "unavailable" in image) throw new Error(`Image unavailable: ${image.reason}`);
      const runtimes = await queryClient.fetchQuery({ queryKey: ["image-runtimes", connectionKey], queryFn: () => client.runtimeNodes.list.query(), staleTime: 5_000 });
      const runtime = runtimes.find((runtime) => runtime.runtimeNodeId === session.runtimeNodeId);
      if (!runtime) throw new Error("Image runtime is unavailable");
      const target = imageTarget(session, runtime);
      const descriptor = image ?? (path && isLocalImagePath(path)
        ? await client.images.resolvePath.mutate({ ...target, sourceKey, path })
        : undefined);
      if (!descriptor) throw new Error("Unsupported image reference");
      const bytes = await readImage(client, target, descriptor, { signal: abort.signal });
      if (abort.signal.aborted) return;
      // SVG is loaded only in an image context. Never embed its markup, frame it,
      // or open its blob URL as a document; scripts and external resources stay inert.
      objectUrl = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: descriptor.mediaType }));
      setPreview({ url: objectUrl, mediaType: descriptor.mediaType });
    })().catch((error: unknown) => {
      if (!abort.signal.aborted) setPreview({ error: errorMessage(error) });
    });
    return () => { abort.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [client, queryClient, connectionKey, session?.sessionId, session?.bindingRevision, session?.runtimeNodeId, imageIdentity, path, sourceKey, visible, attempt]);

  if (path && !isLocalImagePath(path)) return /^https?:\/\//i.test(path)
    ? <a href={path} rel="noreferrer" target="_blank">{alt || "External image"}</a>
    : <span>{alt}: Unsupported image reference</span>;

  return <span ref={container} className="my-2 block min-w-0 max-w-full" data-testid="transcript-image">
    {preview.url ? <Dialog.Root>
      <Dialog.Trigger className="block max-w-full overflow-hidden rounded-md border border-[var(--border-subtle)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]" aria-label={`Open ${alt}`}>
        <img src={preview.url} alt={alt} className="max-h-72 max-w-full object-contain" onError={() => setPreview({ error: "This image could not be decoded" })} />
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/80" />
        <Dialog.Content className="fixed inset-3 z-50 flex min-h-0 flex-col rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-base)] p-3 sm:inset-8">
          <div className="mb-3 flex items-center gap-3">
            <Dialog.Title className="min-w-0 flex-1 truncate text-sm font-medium">{alt}</Dialog.Title>
            <Dialog.Close className="grid size-11 place-items-center rounded-md hover:bg-[var(--surface-raised)]" aria-label="Close image"><X className="size-5" /></Dialog.Close>
          </div>
          <Dialog.Description className="sr-only">Retained image from this session. Press Escape to close.</Dialog.Description>
          <img src={preview.url} alt={alt} className="min-h-0 flex-1 object-contain" />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root> : preview.error ? <span className="inline-flex max-w-full flex-wrap items-center gap-2 rounded border border-[var(--border-subtle)] p-2 text-xs text-[var(--text-secondary)]" role="status">
      <ImageIcon className="size-4 shrink-0" />{alt}: {preview.error}
      <button className="min-h-9 text-[var(--accent)] underline" onClick={() => setAttempt((value) => value + 1)}>Retry</button>
    </span> : <span className="inline-flex min-h-20 items-center gap-2 text-xs text-[var(--text-secondary)]" role="status"><LoaderCircle className="size-4 animate-spin" />Loading {alt.toLowerCase()}…</span>}
  </span>;
}

/** Client-only SVG conversion for harnesses which accept raster image inputs. */
export async function prepareImageFile(file: File): Promise<File> {
  if (file.size <= 0 || file.size > 10 * 1_024 * 1_024) throw new Error("Choose an image of at most 10 MiB");
  const mediaType = file.type || ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", svg: "image/svg+xml" } as Record<string, string>)[file.name.split(".").at(-1)?.toLowerCase() ?? ""];
  if (!mediaType || !["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"].includes(mediaType)) throw new Error("Choose a PNG, JPEG, WebP, GIF, or SVG image");
  if (mediaType !== "image/svg+xml") return new File([file], file.name, { type: mediaType });
  const objectUrl = URL.createObjectURL(new Blob([file], { type: mediaType }));
  try {
    const image = new Image();
    image.src = objectUrl;
    await image.decode();
    if (!image.naturalWidth || !image.naturalHeight) throw new Error("SVG has no displayable dimensions");
    const scale = Math.min(1, 4_096 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image conversion is unavailable");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("SVG conversion failed")), "image/png"));
    if (png.size > 10 * 1_024 * 1_024) throw new Error("Converted image exceeds 10 MiB");
    return new File([png], file.name.replace(/\.svg$/i, "") + ".png", { type: "image/png" });
  } finally { URL.revokeObjectURL(objectUrl); }
}
