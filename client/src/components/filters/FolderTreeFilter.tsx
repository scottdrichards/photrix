import { useState, useEffect } from "react";
import {
  makeStyles,
  tokens,
  Checkbox,
  Input,
  Button,
} from "@fluentui/react-components";
import { 
  Folder24Regular, 
  FolderOpen24Regular, 
  Search24Regular,
  ChevronRight20Regular,
  ChevronDown20Regular
} from "@fluentui/react-icons";

const useStyles = makeStyles({
  container: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
  },
  searchRow: {
    display: "flex",
    gap: tokens.spacingHorizontalS,
    alignItems: "center",
  },
  treeContainer: {
    maxHeight: "400px",
    overflowY: "auto",
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingVerticalS,
  },
  folderItem: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    cursor: "pointer",
    borderRadius: tokens.borderRadiusSmall,
    ":hover": {
      backgroundColor: tokens.colorNeutralBackground1Hover,
    },
  },
  folderItemContent: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    flex: 1,
  },
  folderChildren: {
    paddingLeft: tokens.spacingHorizontalXL,
  },
  chevron: {
    width: "20px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  folderIcon: {
    color: tokens.colorBrandForeground1,
  },
});

type FolderNode = {
  name: string;
  path: string;
  children: FolderNode[];
};

export type FolderTreeFilterProps = {
  value: string[];
  onChange: (directories: string[]) => void;
};

// Mock function to simulate fetching folder structure from API
// In a real implementation, this would call an API endpoint
const mockFetchFolderTree = async (): Promise<FolderNode> => {
  // Simulate API delay
  await new Promise((resolve) => setTimeout(resolve, 100));
  
  // Return a mock folder structure
  // In a real implementation, this would come from the server
  return {
    name: "root",
    path: "",
    children: [
      {
        name: "2024",
        path: "2024",
        children: [
          { name: "January", path: "2024/January", children: [] },
          { name: "February", path: "2024/February", children: [] },
          { name: "March", path: "2024/March", children: [] },
        ],
      },
      {
        name: "2023",
        path: "2023",
        children: [
          { name: "Summer", path: "2023/Summer", children: [] },
          { name: "Winter", path: "2023/Winter", children: [] },
        ],
      },
      {
        name: "Vacation",
        path: "Vacation",
        children: [
          { name: "Hawaii", path: "Vacation/Hawaii", children: [] },
          { name: "Europe", path: "Vacation/Europe", children: [] },
        ],
      },
    ],
  };
};

export const FolderTreeFilter = ({ value, onChange }: FolderTreeFilterProps) => {
  const styles = useStyles();
  const [folderTree, setFolderTree] = useState<FolderNode | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());

  useEffect(() => {
    const loadFolders = async () => {
      const tree = await mockFetchFolderTree();
      setFolderTree(tree);
    };
    void loadFolders();
  }, []);

  const handleToggle = (path: string) => {
    const newSelected = new Set(value);
    if (newSelected.has(path)) {
      newSelected.delete(path);
    } else {
      newSelected.add(path);
    }
    onChange(Array.from(newSelected));
  };

  const handleExpandToggle = (path: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const newExpanded = new Set(expandedItems);
    if (newExpanded.has(path)) {
      newExpanded.delete(path);
    } else {
      newExpanded.add(path);
    }
    setExpandedItems(newExpanded);
  };

  const handleCheckboxToggle = (path: string, e: React.MouseEvent) => {
    e.stopPropagation();
    handleToggle(path);
  };

  const renderFolderNode = (node: FolderNode): JSX.Element | null => {
    if (!node.path && node.children.length === 0) {
      return null;
    }

    // Filter by search query
    const matchesSearch =
      !searchQuery ||
      node.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      node.path.toLowerCase().includes(searchQuery.toLowerCase());

    const hasMatchingChildren =
      !searchQuery ||
      node.children.some((child) =>
        child.name.toLowerCase().includes(searchQuery.toLowerCase())
      );

    if (!matchesSearch && !hasMatchingChildren && searchQuery) {
      return null;
    }

    const isExpanded = expandedItems.has(node.path);
    const isChecked = value.includes(node.path);
    const hasChildren = node.children.length > 0;

    // Don't render root node, just its children
    if (!node.path) {
      return (
        <>
          {node.children.map((child) => renderFolderNode(child))}
        </>
      );
    }

    return (
      <div key={node.path}>
        <div className={styles.folderItem}>
          <div className={styles.chevron}>
            {hasChildren && (
              <div onClick={(e) => handleExpandToggle(node.path, e)} style={{ cursor: "pointer" }}>
                {isExpanded ? <ChevronDown20Regular /> : <ChevronRight20Regular />}
              </div>
            )}
          </div>
          <div className={styles.folderItemContent}>
            {isExpanded ? (
              <FolderOpen24Regular className={styles.folderIcon} />
            ) : (
              <Folder24Regular className={styles.folderIcon} />
            )}
            <span>{node.name}</span>
          </div>
          <Checkbox
            checked={isChecked}
            onChange={(e) => handleCheckboxToggle(node.path, e as unknown as React.MouseEvent)}
          />
        </div>
        {hasChildren && isExpanded && (
          <div className={styles.folderChildren}>
            {node.children.map((child) => renderFolderNode(child))}
          </div>
        )}
      </div>
    );
  };

  const handleClearAll = () => {
    onChange([]);
  };

  if (!folderTree) {
    return <div>Loading folders...</div>;
  }

  return (
    <div className={styles.container}>
      <div className={styles.searchRow}>
        <Input
          value={searchQuery}
          onChange={(_, data) => setSearchQuery(data.value)}
          placeholder="Search folders..."
          contentBefore={<Search24Regular />}
          style={{ flex: 1 }}
        />
        {value.length > 0 && (
          <Button appearance="subtle" onClick={handleClearAll}>
            Clear ({value.length})
          </Button>
        )}
      </div>
      <div className={styles.treeContainer}>{renderFolderNode(folderTree)}</div>
    </div>
  );
};
