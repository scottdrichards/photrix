import { useState, useEffect } from "react";
import {
  Tree,
  TreeItem,
  TreeItemLayout,
  makeStyles,
  tokens,
  Checkbox,
  Input,
  Button,
} from "@fluentui/react-components";
import { Folder24Regular, FolderOpen24Regular, Search24Regular } from "@fluentui/react-icons";

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
  treeItem: {
    paddingLeft: tokens.spacingHorizontalS,
  },
  selectedCount: {
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase200,
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

  const handleExpandToggle = (path: string) => {
    const newExpanded = new Set(expandedItems);
    if (newExpanded.has(path)) {
      newExpanded.delete(path);
    } else {
      newExpanded.add(path);
    }
    setExpandedItems(newExpanded);
  };

  const renderFolderNode = (node: FolderNode, depth = 0): JSX.Element | null => {
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

    // Don't render root node
    if (!node.path) {
      return (
        <>
          {node.children.map((child) => (
            <TreeItem key={child.path} itemType="branch" value={child.path}>
              {renderFolderNode(child, depth)}
            </TreeItem>
          ))}
        </>
      );
    }

    return (
      <TreeItemLayout
        iconBefore={
          isExpanded ? <FolderOpen24Regular /> : <Folder24Regular />
        }
        aside={
          <Checkbox
            checked={isChecked}
            onChange={() => handleToggle(node.path)}
          />
        }
        onClick={() => hasChildren && handleExpandToggle(node.path)}
      >
        {node.name}
        {hasChildren && isExpanded && (
          <Tree>
            {node.children.map((child) => (
              <TreeItem key={child.path} itemType={child.children.length > 0 ? "branch" : "leaf"} value={child.path}>
                {renderFolderNode(child, depth + 1)}
              </TreeItem>
            ))}
          </Tree>
        )}
      </TreeItemLayout>
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
      <div className={styles.treeContainer}>
        <Tree>{renderFolderNode(folderTree)}</Tree>
      </div>
    </div>
  );
};
