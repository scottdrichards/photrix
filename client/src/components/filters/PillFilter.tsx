import { useState, useEffect } from "react";
import {
  makeStyles,
  Tag,
  tokens,
  Input,
  Spinner,
} from "@fluentui/react-components";
import { Dismiss12Regular, Search24Regular } from "@fluentui/react-icons";

const useStyles = makeStyles({
  container: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
  },
  searchInput: {
    marginBottom: tokens.spacingVerticalXS,
  },
  pillsContainer: {
    display: "flex",
    flexWrap: "wrap",
    gap: tokens.spacingHorizontalXS,
    maxHeight: "200px",
    overflowY: "auto",
  },
  pill: {
    cursor: "pointer",
  },
});

export type PillFilterProps = {
  availableOptions: string[];
  selectedOptions: string[];
  onChange: (selected: string[]) => void;
  placeholder?: string;
  loading?: boolean;
};

export const PillFilter = ({
  availableOptions,
  selectedOptions,
  onChange,
  placeholder = "Search...",
  loading = false,
}: PillFilterProps) => {
  const styles = useStyles();
  const [searchQuery, setSearchQuery] = useState("");

  const filteredOptions = availableOptions.filter((option) =>
    option.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleToggle = (option: string) => {
    if (selectedOptions.includes(option)) {
      onChange(selectedOptions.filter((o) => o !== option));
    } else {
      onChange([...selectedOptions, option]);
    }
  };

  if (loading) {
    return (
      <div className={styles.container}>
        <Spinner size="small" label="Loading options..." />
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <Input
        className={styles.searchInput}
        value={searchQuery}
        onChange={(_, data) => setSearchQuery(data.value)}
        placeholder={placeholder}
        contentBefore={<Search24Regular />}
      />
      <div className={styles.pillsContainer}>
        {filteredOptions.map((option) => {
          const isSelected = selectedOptions.includes(option);
          return (
            <Tag
              key={option}
              className={styles.pill}
              appearance={isSelected ? "filled" : "outline"}
              shape="circular"
              onClick={() => handleToggle(option)}
              dismissible={isSelected}
              dismissIcon={<Dismiss12Regular />}
            >
              {option}
            </Tag>
          );
        })}
      </div>
    </div>
  );
};
