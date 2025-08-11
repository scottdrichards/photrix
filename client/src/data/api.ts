export type MediaDirectoryResult = Array<{
  path: string;
  type: "folder" | "file";
}>;


export const mediaURLBase = new URL("/media/", window.location.origin);

export const getFolderContents = async (
  folder: string,
): Promise<MediaDirectoryResult> => {
  const url = new URL(folder, mediaURLBase);
  url.searchParams.set("recursive", "false");
  return fetch(url).then((response) =>
    response.text().then((text) =>
      text
        .split("\n")
        .slice(0, -1)
        .map((v) => JSON.parse(v)),
    ),
  );
};

export const getSubfolders = async (
  folder: string,
): Promise<Array<string>> => {
  const url = new URL(folder, mediaURLBase);
  url.searchParams.set("type", "folders");
  const response = await fetch(url);
  const data = await response.json();
  return data.folders;
};
