import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Card,
  CardHeader,
  Checkbox,
  Image,
  Label,
  Spinner,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { Dismiss24Regular, PersonCircle24Regular } from "@fluentui/react-icons";

export type Person = {
  personId: string;
  faceCount: number;
  sampleImages: string[];
};

export type PeopleFilterProps = {
  selectedPeople: string[];
  onSelectionChange: (selectedPeople: string[]) => void;
};

const useStyles = makeStyles({
  container: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalM,
    padding: tokens.spacingVerticalM,
    backgroundColor: tokens.colorNeutralBackground2,
    borderRadius: tokens.borderRadiusMedium,
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  title: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    fontWeight: tokens.fontWeightSemibold,
  },
  peopleGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))",
    gap: tokens.spacingHorizontalM,
  },
  personCard: {
    cursor: "pointer",
    transition: "transform 0.2s ease",
    ":hover": {
      transform: "translateY(-2px)",
    },
  },
  personCardSelected: {
    boxShadow: `0 0 0 2px ${tokens.colorBrandBackground}`,
  },
  thumbnail: {
    width: "100%",
    aspectRatio: "1",
    objectFit: "cover",
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground4,
  },
  personInfo: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXXS,
    padding: tokens.spacingVerticalS,
  },
  loading: {
    display: "flex",
    justifyContent: "center",
    padding: tokens.spacingVerticalL,
  },
  error: {
    color: tokens.colorPaletteRedForeground1,
    padding: tokens.spacingVerticalM,
  },
  empty: {
    color: tokens.colorNeutralForeground3,
    padding: tokens.spacingVerticalM,
    textAlign: "center",
  },
  checkboxLabel: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
  },
});

export const PeopleFilter = ({ selectedPeople, onSelectionChange }: PeopleFilterProps) => {
  const styles = useStyles();
  const [people, setPeople] = useState<Person[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const loadPeople = async () => {
      try {
        setLoading(true);
        setError(null);
        const response = await fetch("/api/people");
        if (!response.ok) {
          throw new Error(`Failed to fetch people (status ${response.status})`);
        }
        const data = (await response.json()) as { people: Person[] };
        setPeople(data.people);
      } catch (err) {
        console.error("Failed to load people:", err);
        setError((err as Error).message ?? "Failed to load people");
      } finally {
        setLoading(false);
      }
    };

    loadPeople();
  }, []);

  const handleTogglePerson = useCallback(
    (personId: string) => {
      const isSelected = selectedPeople.includes(personId);
      if (isSelected) {
        onSelectionChange(selectedPeople.filter((id) => id !== personId));
      } else {
        onSelectionChange([...selectedPeople, personId]);
      }
    },
    [selectedPeople, onSelectionChange]
  );

  const handleClearAll = useCallback(() => {
    onSelectionChange([]);
  }, [onSelectionChange]);

  const buildThumbnailUrl = (imagePath: string): string => {
    const url = new URL("/api/file", window.location.origin);
    url.searchParams.set("path", imagePath);
    url.searchParams.set("representation", "resize");
    url.searchParams.set("maxWidth", "240");
    url.searchParams.set("maxHeight", "240");
    return url.toString();
  };

  if (loading) {
    return (
      <div className={styles.container}>
        <div className={styles.header}>
          <div className={styles.title}>
            <PersonCircle24Regular />
            <Text weight="semibold">People</Text>
          </div>
        </div>
        <div className={styles.loading}>
          <Spinner size="small" label="Loading people..." />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.container}>
        <div className={styles.header}>
          <div className={styles.title}>
            <PersonCircle24Regular />
            <Text weight="semibold">People</Text>
          </div>
        </div>
        <div className={styles.error}>{error}</div>
      </div>
    );
  }

  if (people.length === 0) {
    return (
      <div className={styles.container}>
        <div className={styles.header}>
          <div className={styles.title}>
            <PersonCircle24Regular />
            <Text weight="semibold">People</Text>
          </div>
        </div>
        <div className={styles.empty}>
          No people detected in your photos yet. Face detection will run as photos are indexed.
        </div>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.title}>
          <PersonCircle24Regular />
          <Text weight="semibold">People ({people.length})</Text>
        </div>
        {selectedPeople.length > 0 && (
          <Button
            appearance="subtle"
            size="small"
            icon={<Dismiss24Regular />}
            onClick={handleClearAll}
          >
            Clear ({selectedPeople.length})
          </Button>
        )}
      </div>

      <div className={styles.peopleGrid}>
        {people.map((person) => {
          const isSelected = selectedPeople.includes(person.personId);
          const thumbnailUrl = person.sampleImages[0]
            ? buildThumbnailUrl(person.sampleImages[0])
            : "";

          return (
            <Card
              key={person.personId}
              className={`${styles.personCard} ${isSelected ? styles.personCardSelected : ""}`}
              onClick={() => handleTogglePerson(person.personId)}
              size="small"
            >
              <CardHeader
                image={
                  thumbnailUrl ? (
                    <Image
                      src={thumbnailUrl}
                      alt={`Person ${person.personId}`}
                      className={styles.thumbnail}
                      fit="cover"
                    />
                  ) : (
                    <div className={styles.thumbnail}>
                      <PersonCircle24Regular />
                    </div>
                  )
                }
              />
              <div className={styles.personInfo}>
                <Label size="small" className={styles.checkboxLabel}>
                  <Checkbox checked={isSelected} />
                  <Text size={200}>{person.faceCount} photos</Text>
                </Label>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
};
