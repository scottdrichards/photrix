import { type CSSProperties, useEffect, useMemo, useState } from "react";
import { Spinner } from "../../Spinner";
import css from "./FacesReviewPage.module.css";
import {
  acceptFaceSuggestion,
  fetchFacePersonSuggestions,
  fetchFacePeople,
  fetchFaceQueue,
  rejectFaceSuggestion,
  type FaceMatchItem,
  type FacePerson,
  type FaceQueueItem,
} from "../../api";
import { useFilterContext } from "../filter/FilterContext";

type PreviewMode = "cropped" | "uncropped" | "zoomed";

const formatSuggestion = (item: FaceQueueItem) => {
  if (item.person?.id) {
    const name = getPersonDisplayName(item.person, "Unknown");
    return `Assigned: ${name}`;
  }

  const personId = item.suggestion?.personId;
  if (!personId) {
    return "No suggestion";
  }
  const confidencePercent = Math.round((item.suggestion?.confidence ?? 0) * 100);
  return `Suggested: ${personId} (${confidencePercent}%)`;
};

const formatAssigned = (item: FaceQueueItem) => {
  const name = getPersonDisplayName(item.person, "Unknown");
  return `Assigned: ${name}`;
};

const getPersonDisplayName = (
  person: { id?: string; name?: string } | null | undefined,
  fallback: string,
) => person?.name ?? person?.id?.replace(/^name:/i, "") ?? fallback;

const buildFacePreviewUrl = (relativePath: string, preferredHeight?: number) => {
  const normalizedPath = relativePath.startsWith("/")
    ? relativePath.slice(1)
    : relativePath;
  const params = new URLSearchParams({
    representation: "webSafe",
    height: String(preferredHeight ?? 320),
  });
  return `/api/files/${normalizedPath}?${params.toString()}`;
};

const getFaceCenter = (dimensions: {
  x: number;
  y: number;
  width: number;
  height: number;
}) => {
  const centerX = dimensions.x + dimensions.width / 2;
  const centerY = dimensions.y + dimensions.height / 2;
  return {
    x: Math.min(Math.max(centerX, 0), 1),
    y: Math.min(Math.max(centerY, 0), 1),
  };
};

const getPreviewScale = (
  dimensions: { x: number; y: number; width: number; height: number },
  mode: PreviewMode,
) => {
  if (mode === "uncropped") {
    return 1;
  }

  const minFaceSpan = Math.max(Math.min(dimensions.width, dimensions.height), 0.08);
  const baseScale = Math.min(Math.max(0.75 / minFaceSpan, 1.6), 3.2);

  if (mode === "zoomed") {
    return Math.min(baseScale * 1.5, 4.8);
  }

  return baseScale;
};

const nextPreviewMode = (mode: PreviewMode): PreviewMode => {
  if (mode === "cropped") {
    return "uncropped";
  }
  if (mode === "uncropped") {
    return "zoomed";
  }
  return "uncropped";
};

const getPreviewClassName = (mode: PreviewMode) => {
  if (mode === "uncropped") {
    return css.previewUncropped;
  }
  if (mode === "zoomed") {
    return css.previewZoomed;
  }
  return css.previewCropped;
};

const getPreviewPan = (
  dimensions: { x: number; y: number; width: number; height: number },
  mode: PreviewMode,
  scale: number,
) => {
  if (mode === "uncropped") {
    return { x: "0%", y: "0%" };
  }

  const faceCenter = getFaceCenter(dimensions);
  const panXPercent = 50 - faceCenter.x * 100 * scale;
  const panYPercent = 50 - faceCenter.y * 100 * scale;

  return {
    x: `${panXPercent.toFixed(2)}%`,
    y: `${panYPercent.toFixed(2)}%`,
  };
};

const displayPersonName = (person: FacePerson) => {
  if (person.id === "__unassigned__") {
    return "Unassigned";
  }
  return getPersonDisplayName(person, person.id);
};

