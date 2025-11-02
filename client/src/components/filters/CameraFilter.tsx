import { useState } from "react";
import {
  Button,
  Input,
  Label,
  makeStyles,
  Tag,
  tokens,
} from "@fluentui/react-components";
import { Dismiss12Regular } from "@fluentui/react-icons";

const useStyles = makeStyles({
  container: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
  },
  section: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXS,
  },
  inputRow: {
    display: "flex",
    gap: tokens.spacingHorizontalS,
  },
  tagsContainer: {
    display: "flex",
    flexWrap: "wrap",
    gap: tokens.spacingHorizontalXS,
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
  const [makeInput, setMakeInput] = useState("");
  const [modelInput, setModelInput] = useState("");

  const handleAddMake = () => {
    const trimmed = makeInput.trim();
    if (!trimmed || makes.includes(trimmed)) {
      return;
    }
    onMakesChange([...makes, trimmed]);
    setMakeInput("");
  };

  const handleAddModel = () => {
    const trimmed = modelInput.trim();
    if (!trimmed || models.includes(trimmed)) {
      return;
    }
    onModelsChange([...models, trimmed]);
    setModelInput("");
  };

  const handleRemoveMake = (make: string) => {
    onMakesChange(makes.filter((m) => m !== make));
  };

  const handleRemoveModel = (model: string) => {
    onModelsChange(models.filter((m) => m !== model));
  };

  return (
    <div className={styles.container}>
      <div className={styles.section}>
        <Label>Camera Make</Label>
        <div className={styles.inputRow}>
          <Input
            value={makeInput}
            onChange={(_, data) => setMakeInput(data.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleAddMake();
              }
            }}
            placeholder="e.g., Canon, Nikon..."
            style={{ flex: 1 }}
          />
          <Button onClick={handleAddMake} appearance="primary" disabled={!makeInput.trim()}>
            Add
          </Button>
        </div>
        {makes.length > 0 && (
          <div className={styles.tagsContainer}>
            {makes.map((make) => (
              <Tag
                key={make}
                dismissible
                dismissIcon={<Dismiss12Regular />}
                value={make}
                onClick={() => handleRemoveMake(make)}
              >
                {make}
              </Tag>
            ))}
          </div>
        )}
      </div>

      <div className={styles.section}>
        <Label>Camera Model</Label>
        <div className={styles.inputRow}>
          <Input
            value={modelInput}
            onChange={(_, data) => setModelInput(data.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleAddModel();
              }
            }}
            placeholder="e.g., EOS R5, D850..."
            style={{ flex: 1 }}
          />
          <Button onClick={handleAddModel} appearance="primary" disabled={!modelInput.trim()}>
            Add
          </Button>
        </div>
        {models.length > 0 && (
          <div className={styles.tagsContainer}>
            {models.map((model) => (
              <Tag
                key={model}
                dismissible
                dismissIcon={<Dismiss12Regular />}
                value={model}
                onClick={() => handleRemoveModel(model)}
              >
                {model}
              </Tag>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
