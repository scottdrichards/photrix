import { Button, Caption1, Input, Spinner, Subtitle2, makeStyles, tokens } from "@fluentui/react-components";
import { type CSSProperties, useEffect, useMemo, useState } from "react";
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

const flexColumnBase = {
  display: "flex",
  flexDirection: "column",
} as const;

const useStyles = makeStyles({
  root: {
    ...flexColumnBase,
    gap: tokens.spacingVerticalL,
  },
  peopleGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
    gap: tokens.spacingHorizontalM,
  },
  personCard: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    padding: tokens.spacingHorizontalM,
    ...flexColumnBase,
    gap: tokens.spacingVerticalS,
    textAlign: "left",
    cursor: "pointer",
  },
  cards: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
    gap: tokens.spacingHorizontalM,
  },
  card: {
    ...flexColumnBase,
    gap: tokens.spacingVerticalS,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    padding: tokens.spacingHorizontalM,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  previewViewport: {
    width: "100%",
    aspectRatio: "4 / 3",
    overflow: "hidden",
    position: "relative",
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  preview: {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    backgroundColor: tokens.colorNeutralBackground2,
    transition: "transform 180ms ease",
    display: "block",
    transformOrigin: "top left",
    backgroundPosition: "center center",
    backgroundRepeat: "no-repeat",
  },
  previewCropped: {
    transform:
      "translate(var(--preview-pan-x, 0%), var(--preview-pan-y, 0%)) scale(var(--preview-scale, 1))",
    backgroundSize: "100% 100%",
  },
  previewUncropped: {
    transform: "translate(0%, 0%) scale(1)",
    backgroundSize: "contain",
  },
  previewZoomed: {
    transform:
      "translate(var(--preview-pan-x, 0%), var(--preview-pan-y, 0%)) scale(var(--preview-scale, 1))",
    backgroundSize: "100% 100%",
  },
  previewButton: {
    border: "none",
    background: "transparent",
    padding: 0,
    margin: 0,
    cursor: "zoom-in",
    textAlign: "left",
    width: "100%",
    display: "block",
  },
  previewButtonUncropped: {
    cursor: "zoom-in",
  },
  previewButtonZoomed: {
    cursor: "zoom-out",
  },
  regionBox: {
    position: "absolute",
    border: "2px solid #d13438",
    boxShadow: "0 0 0 1px rgba(255,255,255,0.7)",
    pointerEvents: "none",
    transition: "opacity 180ms ease",
  },
  previewHint: {
    color: tokens.colorNeutralForeground3,
  },
  cardActions: {
    display: "flex",
    gap: tokens.spacingHorizontalS,
  },
  nameInput: {
    width: "100%",
  },
  personMeta: {
    color: tokens.colorNeutralForeground3,
  },
  personHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  section: {
    ...flexColumnBase,
    gap: tokens.spacingVerticalXS,
  },
  matchesGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))",
    gap: tokens.spacingHorizontalS,
  },
  matchCard: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingHorizontalS,
    ...flexColumnBase,
    gap: tokens.spacingVerticalXS,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  matchMeta: {
    color: tokens.colorNeutralForeground3,
  },
});

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

