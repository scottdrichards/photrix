import { useEffect, useMemo, useState } from "react";
import { Dismiss24Regular } from "@fluentui/react-icons";
import {
  assignFaceToPerson,
  fetchClusterFacePreview,
  fetchNamedPeople,
  mergeClusters,
  renameCluster,
} from "../../api";
import type { ClusterFace } from "../../api/types";
import type { NamedFace } from "./FaceOverlay";
import { Spinner } from "../../Spinner";
import css from "./FaceAssignPanel.module.css";
import { logFailure } from "../../logFailure";
import { FaceCropImage } from "../people/FaceCropImage";

type NamedPersonOption = { id: string; name: string };

type FaceAssignPanelProps = {
  /**
   * The face that was clicked: an unnamed one's "Who is this?" chip, or a named
   * one's name (which switches the panel to changing just this face).
   */
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
 * A *named* face opens it in "change person" mode instead (feedback #160):
 * the wrong name belongs to a whole person, so renaming or merging the cluster
 * would rename or move everyone in it. This mode moves only the clicked face,
 * via `assignFaceToPerson`, and skips the sightings preview, which would show
 * the person it is being taken away from.
 */
export function FaceAssignPanel({ face, onClose, onAssigned }: FaceAssignPanelProps) {
  const changing = face.name !== null;
  const [previewFaces, setPreviewFaces] = useState<ClusterFace[]>([]);
  const [previewLoading, setPreviewLoading] = useState(true);
  const [namedPeople, setNamedPeople] = useState<NamedPersonOption[]>([]);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const abortController = new AbortController();
    setPreviewLoading(!changing);
    if (!changing) fetchClusterFacePreview({
      clusterId: face.personId,
      excludeFaceId: face.faceId,
      limit: PREVIEW_LIMIT,
      signal: abortController.signal,
    })
      .then(setPreviewFaces)
      // A nicety: an empty strip just means no other sightings are shown.
      .catch(logFailure("faceAssign.preview.failed", "Could not load other photos of this face"))
      .finally(() => {
        if (!abortController.signal.aborted) setPreviewLoading(false);
      });

    // Without the list, naming still works as free text.
    fetchNamedPeople(abortController.signal)
      .then(setNamedPeople)
      .catch(logFailure("faceAssign.people.failed", "Could not load the list of named people"));

    return () => abortController.abort();
     
  }, [face.personId, face.faceId, changing]);

  const suggestions = useMemo(() => {
    const trimmed = draft.trim().toLowerCase();
    // Changing a face away from someone: they're the one answer that's wrong.
    const candidates = changing
      ? namedPeople.filter((person) => person.id !== face.personId)
      : namedPeople;
    const pool = trimmed
      ? candidates.filter((person) => person.name.toLowerCase().includes(trimmed))
      : candidates;
    return pool.slice(0, MAX_SUGGESTIONS);
  }, [draft, namedPeople, changing, face.personId]);

  const assignToExistingPerson = async (person: NamedPersonOption) => {
    setSaving(true);
    setError(null);
    try {
      if (changing) await assignFaceToPerson(face.faceId, { personId: person.id });
      else await mergeClusters([face.personId], person.id);
      onAssigned();
    } catch {
      setError(
        changing
          ? `Couldn't move this face to ${person.name} — try again.`
          : `Couldn't merge into ${person.name} — try again.`,
      );
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
      if (changing) await assignFaceToPerson(face.faceId, { name: trimmed });
      else await renameCluster(face.personId, trimmed);
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
        <h4 className={css.title}>{changing ? `Not ${face.name}? Who is this?` : "Who is this?"}</h4>
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

      {changing ? (
        <p className={css.hint}>
          Only this face moves; {face.name}&apos;s other photos stay as they are.
        </p>
      ) : previewLoading ? (
        <Spinner size="small" label="Loading other photos of this face..." />
      ) : previewFaces.length > 0 ? (
        <div className={css.previewRow}>
          {previewFaces.map((previewFace, index) => (
            <FaceCropImage
              key={index}
              className={css.previewThumb}
              face={previewFace} size={96}
              alt="Another crop of this face"
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
          // eslint-disable-next-line jsx-a11y/no-autofocus -- the only field in a just-opened panel; focusing it is the expected flow
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
              title={
                changing ? `Move this face to ${person.name}` : `Assign this face to ${person.name}`
              }
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
