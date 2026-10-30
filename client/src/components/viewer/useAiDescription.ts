import { useEffect, useRef, useState } from "react";
import { streamPhotoDescription, type PhotoItem } from "../../api";
import { logFailure } from "../../logFailure";

type AiDescription = { path: string; text: string; status: "writing" | "done" | "error" };

/**
 * The long AI description of a photo (feedback #148). It is written on demand —
 * only while `active` (the file-info panel is open), streamed in as the model
 * produces it, and stored server-side so it is never generated twice. Turning
 * `active` off or moving to another photo aborts the stream, which stops
 * generation. A finished description is kept while the viewer stays open.
 */
export const useAiDescription = (photo: PhotoItem | null, active: boolean) => {
  const [description, setDescription] = useState<AiDescription | null>(null);
  const [attempt, setAttempt] = useState(0);
  const latestRef = useRef(description);
  latestRef.current = description;

  const stored =
    typeof photo?.metadata?.aiDescription === "string" ? photo.metadata.aiDescription : null;
  const path = photo?.path ?? null;
  const isVideo = photo?.mediaType === "video";

  useEffect(() => {
    if (!active || !path || isVideo || stored) return;
    const current = latestRef.current;
    if (current?.path === path && current.status === "done") return;

    const abortController = new AbortController();
    setDescription({ path, text: "", status: "writing" });
    streamPhotoDescription(
      path,
      (delta) =>
        setDescription((latest) =>
          latest?.path === path ? { ...latest, text: latest.text + delta } : latest,
        ),
      abortController.signal,
    )
      .then((text) => setDescription({ path, text: text ?? "", status: "done" }))
      .catch((error: unknown) => {
        if (abortController.signal.aborted) return;
        logFailure("viewer.aiDescription.failed", "Writing the AI description failed")(error);
        setDescription((latest) => (latest?.path === path ? { ...latest, status: "error" } : latest));
      });

    return () => abortController.abort();
  }, [active, path, isVideo, stored, attempt]);

  return { stored, description, retry: () => setAttempt((n) => n + 1) };
};
