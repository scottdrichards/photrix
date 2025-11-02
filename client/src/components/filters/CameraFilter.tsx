import { Label, makeStyles, tokens } from "@fluentui/react-components";
import { PillFilter } from "./PillFilter";

// Mock available camera makes and models - in a real app, this would come from the API
const mockCameraMakes = [
  "Canon",
  "Nikon",
  "Sony",
  "Fujifilm",
  "Olympus",
  "Panasonic",
  "Leica",
  "Pentax",
  "Hasselblad",
  "Phase One",
];

const mockCameraModels = [
  "EOS R5",
  "EOS R6",
  "D850",
  "D780",
  "A7 IV",
  "A7R V",
  "X-T5",
  "X-H2S",
  "OM-1",
  "GH6",
  "S5 II",
  "Q2",
  "M11",
  "K-3 III",
  "X2D",
];

const useStyles = makeStyles({
  container: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalM,
  },
  section: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXS,
  },
});

export type CameraFilterProps = {
  makes: string[];
  models: string[];
  onMakesChange: (makes: string[]) => void;
  onModelsChange: (models: string[]) => void;
};

export const CameraFilter = ({
  makes,
  models,
  onMakesChange,
  onModelsChange,
}: CameraFilterProps) => {
  const styles = useStyles();

  return (
    <div className={styles.container}>
      <div className={styles.section}>
        <Label>Camera Make</Label>
        <PillFilter
          availableOptions={mockCameraMakes}
          selectedOptions={makes}
          onChange={onMakesChange}
          placeholder="Search makes..."
        />
      </div>

      <div className={styles.section}>
        <Label>Camera Model</Label>
        <PillFilter
          availableOptions={mockCameraModels}
          selectedOptions={models}
          onChange={onModelsChange}
          placeholder="Search models..."
        />
      </div>
    </div>
  );
};