export const FacesReviewPage = () => {
  const { filter } = useFilterContext();
  const [people, setPeople] = useState<FacePerson[]>([]);
  const [isLoadingPeople, setIsLoadingPeople] = useState(true);
  const [peopleError, setPeopleError] = useState<string | null>(null);
  const [selectedPersonId, setSelectedPersonId] = useState<string | null>(null);

  const [taggedItems, setTaggedItems] = useState<FaceQueueItem[]>([]);
  const [suggestedItems, setSuggestedItems] = useState<FaceMatchItem[]>([]);
  const [isLoadingFaces, setIsLoadingFaces] = useState(false);
  const [facesError, setFacesError] = useState<string | null>(null);
  const [previewModes, setPreviewModes] = useState<Record<string, PreviewMode>>({});
  const [pendingNames, setPendingNames] = useState<Record<string, string>>({});

  useEffect(() => {
    let disposed = false;

    setIsLoadingPeople(true);
    setPeopleError(null);

    fetchFacePeople(
      filter.path
        ? { path: filter.path, includeSubfolders: filter.includeSubfolders }
        : {},
    )
      .then((result) => {
        if (disposed) {
          return;
        }
        setPeople(result);
      })
      .catch((error) => {
        if (disposed) {
          return;
        }
        console.error("Failed to fetch face people", error);
        setPeopleError("Failed to load people");
      })
      .finally(() => {
        if (disposed) {
          return;
        }
        setIsLoadingPeople(false);
      });

    return () => {
      disposed = true;
    };
  }, [filter.path, filter.includeSubfolders]);

  const selectedPerson = useMemo(
    () => people.find((person) => person.id === selectedPersonId) ?? null,
    [people, selectedPersonId],
  );

  const loadPersonFaces = async (personId: string) => {
    const pathFilter = filter.path
      ? { path: filter.path, includeSubfolders: filter.includeSubfolders }
      : {};
    const [taggedResult, suggestions] = await Promise.all([
      fetchFaceQueue({ personId, pageSize: 500, ...pathFilter }),
      personId === "__unassigned__"
        ? Promise.resolve([])
        : fetchFacePersonSuggestions({ personId, limit: 200 }),
    ]);

    setTaggedItems(taggedResult.items);
    setSuggestedItems(suggestions);
  };

  const openPersonFaces = async (person: FacePerson) => {
    setSelectedPersonId(person.id);
    setIsLoadingFaces(true);
    setFacesError(null);
    setPreviewModes({});
    setPendingNames({});

    try {
      await loadPersonFaces(person.id);
    } catch (error) {
      console.error("Failed to fetch person faces", error);
      setFacesError("Failed to load faces for person");
      setTaggedItems([]);
      setSuggestedItems([]);
    } finally {
      setIsLoadingFaces(false);
    }
  };

  const removeSuggestion = (faceId: string) =>
    setSuggestedItems((previous) => previous.filter((item) => item.faceId !== faceId));

  const removeTagged = (faceId: string) =>
    setTaggedItems((previous) => previous.filter((item) => item.faceId !== faceId));

  const setPendingName = (faceId: string, value: string) => {
    setPendingNames((previous) => ({
      ...previous,
      [faceId]: value,
    }));
  };

  const handlePreviewClick = (faceId: string) => {
    setPreviewModes((previous) => {
      const current = previous[faceId] ?? "cropped";
      return {
        ...previous,
        [faceId]: nextPreviewMode(current),
      };
    });
  };

  const handleAcceptSuggestion = async (item: FaceMatchItem) => {
    if (!selectedPerson?.id || selectedPerson.id === "__unassigned__") {
      return;
    }

    const personId = selectedPerson.id;
    const personName = selectedPerson.name;
    const optimisticTagged: FaceQueueItem = {
      faceId: item.faceId,
      relativePath: item.relativePath,
      fileName: item.fileName,
      dimensions: item.dimensions,
      thumbnail: item.thumbnail,
      person: {
        id: personId,
        name: personName,
      },
      status: "confirmed",
    };

    setTaggedItems((previous) => [
      optimisticTagged,
      ...previous.filter((current) => current.faceId !== item.faceId),
    ]);
    removeSuggestion(item.faceId);

    try {
      await acceptFaceSuggestion({
        faceId: item.faceId,
        personId,
      });
      await loadPersonFaces(personId);
    } catch (error) {
      console.error("Failed to accept face suggestion", error);
      setFacesError("Failed to accept suggestion");
      await loadPersonFaces(personId).catch(() => {
        // Keep current UI state if reload also fails.
      });
    }
  };

  const handleRejectSuggestion = async (item: FaceMatchItem) => {
    if (!selectedPerson?.id || selectedPerson.id === "__unassigned__") {
      return;
    }

    const personId = selectedPerson.id;

    removeSuggestion(item.faceId);

    try {
      await rejectFaceSuggestion({
        faceId: item.faceId,
        personId,
      });
      await loadPersonFaces(personId);
    } catch (error) {
      console.error("Failed to reject face suggestion", error);
      setFacesError("Failed to reject suggestion");
      await loadPersonFaces(personId).catch(() => {
        // Keep current UI state if reload also fails.
      });
    }
  };

  const handleNameUnassignedFace = async (item: FaceQueueItem) => {
    const pendingName = pendingNames[item.faceId]?.trim();
    if (!pendingName) {
      return;
    }

    await acceptFaceSuggestion({
      faceId: item.faceId,
      personName: pendingName,
    });
    removeTagged(item.faceId);
  };

  const renderPreviewLayer = (options: {
    relativePath: string;
    thumbnailHeight?: number;
    dimensions: { x: number; y: number; width: number; height: number };
    mode: PreviewMode;
    ariaLabel: string;
    showRegionBox: boolean;
  }) => {
    const previewScale = getPreviewScale(options.dimensions, options.mode);
    const previewPan = getPreviewPan(options.dimensions, options.mode, previewScale);
    const previewClassName = getPreviewClassName(options.mode);
    const previewStyle: CSSProperties &
      Record<"--preview-scale" | "--preview-pan-x" | "--preview-pan-y", string> = {
      "--preview-scale": previewScale.toFixed(3),
      "--preview-pan-x": previewPan.x,
      "--preview-pan-y": previewPan.y,
      backgroundImage: `url("${buildFacePreviewUrl(options.relativePath, options.thumbnailHeight)}")`,
    };

    return (
      <div className={css.previewViewport}>
        <div
          className={`${css.preview} ${previewClassName}`}
          role="img"
          aria-label={options.ariaLabel}
          style={previewStyle}
        >
          {options.showRegionBox ? (
            <div
              className={css.regionBox}
              aria-label={`Face region for ${options.ariaLabel}`}
              style={{
                left: `${(options.dimensions.x * 100).toFixed(2)}%`,
                top: `${(options.dimensions.y * 100).toFixed(2)}%`,
                width: `${(options.dimensions.width * 100).toFixed(2)}%`,
                height: `${(options.dimensions.height * 100).toFixed(2)}%`,
                opacity: options.mode === "uncropped" ? 1 : 0,
              }}
            />
          ) : null}
        </div>
      </div>
    );
  };

  if (!selectedPerson) {
    return (
      <section className={css.root}>
        <div>
          <h3>People</h3>
          <small>Choose a person to review all detected faces</small>
        </div>

        {isLoadingPeople ? <Spinner label="Loading people" /> : null}
        {peopleError ? <h3>{peopleError}</h3> : null}

        {!isLoadingPeople && !peopleError && people.length === 0 ? (
          <h3>No identified people yet.</h3>
        ) : null}

        <div className={css.peopleGrid}>
          {people.map((person) => (
            <button
              key={person.id}
              type="button"
              className={css.personCard}
              onClick={() => {
                void openPersonFaces(person);
              }}
              aria-label={`Open faces for ${displayPersonName(person)}`}
            >
              {person.representativeFace
                ? renderPreviewLayer({
                    relativePath: person.representativeFace.relativePath,
                    thumbnailHeight: person.representativeFace.thumbnail?.preferredHeight,
                    dimensions: person.representativeFace.dimensions,
                    mode: "cropped",
                    ariaLabel: `Representative face for ${displayPersonName(person)}`,
                    showRegionBox: false,
                  })
                : null}
              <h3>{displayPersonName(person)}</h3>
              <small className={css.personMeta}>{person.count} faces</small>
            </button>
          ))}
        </div>
      </section>
    );
  }

  return (
    <section className={css.root}>
      <div className={css.personHeader}>
        <div>
          <h3>{displayPersonName(selectedPerson)}</h3>
          <small>{taggedItems.length} tagged faces</small>
        </div>
        <button
          type="button"
          className="btn btn-subtle"
          onClick={() => {
            setSelectedPersonId(null);
            setTaggedItems([]);
            setSuggestedItems([]);
          }}
        >
          Back to people
        </button>
      </div>

      {isLoadingFaces ? <Spinner label="Loading faces" /> : null}
      {facesError ? <h3>{facesError}</h3> : null}
      {!isLoadingFaces && !facesError && taggedItems.length === 0 ? (
        <h3>No faces found for this person.</h3>
      ) : null}

      <div className={css.section}>
        <h3>Tagged Faces</h3>
        <div className={css.cards}>
          {taggedItems.map((item) => {
            const previewMode = previewModes[item.faceId] ?? "cropped";

            return (
              <article key={item.faceId} className={css.card}>
                <button
                  type="button"
                  className={`${css.previewButton} ${previewMode === "zoomed" ? css.previewButtonZoomed : css.previewButtonUncropped}`}
                  onClick={() => {
                    handlePreviewClick(item.faceId);
                  }}
                  aria-label={`Toggle face preview for ${item.fileName}`}
                  data-preview-mode={previewMode}
                >
                  {renderPreviewLayer({
                    relativePath: item.relativePath,
                    thumbnailHeight: item.thumbnail?.preferredHeight,
                    dimensions: item.dimensions,
                    mode: previewMode,
                    ariaLabel: `Tagged face from ${item.fileName}`,
                    showRegionBox: true,
                  })}
                </button>

                <h3>{item.fileName}</h3>
                <small>{formatAssigned(item)}</small>
                {selectedPerson.id === "__unassigned__" ? (
                  <input
                    className={`input ${css.nameInput}`}
                    placeholder="Type a name to confirm this person"
                    value={pendingNames[item.faceId] ?? ""}
                    onChange={(e) => {
                      setPendingName(item.faceId, e.target.value);
                    }}
                  />
                ) : null}
                <small className={css.previewHint}>
                  Click preview: uncrop, then zoom to face
                </small>
                {selectedPerson.id === "__unassigned__" ? (
                  <div className={css.cardActions}>
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => {
                        void handleNameUnassignedFace(item);
                      }}
                      disabled={(pendingNames[item.faceId] ?? "").trim().length === 0}
                    >
                      Accept
                    </button>
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      </div>

      <div className={css.section}>
        <h3>Suggested Faces</h3>
        {suggestedItems.length === 0 ? (
          <small className={css.personMeta}>No profile-based suggestions available.</small>
        ) : null}
        <div className={css.cards}>
        {suggestedItems.map((item) => {
          const previewMode = previewModes[item.faceId] ?? "cropped";

          return (
            <article key={item.faceId} className={css.card}>
              <button
                type="button"
                className={`${css.previewButton} ${previewMode === "zoomed" ? css.previewButtonZoomed : css.previewButtonUncropped}`}
                onClick={() => {
                  handlePreviewClick(item.faceId);
                }}
                aria-label={`Toggle face preview for ${item.fileName}`}
                data-preview-mode={previewMode}
              >
                {renderPreviewLayer({
                  relativePath: item.relativePath,
                  thumbnailHeight: item.thumbnail?.preferredHeight,
                  dimensions: item.dimensions,
                  mode: previewMode,
                    ariaLabel: `Suggested face from ${item.fileName}`,
                  showRegionBox: true,
                })}
              </button>

              <h3>{item.fileName}</h3>
              <small>{Math.round(item.confidence * 100)}% profile match</small>
              <small className={css.previewHint}>
                Click preview: uncrop, then zoom to face
              </small>
              <div className={css.cardActions}>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    void handleAcceptSuggestion(item);
                  }}
                  disabled={selectedPerson.id === "__unassigned__"}
                >
                  Accept
                </button>
                <button
                  type="button"
                  className="btn btn-subtle"
                  onClick={() => {
                    void handleRejectSuggestion(item);
                  }}
                >
                  Reject
                </button>
              </div>
            </article>
          );
        })}
        </div>
      </div>
    </section>
  );
};
