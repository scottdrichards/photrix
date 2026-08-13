import { useEffect, useRef, useState } from "react";
import { Star12Filled, StackOffRegular, Dismiss24Regular } from "@fluentui/react-icons";
import {
  dissolveMomentCluster,
  fetchMomentClusterDetail,
  setMomentClusterRepresentative,
  type MomentClusterMember,
} from "../api";
import { Spinner } from "../Spinner";
import css from "./PhotoStackModal.module.css";

const syncDialogOpenState = (dialog: HTMLDialogElement, isOpen: boolean) => {
  try {
    if (isOpen) {
      if (!dialog.open) dialog.showModal();
      return;
    }
    if (dialog.open) dialog.close();
  } catch {
    // Ignore dialog state races.
  }
};

type PhotoStackModalProps = {
  /** The cluster to show, or null when the modal is closed. */
  clusterId: string | null;
  onDismiss: () => void;
  /**
   * Called after the cluster has been permanently dissolved on the server, so
   * the caller can drop it from the collapsed gallery view immediately rather
   * than waiting on a full refetch.
   */
  onPermanentlyDissolved: (clusterId: string) => void;
};

/**
 * The secondary "more options" view for a moment (burst/near-duplicate)
 * cluster's stack — reached via the small kebab next to the stack/restack
 * badge on a tile, not the primary click path. The primary path (toggling
 * between collapsed and inline-unstacked) lives entirely in ThumbnailGrid
 * now; this modal only holds the two actions that don't fit inline: promoting
 * a different member to representative (persists — see
 * setMomentClusterRepresentative) and permanently dissolving the cluster
 * (persists — see dissolveMomentCluster).
 */
export const PhotoStackModal = ({
  clusterId,
  onDismiss,
  onPermanentlyDissolved,
}: PhotoStackModalProps) => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [members, setMembers] = useState<MomentClusterMember[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const [isDissolving, setIsDissolving] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    syncDialogOpenState(dialog, clusterId !== null);
  }, [clusterId]);

  useEffect(() => {
    if (!clusterId) {
      setMembers(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchMomentClusterDetail(clusterId)
      .then((detail) => {
        if (cancelled) return;
        setMembers(detail?.members ?? []);
      })
      .catch(() => {
        if (!cancelled) setError("Failed to load this stack.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [clusterId]);

  if (!clusterId) return null;

  const handleMakeRepresentative = async (path: string) => {
    setPendingPath(path);
    try {
      await setMomentClusterRepresentative(clusterId, path);
      setMembers(
        (prev) =>
          prev?.map((m) => ({ ...m, isRepresentative: m.photo.path === path })) ?? null,
      );
    } catch {
      setError("Failed to update the representative photo.");
    } finally {
      setPendingPath(null);
    }
  };

  const handlePermanentUnstack = async () => {
    setIsDissolving(true);
    try {
      await dissolveMomentCluster(clusterId);
      onPermanentlyDissolved(clusterId);
      onDismiss();
    } catch {
      setError("Failed to unstack these photos.");
      setIsDissolving(false);
    }
  };

  return (
    <dialog ref={dialogRef} onClose={onDismiss} className={css.dialog}>
      <div className={css.dialogBody}>
        <div className={css.header}>
          <h2>
            {members ? `${members.length} photos of this moment` : "This moment"}
          </h2>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onDismiss}
            aria-label="Close"
          >
            <Dismiss24Regular />
          </button>
        </div>

        <p className={css.hint}>
          Photrix grouped these because they were taken moments apart and look
          alike. Click the stack badge on the tile to show or hide these
          individually — the button below breaks the grouping for good.
        </p>

        <div className={css.actions}>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={handlePermanentUnstack}
            disabled={isDissolving}
            title="Permanently ungroup these photos — they'll always show separately from now on"
          >
            {isDissolving ? <Spinner size="extra-tiny" /> : <StackOffRegular fontSize={16} />}
            Unstack permanently
          </button>
        </div>

        {error ? <p className={css.error}>{error}</p> : null}

        {loading && !members ? (
          <div className={css.loadingRow}>
            <Spinner size="extra-tiny" />
          </div>
        ) : (
          <div className={css.memberGrid}>
            {members?.map((member) => (
              <div key={member.photo.path} className={css.memberCard}>
                <img
                  src={member.photo.thumbnailUrl}
                  alt={member.photo.name}
                  className={css.memberImage}
                />
                {member.isRepresentative ? (
                  <span className={css.representativeBadge}>
                    <Star12Filled fontSize={12} /> Shown in gallery
                  </span>
                ) : (
                  <button
                    type="button"
                    className={`btn btn-ghost ${css.makeRepresentativeBtn}`}
                    onClick={() => handleMakeRepresentative(member.photo.path)}
                    disabled={pendingPath !== null}
                  >
                    {pendingPath === member.photo.path ? (
                      <Spinner size="extra-tiny" />
                    ) : (
                      "Make representative"
                    )}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </dialog>
  );
};
