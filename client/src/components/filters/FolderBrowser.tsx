import { useState } from "react";
import {
  Button,
  Input,
  makeStyles,
  Tag,
  tokens,
} from "@fluentui/react-components";
import { Dismiss12Regular, Folder24Regular } from "@fluentui/react-icons";

const useStyles = makeStyles({
  container: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
  },
  inputRow: {
    display: "flex",
    gap: tokens.spacingHorizontalS,
    alignItems: "center",
  },
  folderIcon: {
    color: tokens.colorBrandForeground1,
  },
  tagsContainer: {
    display: "flex",
    flexWrap: "wrap",
    gap: tokens.spacingHorizontalXS,
  },
});

export type FolderBrowserProps = {
  value: string[];
  onChange: (directories: string[]) => void;
};

export const FolderBrowser = ({ value, onChange }: FolderBrowserProps) => {
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

  const handleRemove = (directory: string) => {
    onChange(value.filter((d) => d !== directory));
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
        <Folder24Regular className={styles.folderIcon} />
        <Input
          value={inputValue}
          onChange={(_, data) => setInputValue(data.value)}
          onKeyDown={handleKeyDown}
          placeholder="Enter folder path or pattern..."
          style={{ flex: 1 }}
        />
        <Button onClick={handleAdd} appearance="primary" disabled={!inputValue.trim()}>
          Add
        </Button>
      </div>
      {value.length > 0 && (
        <div className={styles.tagsContainer}>
          {value.map((directory) => (
            <Tag
              key={directory}
              dismissible
              dismissIcon={<Dismiss12Regular />}
              value={directory}
              icon={<Folder24Regular />}
              onClick={() => handleRemove(directory)}
            >
              {directory}
            </Tag>
          ))}
        </div>
      )}
    </div>
  );
};
