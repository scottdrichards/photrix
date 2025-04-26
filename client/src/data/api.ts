const port = 9615;
export type MediaDirectoryResult = Array<{
  path: string;
  type: "directory" | "file";
}>;
export const getFolderContents = async (
  folder: string,
): Promise<MediaDirectoryResult> => {
  return fetch(`http://localhost:${port}/media/${folder}`).then((response) =>
    response.json(),
  );
};
