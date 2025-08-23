import { useEffect, useState } from "react";
import { getSubfolders } from "./data/api";
import { useStyles } from "./FolderExplorer.styles";
import { useFilter } from "./contexts/filterContext";


type Node = {
  name: string;
  expanded: boolean;
  children?: Node[];
};

const nameToNode = (name:string): Node => ({
  name,
  expanded: false,
  children: undefined,
});

const pathArrayToString = (path: string[]) => "./" + path.map(p => p + "/").join("");

export const FolderExplorer: React.FC = () => {
  const {filter, setFilter} = useFilter();
  const [root, setRoot] = useState<Node[]>([]);
  const styles = useStyles();

  useEffect(() => {
    (async () => {
      const results = await getSubfolders("");
      setRoot(results.map(nameToNode));
    })();
  }, []);

  const setFolderExpand = async (path: string[], expanded: boolean) => {
    const toggle = async (
      node: Node,
      pathRemaining: string[],
      parentPath: string[],
    ): Promise<Node> => {
      if (
        !pathRemaining.length ||
        node.name !== pathRemaining[0]
      ) {
        return node;
      }

      const currentPath = [...parentPath, node.name];

      const isExpanded = () => {
        if (pathRemaining.length === 1) {
          // If this is the target folder, set it based on the expanded parameter
          return expanded;
        }
        if (expanded) {
          // If a child is expanded, set parent to expanded too
          return true;
        }
        // Keep parent state
        return node.expanded;
      };

      const localExpanded = isExpanded();

      const children = localExpanded
        ? (
            node.children ??
            (await getSubfolders(pathArrayToString(currentPath)).then((results) =>
              results.map(nameToNode),
            ))
          )?.map(
            async (child) =>
              await toggle(child, pathRemaining.slice(1), currentPath),
          )
        : node.children; // If this is not expanded, leave children as is

      // children.map returns promises, so we need to await them
      const childrenResoved = children && (await Promise.all(children));
      // If the children are different from the original, sort them
      const childrenSorted =
        node.children === childrenResoved
          ? node.children
          : childrenResoved?.sort((a, b) => a.name.localeCompare(b.name));
      return { ...node, children: childrenSorted, expanded: localExpanded };
    };
    const rootCopy = await Promise.all(
      root.map((folder) => toggle(folder, path, [])),
    );
    setRoot((prevRoot) => {
      if (prevRoot !== root) {
        console.error(
          "Toggle function is async and root has changed in the meantime. You may want to refactor the state vs data.",
        );
      }
      return rootCopy;
    });
  };

  const Render = (params: { element: Node; parentPath?: string[] }) => {
    const { element: el, parentPath } = params;
    const isRoot = !parentPath;
    const currentPath = isRoot ? [] : [...parentPath, el.name];
    const currentPathString = pathArrayToString(currentPath);
    return (
      <div
        key={currentPathString}
        className={styles.folder}
      >
        <div
          className={styles.folderHeader}
          data-selected={filter.parentFolder === currentPathString || undefined}
        >
          <span onClick={() => setFolderExpand(currentPath, !el.expanded)}>
            {el.expanded ? "📂" : "📁"}
          </span>
          <span
            onClick={() =>
              setFilter({...filter, parentFolder: currentPathString})
            }
          >
            {el.name}
          </span>
        </div>
        {el.expanded && el.children?.map((child) => (
            <Render
              key={child.name}
              element={child}
              parentPath={currentPath}
              />
            ))}
      </div>
    );
  };

  return (
          <div className={styles.folderSelectionPanel}>
            <label>
              <input
                type="checkbox"
                id="includeSubfolders"
                checked={!filter.excludeSubfolders}
                onChange={(e) => setFilter({...filter, excludeSubfolders: !e.target.checked})}
              />
              Include Subfolders
            </label>
            <Render
              element={{ name: "Photos Library", expanded: true, children: root }}
            />
          </div>
  );
};
