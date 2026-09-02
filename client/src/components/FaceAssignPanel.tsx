import { useEffect, useMemo, useState } from "react";
import { Dismiss24Regular } from "@fluentui/react-icons";
import {
  buildFaceCropUrl,
  fetchClusterFacePreview,
  fetchNamedPeople,
  mergeClusters,
  renameCluster,
} from "../api";
import type { ClusterFace } from "../api/types";
import type { NamedFace } from "./FaceOverlay";
import { Spinner } from "../Spinner";
import css from "./FaceAssignPanel.module.css";

type NamedPersonOption = { id: string; name: string };

type FaceAssignPanelProps = {
  /** The unnamed face the "Who is this?" chip was clicked on. */
  face: NamedFace;
  onClose: () => void;
  /** Called after a successful rename or merge — the caller re-fetches. */
  onAssigned: () => void;
};

const MAX_SUGGESTIONS = 6;
const PREVIEW_LIMIT = 6;

/**
 * Docked bottom panel opened from an unnamed face's "Who is this?" chip in
 * the fullscreen viewer (see FaceOverlay). Shows a few other sightings of the
 * same clustered face so the user can confirm it's really one person before
 * naming it, then either:
 *  - types a brand-new name -> `renameCluster` (this cluster becomes a new
 *    named person), or
 *  - picks/types an existing person's name -> `mergeClusters` (this cluster
 *    joins that person's identity instead of duplicating the name as a
 *    second, unrelated person).
 *
 * Phase 1 of the face-tagging work described in photrix/AGENTS.md: handles
 * "no name" only. Re-naming an *already*-named face (the "incorrect name"
 * case) is a follow-up — see the doc for why splitting it this way.
 */
export function FaceAssignPanel({ face, onClose, onAssigned }: FaceAssignPanelProps) {
  const [previewFaces, setPreviewFaces] = useState<ClusterFace[]>([]);
  const [previewLoading, setPreviewLoading] = useState(true);
  const [namedPeople, setNamedPeople] = useState<NamedPersonOption[]>([]);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const abortController = new AbortController();
    setPreviewLoading(true);
    fetchClusterFacePreview({
      clusterId: face.personId,
      excludeFaceId: face.faceId,
      limit: PREVIEW_LIMIT,
      signal: abortController.signal,
    })
      .then(setPreviewFaces)
      .catch(() => {
        // The preview is a confidence-building nicety, not essential — an
        // empty strip just means "no other sightings shown", not an error.
      })
      .finally(() => {
        if (!abortController.signal.aborted) setPreviewLoading(false);
      });

    fetchNamedPeople(abortController.signal)
      .then(setNamedPeople)
      .catch(() => {
        // Falling back to free-text-only naming is fine if this fails.
      });

    return () => abortController.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [face.personId, face.faceId]);

  const suggestions = useMemo(() => {
    const trimmed = draft.trim().toLowerCase();
    const pool = trimmed
      ? namedPeople.filter((person) => person.name.toLowerCase().includes(trimmed))
      : namedPeople;
    return pool.slice(0, MAX_SUGGESTIONS);
  }, [draft, namedPeople]);

  const assignToExistingPerson = async (person: NamedPersonOption) => {
    setSaving(true);
    setError(null);
    try {
      await mergeClusters([face.personId], person.id);
      onAssigned();
    } catch {
      setError(`Couldn't merge into ${person.name} — try again.`);
      setSaving(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed || saving) return;

    const exactMatch = namedPeople.find(
      (person) => person.name.toLowerCase() === trimmed.toLowerCase(),
    );
    if (exactMatch) {
      await assignToExistingPerson(exactMatch);
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await renameCluster(face.personId, trimmed);
      onAssigned();
    } catch {
      setError("Couldn't save that name — try again.");
      setSaving(false);
    }
  };

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events
    <div className={css.panel} onClick={(e) => e.stopPropagation()}>
      <div className={css.header}>
        <h4 className={css.title}>Who is this?</h4>
        <button
          type="button"
          className={css.closeButton}
          onClick={onClose}
          aria-label="Cancel naming this face"
          title="Cancel"
        >
          <Dismiss24Regular />
        </button>
      </div>

      {previewLoading ? (
        <Spinner size="small" label="Loading other photos of this face..." />
      ) : previewFaces.length > 0 ? (
        <div className={css.previewRow}>
          {previewFaces.map((previewFace, index) => (
            <img
              key={index}
              className={css.previewThumb}
              src={buildFaceCropUrl(previewFace, 96)}
              alt="Related photo of this face"
              loading="lazy"
            />
          ))}
        </div>
      ) : (
        <p className={css.hint}>No other photos of this face yet.</p>
      )}

      <form className={css.form} onSubmit={handleSubmit}>
        <input
          type="text"
          className={css.input}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Type a name…"
          autoFocus
          disabled={saving}
          aria-label="Person's name"
        />
        <button type="submit" className={css.saveButton} disabled={!draft.trim() || saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </form>

      {suggestions.length > 0 && (
        <div className={css.suggestions}>
          {suggestions.map((person) => (
            <button
              key={person.id}
              type="button"
              className={css.suggestionChip}
              onClick={() => assignToExistingPerson(person)}
              disabled={saving}
              title={`Assign this face to ${person.name}`}
            >
              {person.name}
            </button>
          ))}
        </div>
      )}

      {error && <p className={css.error}>{error}</p>}
    </div>
  );
}
