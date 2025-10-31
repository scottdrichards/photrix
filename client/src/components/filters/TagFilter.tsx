import { useState } from "react";
import {
  Button,
  Input,
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

export type TagFilterProps = {
  value: string[];
  onChange: (tags: string[]) => void;
};

export const TagFilter = ({ value, onChange }: TagFilterProps) => {
  const styles = useStyles();
  const [inputValue, setInputValue] = useState("");

  const handleAdd = () => {
    const trimmed = inputValue.trim();
    if (!trimmed || value.includes(trimmed)) {
      return;
    }
    onChange([...value, trimmed]);
    setInputValue("");
  };

  const handleRemove = (tagToRemove: string) => {
    onChange(value.filter((tag) => tag !== tagToRemove));
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleAdd();
    }
  };

  return (
    <div className={styles.container}>
      <div className={styles.inputRow}>
        <Input
          value={inputValue}
          onChange={(_, data) => setInputValue(data.value)}
          onKeyDown={handleKeyDown}
          placeholder="Enter tag..."
          style={{ flex: 1 }}
        />
        <Button onClick={handleAdd} appearance="primary" disabled={!inputValue.trim()}>
          Add
        </Button>
      </div>
      {value.length > 0 && (
        <div className={styles.tagsContainer}>
          {value.map((tag) => (
            <Tag
              key={tag}
              dismissible
              dismissIcon={<Dismiss12Regular />}
              value={tag}
              onClick={() => handleRemove(tag)}
            >
              {tag}
            </Tag>
          ))}
        </div>
      )}
    </div>
  );
};