const getPreviewClassName = (styles: ReturnType<typeof useStyles>, mode: PreviewMode) => {
  if (mode === "uncropped") {
    return styles.previewUncropped;
  }
  if (mode === "zoomed") {
    return styles.previewZoomed;
  }
  return styles.previewCropped;
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
  const styles = useStyles();
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
    const previewClassName = getPreviewClassName(styles, options.mode);
    const previewStyle: CSSProperties &
      Record<"--preview-scale" | "--preview-pan-x" | "--preview-pan-y", string> = {
      "--preview-scale": previewScale.toFixed(3),
      "--preview-pan-x": previewPan.x,
      "--preview-pan-y": previewPan.y,
      backgroundImage: `url("${buildFacePreviewUrl(options.relativePath, options.thumbnailHeight)}")`,
    };

    return (
      <div className={styles.previewViewport}>
        <div
          className={`${styles.preview} ${previewClassName}`}
          role="img"
          aria-label={options.ariaLabel}
          style={previewStyle}
        >
          {options.showRegionBox ? (
            <div
              className={styles.regionBox}
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
      <section className={styles.root}>
        <div>
          <Subtitle2>People</Subtitle2>
          <Caption1>Choose a person to review all detected faces</Caption1>
        </div>

        {isLoadingPeople ? <Spinner label="Loading people" /> : null}
        {peopleError ? <Subtitle2>{peopleError}</Subtitle2> : null}

        {!isLoadingPeople && !peopleError && people.length === 0 ? (
          <Subtitle2>No identified people yet.</Subtitle2>
        ) : null}

        <div className={styles.peopleGrid}>
          {people.map((person) => (
            <button
              key={person.id}
              type="button"
              className={styles.personCard}
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
              <Subtitle2>{displayPersonName(person)}</Subtitle2>
              <Caption1 className={styles.personMeta}>{person.count} faces</Caption1>
            </button>
          ))}
        </div>
      </section>
    );
  }

  return (
    <section className={styles.root}>
      <div className={styles.personHeader}>
        <div>
          <Subtitle2>{displayPersonName(selectedPerson)}</Subtitle2>
          <Caption1>{taggedItems.length} tagged faces</Caption1>
        </div>
        <Button
          appearance="subtle"
          onClick={() => {
            setSelectedPersonId(null);
            setTaggedItems([]);
            setSuggestedItems([]);
          }}
        >
          Back to people
        </Button>
      </div>

      {isLoadingFaces ? <Spinner label="Loading faces" /> : null}
      {facesError ? <Subtitle2>{facesError}</Subtitle2> : null}
      {!isLoadingFaces && !facesError && taggedItems.length === 0 ? (
        <Subtitle2>No faces found for this person.</Subtitle2>
      ) : null}

      <div className={styles.section}>
        <Subtitle2>Tagged Faces</Subtitle2>
        <div className={styles.cards}>
          {taggedItems.map((item) => {
            const previewMode = previewModes[item.faceId] ?? "cropped";

            return (
              <article key={item.faceId} className={styles.card}>
                <button
                  type="button"
                  className={`${styles.previewButton} ${previewMode === "zoomed" ? styles.previewButtonZoomed : styles.previewButtonUncropped}`}
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

                <Subtitle2>{item.fileName}</Subtitle2>
                <Caption1>{formatAssigned(item)}</Caption1>
                {selectedPerson.id === "__unassigned__" ? (
                  <Input
                    className={styles.nameInput}
                    placeholder="Type a name to confirm this person"
                    value={pendingNames[item.faceId] ?? ""}
                    onChange={(_, data) => {
                      setPendingName(item.faceId, data.value);
                    }}
                  />
                ) : null}
                <Caption1 className={styles.previewHint}>
                  Click preview: uncrop, then zoom to face
                </Caption1>
                {selectedPerson.id === "__unassigned__" ? (
                  <div className={styles.cardActions}>
                    <Button
                      appearance="primary"
                      onClick={() => {
                        void handleNameUnassignedFace(item);
                      }}
                      disabled={(pendingNames[item.faceId] ?? "").trim().length === 0}
                    >
                      Accept
                    </Button>
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      </div>

      <div className={styles.section}>
        <Subtitle2>Suggested Faces</Subtitle2>
        {suggestedItems.length === 0 ? (
          <Caption1 className={styles.personMeta}>No profile-based suggestions available.</Caption1>
        ) : null}
        <div className={styles.cards}>
        {suggestedItems.map((item) => {
          const previewMode = previewModes[item.faceId] ?? "cropped";

          return (
            <article key={item.faceId} className={styles.card}>
              <button
                type="button"
                className={`${styles.previewButton} ${previewMode === "zoomed" ? styles.previewButtonZoomed : styles.previewButtonUncropped}`}
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

              <Subtitle2>{item.fileName}</Subtitle2>
              <Caption1>{Math.round(item.confidence * 100)}% profile match</Caption1>
              <Caption1 className={styles.previewHint}>
                Click preview: uncrop, then zoom to face
              </Caption1>
              <div className={styles.cardActions}>
                <Button
                  appearance="primary"
                  onClick={() => {
                    void handleAcceptSuggestion(item);
                  }}
                  disabled={selectedPerson.id === "__unassigned__"}
                >
                  Accept
                </Button>
                <Button
                  appearance="subtle"
                  onClick={() => {
                    void handleRejectSuggestion(item);
                  }}
                >
                  Reject
                </Button>
              </div>
            </article>
          );
        })}
        </div>
      </div>
    </section>
  );
};
